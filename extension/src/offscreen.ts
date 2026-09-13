import { createAdjustment, type Adjustment } from '#lib/engine/adjust'
import { createBorderDetector } from '#lib/engine/border'
import { DEFAULT_ENGINE_CONFIG, parseEngineConfig, resolveLayout, type EngineConfig } from '#lib/engine/config'
import { allocLinearGrid, createRgbaDecoder } from '#lib/engine/decode'
import { createColorOrder, type ColorOrderStage } from '#lib/engine/order'
import { HEADER_SIZE, encodeAfx, frameSize } from '#lib/engine/protocol'
import { createSampler, type Sampler } from '#lib/engine/sample'
import { createLoopbackSink, createSerialWriter, type LoopbackSink, type SerialWriter } from '#lib/engine/serial'
import { createSmoother, type Smoother } from '#lib/engine/smooth'
import { createArrivalMeter, createValueMeter } from '#lib/engine/stats'
import { NO_BORDER, allocLedColors, type Border, type LedColors } from '#lib/engine/types'
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
 *   fixed tick -> smoother.tick -> channel order -> encodeLinear16
 *   -> Afx frame -> latest-wins serial writer -> Web Serial port, or the
 *   loopback sink
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
 *
 * Everything the rig is - how many LEDs, where each looks, how the strip is
 * wired - lives in the `EngineConfig` the worker hands over, and the stages
 * that depend on it are rebuilt when it changes. The capture keeps running
 * across a rebuild: a layout edit should not cost the user their screen pick.
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

const decoder = createRgbaDecoder(GRID_W, GRID_H)
const grid = allocLinearGrid(GRID_W, GRID_H)
const detector = createBorderDetector({}, clock)

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
// The configured stages. Rebuilt together, because they all depend on the LED
// count and a half-rebuilt pipeline would write a frame of the wrong length.
// ---------------------------------------------------------------------------

interface Stages {
  config: EngineConfig
  leds: number
  sampler: Sampler
  adjustment: Adjustment
  order: ColorOrderStage
  smoother: Smoother
  target: LedColors
  /** One wire buffer; the payload is encoded into it in place. */
  wire: Uint8Array
  wirePayload: Uint8Array
}

function build (config: EngineConfig): Stages {
  const layout = resolveLayout(config)
  const leds = layout.length
  const wire = new Uint8Array(frameSize('Afx', leds))
  return {
    config,
    leds,
    sampler: createSampler({ layout, width: GRID_W, height: GRID_H }),
    adjustment: createAdjustment([{ leds: '*' }], leds),
    order: createColorOrder(leds, {
      order: config.colorOrder.order,
      ...(config.colorOrder.overrides === undefined ? {} : { overrides: config.colorOrder.overrides })
    }),
    smoother: createSmoother({ mode: 'asymmetric', count: leds, outputHz: OUTPUT_HZ }, clock),
    target: allocLedColors(leds),
    wire,
    wirePayload: wire.subarray(HEADER_SIZE, HEADER_SIZE + leds * 6)
  }
}

let stages = build(DEFAULT_ENGINE_CONFIG)

/**
 * Swaps in a new configuration. The border the detector found is kept - it is
 * a fact about the content, not about the strip - but the sampler is told
 * again, because its index map is built per border.
 */
function applyConfig (value: unknown): void {
  const config = parseEngineConfig(value)
  const next = build(config)
  next.sampler.setBorder(border)
  stages = next
}

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

/**
 * Opens the capture the picker chose.
 *
 * The streamId from chrome.desktopCapture is consumed through getUserMedia with
 * Chromium's legacy `mandatory` constraints; this is the documented offscreen
 * pattern and the only way a document with no user gesture can start a screen
 * capture.
 *
 * It is tried twice on purpose. `maxFrameRate` is a legacy constraint, and a
 * `mandatory` block is all-or-nothing: if Chrome does not honour one member it
 * rejects the whole request, and the error it gives is about the capture rather
 * than about the constraint. Dropping the rate and trying again separates the
 * two causes that otherwise look identical - a rejected constraint from a
 * streamId that has already expired - and the rate is a ceiling we can live
 * without (the pipeline is latest-wins, so an over-fast source costs drops,
 * not correctness).
 */
async function openCapture (streamId: string): Promise<MediaStream> {
  const base = { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId }
  const attempt = async (mandatory: Record<string, unknown>): Promise<MediaStream> =>
    navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory } } as unknown as MediaStreamConstraints)
  try {
    return await attempt({ ...base, maxFrameRate: OUTPUT_HZ })
  } catch (first) {
    try {
      return await attempt(base)
    } catch (second) {
      // Both messages, because which one appeared tells you which cause it was.
      throw new Error(`${describeCaptureError(second)} (kare hızı sınırıyla: ${describeCaptureError(first)})`)
    }
  }
}

function describeCaptureError (error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  // DOMException carries the useful half in `name`; `message` alone reads as
  // "Error starting tab capture" whatever actually went wrong.
  return error.name === '' || error.name === 'Error' ? error.message : `${error.name}: ${error.message}`
}

async function start (streamId: string): Promise<void> {
  if (state === 'running' || state === 'starting') stop()
  state = 'starting'
  lastError = undefined
  report()
  try {
    const stream = await openCapture(streamId)
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
  stages.smoother.reset()
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
    // Read `stages` once: a config swap between two of these lines would mix a
    // sampler with another layout's target buffer.
    const s = stages
    border = detector.process(grid, now)
    s.sampler.setBorder(border)
    s.sampler.sample(grid, s.target, 'mean')
    s.adjustment.apply(s.target)
    s.smoother.setTarget(s.target, now)
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
  const s = stages
  const now = clock()
  const out = s.smoother.tick(now)
  if (out === null) return
  outputs.mark(now)
  // The channel order is the last thing before the bytes: everything above it,
  // the corner calibration included, works in real colours.
  s.order.apply(out)
  encodeLinear16(out, s.wirePayload)
  encodeAfx(s.wirePayload, s.wire)
  writer.send(s.wire)
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
    const s = stages
    s.wirePayload.fill(0)
    encodeAfx(s.wirePayload, s.wire)
    writer.send(s.wire)
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
    leds: stages.leds,
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
    case 'ambiflux/config':
      try {
        applyConfig(message.config)
        sendResponse({ type: 'ambiflux/config-reply', config: stages.config } satisfies Message)
      } catch (error) {
        // The engine keeps the configuration it had: a bad edit must not stop
        // the strip mid-film.
        sendResponse({
          type: 'ambiflux/config-reply',
          config: stages.config,
          error: error instanceof Error ? error.message : String(error)
        } satisfies Message)
      }
      return false
    case 'ambiflux/config-get':
      sendResponse({ type: 'ambiflux/config-reply', config: stages.config } satisfies Message)
      return false
    case 'ambiflux/ping':
      sendResponse({ type: 'ambiflux/pong', version: 'offscreen', engine: state } satisfies Message)
      return false
    default:
      return false
  }
})

/**
 * The worker holds the stored configuration, so ask for it as soon as this
 * document exists rather than waiting for the first edit. Until it answers the
 * reference rig is in force, which is also what a fresh install has.
 */
void chrome.runtime.sendMessage({ type: 'ambiflux/config-get', target: 'sw' } satisfies Message)
  .then((reply: unknown) => {
    if (typeof reply === 'object' && reply !== null && (reply as { type?: string }).type === 'ambiflux/config-reply') {
      const config = (reply as { config: unknown }).config
      if (config !== null && config !== undefined) applyConfig(config)
    }
  })
  .catch(() => { /* no stored config yet; the default stands */ })
  .finally(() => { report() })
