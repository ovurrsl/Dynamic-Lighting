import { createAdjustment } from '#lib/engine/adjust'
import { createBorderDetector } from '#lib/engine/border'
import { allocLinearGrid, createRgbaDecoder } from '#lib/engine/decode'
import { REFERENCE_LAYOUT, classicLayout, ledCount } from '#lib/engine/layout'
import { HEADER_SIZE, encodeAfx, frameSize } from '#lib/engine/protocol'
import { createSampler } from '#lib/engine/sample'
import { createLoopbackSink, createSerialWriter, type LoopbackSink, type SerialWriter } from '#lib/engine/serial'
import { createSmoother } from '#lib/engine/smooth'
import { createArrivalMeter, createValueMeter } from '#lib/engine/stats'
import { NO_BORDER, allocLedColors, type Border } from '#lib/engine/types'
import { isMessage, type EngineState, type EngineStats, type LinkMode, type Message } from '#lib/extension/messages'
import { encodeLinear16 } from '#lib/light'

/**
 * The engine host: the whole pipeline, in the one document Chrome never
 * renders.
 *
 *   MediaStreamTrackProcessor -> createImageBitmap (128x72, area average)
 *   -> 2D canvas -> getImageData -> sRGB decode (lib/engine/decode)
 *   -> black-border detector -> sampler -> adjustment -> smoother target
 *
 *   fixed tick -> smoother.tick -> encodeLinear16 -> Afx frame
 *   -> latest-wins serial writer -> Web Serial port, or the loopback sink
 *
 * Two rules from docs/hyperion-port-plan.md hold everywhere in this file:
 *
 * - No requestAnimationFrame. This document is never painted, so rAF would
 *   never fire. Frames drive the capture side; a timer drives the output side.
 * - Nothing queues. A frame that arrives while the previous one is still
 *   being processed is dropped and counted (pipelineDrops); a frame that is
 *   ready while a serial write is in flight is dropped and counted
 *   (link.dropped). Every drop is visible in the panel.
 *
 * The downscale is `createImageBitmap(frame, { resizeQuality: 'high' })`,
 * measured to be a correct area average (plan section 2b), so there is no
 * WebGL here. One unknown remains, and it is measured by the panel's counters
 * rather than assumed: whether this document's timers and frame delivery are
 * throttled the way a hidden tab's are.
 */

const GRID_W = 128
const GRID_H = 72
const OUTPUT_HZ = 120
/** Output timer period. Chrome clamps nested timers to 4 ms; the smoother's cadence does the real pacing. */
const TICK_MS = 4
const REPORT_MS = 1000
/** Never 1200: the Arduino-class "1200 baud touch" resets some boards into the bootloader. */
const BAUD_RATE = 921600
const RECONNECT_MS = 3000

const clock = (): number => performance.now()

const LEDS = ledCount(REFERENCE_LAYOUT)
const layout = classicLayout(REFERENCE_LAYOUT)

const decoder = createRgbaDecoder(GRID_W, GRID_H)
const grid = allocLinearGrid(GRID_W, GRID_H)
const detector = createBorderDetector({}, clock)
const sampler = createSampler({ layout, width: GRID_W, height: GRID_H })
const adjustment = createAdjustment([{ leds: '*' }], LEDS)
const smoother = createSmoother({ mode: 'asymmetric', count: LEDS, outputHz: OUTPUT_HZ }, clock)
const target = allocLedColors(LEDS)

/** One wire buffer; the payload is encoded straight into it and encodeAfx leaves it in place. */
const wire = new Uint8Array(frameSize('Afx', LEDS))
const wirePayload = wire.subarray(HEADER_SIZE, HEADER_SIZE + LEDS * 6)

const canvas = new OffscreenCanvas(GRID_W, GRID_H)
const ctx = requireContext(canvas)

function requireContext (c: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = c.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new Error('offscreen: no 2D context')
  return context
}

// Counters, kept apart because the stages fail apart (lib/extension/messages.ts).
const arrivals = createArrivalMeter({ windowMs: 2000, gapMs: 50 })
const outputs = createArrivalMeter({ windowMs: 2000, gapMs: 50 })
const processTimes = createValueMeter(512)
let captured = 0
let pipelineDrops = 0
let border: Readonly<Border> = NO_BORDER

let state: EngineState = 'idle'
let lastError: string | undefined
let track: MediaStreamTrack | null = null
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null
let processing: Promise<void> | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let reportTimer: ReturnType<typeof setInterval> | null = null

// ---------------------------------------------------------------------------
// The link: a paired Web Serial port when there is one, the loopback otherwise.
// ---------------------------------------------------------------------------

let linkMode: LinkMode = 'none'
let loopback: LoopbackSink = createLoopbackSink()
let writer: SerialWriter = createSerialWriter(loopback)
let port: SerialPort | null = null
let portWriter: WritableStreamDefaultWriter<Uint8Array> | null = null
let portLabel: string | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function useLoopback (): void {
  loopback = createLoopbackSink()
  writer = createSerialWriter(loopback)
  linkMode = 'loopback'
  portLabel = undefined
}

async function closePort (): Promise<void> {
  const w = portWriter
  const p = port
  portWriter = null
  port = null
  try { await w?.close() } catch { /* already broken */ }
  try { w?.releaseLock() } catch { /* not locked */ }
  try { await p?.close() } catch { /* already closed */ }
}

/**
 * Opens the first port the user paired from the popup. The permission belongs
 * to the extension origin, so getPorts() here sees what requestPort() granted
 * there. No port means loopback: the pipeline runs and is measured either way.
 */
async function connectSerial (): Promise<void> {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (port !== null) return
  const ports = await navigator.serial.getPorts()
  const next = ports[0]
  if (next === undefined) {
    if (linkMode !== 'loopback') useLoopback()
    return
  }
  try {
    await next.open({ baudRate: BAUD_RATE })
    const w = next.writable?.getWriter()
    if (w === undefined) throw new Error('port has no writable stream')
    port = next
    portWriter = w
    const info = next.getInfo()
    portLabel = `${(info.usbVendorId ?? 0).toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).padStart(4, '0')}`
    linkMode = 'port'
    writer = createSerialWriter({ write: (bytes) => w.write(bytes) }, { onError: (error) => { void dropPort(error) } })
    next.addEventListener('disconnect', () => { void dropPort(new Error('port disconnected')) }, { once: true })
  } catch (error) {
    lastError = `seri port: ${error instanceof Error ? error.message : String(error)}`
    if (linkMode !== 'loopback') useLoopback()
    scheduleReconnect()
  }
}

async function dropPort (error: unknown): Promise<void> {
  lastError = `seri port: ${error instanceof Error ? error.message : String(error)}`
  await closePort()
  useLoopback()
  scheduleReconnect()
}

function scheduleReconnect (): void {
  if (reconnectTimer !== null || state !== 'running') return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connectSerial()
  }, RECONNECT_MS)
}

// ---------------------------------------------------------------------------
// Capture side.
// ---------------------------------------------------------------------------

async function start (streamId: string): Promise<void> {
  if (state === 'running' || state === 'starting') stop()
  state = 'starting'
  lastError = undefined
  report()
  try {
    // The streamId from chrome.desktopCapture is consumed through getUserMedia
    // with the Chromium-specific `mandatory` constraints; this is the
    // documented offscreen pattern and the only way a document without a user
    // gesture can begin a screen capture.
    const constraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: streamId,
          maxFrameRate: OUTPUT_HZ
        }
      }
    } as unknown as MediaStreamConstraints
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    const video = stream.getVideoTracks()[0]
    if (video === undefined) throw new Error('no video track')
    track = video
    video.addEventListener('ended', () => { stop() }, { once: true })

    resetCounters()
    state = 'running'
    tickTimer = setInterval(tick, TICK_MS)
    reportTimer = setInterval(report, REPORT_MS)
    void connectSerial()
    void pump(video)
    report()
  } catch (error) {
    state = 'error'
    lastError = error instanceof Error ? error.message : String(error)
    report()
  }
}

function resetCounters (): void {
  arrivals.reset()
  outputs.reset()
  processTimes.reset()
  captured = 0
  pipelineDrops = 0
  border = NO_BORDER
  detector.reset()
  smoother.reset()
}

async function pump (video: MediaStreamTrack): Promise<void> {
  // maxBufferSize 1: the stream itself holds at most one frame for us; older
  // ones are dropped by the source. Anything it does hand over that finds the
  // pipeline busy is dropped here and counted.
  const processor = new MediaStreamTrackProcessor({ track: video, maxBufferSize: 1 })
  const r = processor.readable.getReader()
  reader = r
  try {
    for (;;) {
      const { value: frame, done } = await r.read()
      if (done || frame === undefined) break
      const now = clock()
      arrivals.mark(now)
      captured++
      if (processing !== null) {
        pipelineDrops++
        frame.close()
        continue
      }
      processing = processFrame(frame, now)
        .catch((error: unknown) => { lastError = error instanceof Error ? error.message : String(error) })
        .finally(() => { processing = null })
    }
  } catch (error) {
    if (state === 'running') {
      state = 'error'
      lastError = error instanceof Error ? error.message : String(error)
      report()
    }
  } finally {
    if (reader === r) reader = null
    try { r.releaseLock() } catch { /* cancelled */ }
  }
}

async function processFrame (frame: VideoFrame, arrivedAt: number): Promise<void> {
  let bitmap: ImageBitmap | null = null
  try {
    // The one downscale: an area average straight from the VideoFrame.
    bitmap = await createImageBitmap(frame, { resizeWidth: GRID_W, resizeHeight: GRID_H, resizeQuality: 'high' })
    frame.close()
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    bitmap = null
    const image = ctx.getImageData(0, 0, GRID_W, GRID_H)
    decoder.decode(image.data, grid)

    const now = clock()
    border = detector.process(grid, now)
    sampler.setBorder(border)
    sampler.sample(grid, target, 'mean')
    adjustment.apply(target)
    smoother.setTarget(target, now)
    processTimes.add(clock() - arrivedAt)
    // A frame is the most precise clock edge we get; take an output slot if
    // one is open rather than wait for the 4 ms timer.
    tick()
  } finally {
    bitmap?.close()
    frame.close()
  }
}

// ---------------------------------------------------------------------------
// Output side.
// ---------------------------------------------------------------------------

function tick (): void {
  if (state !== 'running') return
  const now = clock()
  const out = smoother.tick(now)
  if (out === null) return
  outputs.mark(now)
  encodeLinear16(out, wirePayload)
  encodeAfx(wirePayload, wire)
  writer.send(wire)
}

function stop (): void {
  if (tickTimer !== null) clearInterval(tickTimer)
  if (reportTimer !== null) clearInterval(reportTimer)
  if (reconnectTimer !== null) clearTimeout(reconnectTimer)
  tickTimer = null
  reportTimer = null
  reconnectTimer = null
  const r = reader
  reader = null
  void r?.cancel().catch(() => { /* already closed */ })
  track?.stop()
  track = null
  if (state !== 'error') state = 'idle'
  // One black frame so the strip does not hold the last picture; the port
  // stays open for the next session.
  if (linkMode === 'port') {
    wirePayload.fill(0)
    encodeAfx(wirePayload, wire)
    writer.send(wire)
  }
  report()
}

function report (): void {
  const a = arrivals.snapshot(clock())
  const o = outputs.snapshot(clock())
  const p = processTimes.snapshot()
  const w = writer.stats()
  const l = loopback.stats()
  const settings = track?.getSettings()
  const stats: EngineStats = {
    state,
    capturedFrames: captured,
    deliveredFps: a.fps,
    interArrivalMs: { p50: a.p50, p99: a.p99, max: a.max },
    captureGaps: a.gaps,
    pipelineDrops,
    processMs: { p50: p.p50, p99: p.p99, max: p.max },
    outputFps: o.fps,
    link: {
      mode: linkMode,
      written: w.written,
      dropped: w.dropped,
      errors: w.errors,
      accepted: l.accepted,
      rejected: l.rejected,
      ...(portLabel !== undefined ? { port: portLabel } : {})
    },
    border: { unknown: border.unknown, topBottom: border.topBottom, leftRight: border.leftRight },
    ...(settings !== undefined && settings.width !== undefined && settings.height !== undefined
      ? { source: { width: settings.width, height: settings.height, ...(settings.frameRate !== undefined ? { frameRate: settings.frameRate } : {}) } }
      : {}),
    ...(lastError !== undefined ? { error: lastError } : {})
  }
  void chrome.runtime.sendMessage({ type: 'ambiflux/stats', target: 'sw', stats } satisfies Message).catch(() => { /* worker asleep */ })
  void chrome.runtime.sendMessage({ type: 'ambiflux/state', target: 'sw', state } satisfies Message).catch(() => { /* worker asleep */ })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isMessage(message) || !('target' in message) || message.target !== 'offscreen') return false
  switch (message.type) {
    case 'ambiflux/start':
      start(message.streamId).then(() => sendResponse({ state, error: lastError }))
      return true
    case 'ambiflux/stop':
      stop()
      sendResponse({ state })
      return false
    case 'ambiflux/serial':
      closePort()
        .then(connectSerial)
        .then(() => sendResponse({ link: linkMode, port: portLabel, error: lastError }))
      return true
    case 'ambiflux/ping':
      sendResponse({ type: 'ambiflux/pong', version: 'offscreen', engine: state } satisfies Message)
      return false
    default:
      return false
  }
})

report()
