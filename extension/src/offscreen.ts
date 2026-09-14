import { createAdjustment, type Adjustment } from '#lib/engine/adjust'
import { createBorderDetector } from '#lib/engine/border'
import { DEFAULT_ENGINE_CONFIG, parseEngineConfig, resolveLayout, type EngineConfig } from '#lib/engine/config'
import { allocLinearGrid, createRgbaDecoder } from '#lib/engine/decode'
import { createColorOrder, type ColorOrderStage } from '#lib/engine/order'
import { createPattern, parsePatternSpec, type Pattern } from '#lib/engine/patterns'
import { createSampler, type Sampler } from '#lib/engine/sample'
import { createFrameEncoder, type FrameEncoder } from '#lib/engine/encode'
import { createSocketSink, createWledSink } from '#lib/engine/net'
import {
  createBytesSink,
  createFrameWriter,
  createLoopbackSink,
  type FrameSink,
  type FrameWriter,
  type LoopbackSink
} from '#lib/engine/sink'
import { wledUrl } from '#lib/engine/wled'
import { createSmoother, type Smoother } from '#lib/engine/smooth'
import { createArrivalMeter, createValueMeter } from '#lib/engine/stats'
import { NO_BORDER, allocLedColors, type Border, type LedColors } from '#lib/engine/types'
import { isMessage, type EngineState, type EngineStats, type LinkMode, type Message } from '#lib/extension/messages'

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

/**
 * The analysis grid and the capture rate used to be constants here. They are
 * configuration now, because Hyperion makes every one of them a setting and is
 * right to: the grid size is the first knob to reach for against the measured
 * downscale cost, and the crop is what saves anyone whose screen includes a
 * taskbar or a second monitor.
 *
 * The output rate stays a constant. It is a property of the strip and the
 * firmware's interpolation, not of what the user is capturing.
 */
const OUTPUT_HZ = 120
/** Output timer period. Chrome clamps nested timers to 4 ms; the smoother's cadence does the real pacing. */
const TICK_MS = 4
const REPORT_MS = 1000
/** Never 1200: the Arduino-class "1200 baud touch" resets some boards into the bootloader. */
const BAUD_RATE = 921600
const RECONNECT_MS = 3000

const clock = (): number => performance.now()

const detector = createBorderDetector({}, clock)

function requireContext (c: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = c.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new Error('offscreen: no 2D context')
  return context
}

// Counters, kept apart because the stages fail apart (lib/extension/messages.ts).
const arrivals = createArrivalMeter({ windowMs: 2000, gapMs: 50 })
const outputs = createArrivalMeter({ windowMs: 2000, gapMs: 50 })
const processTimes = createValueMeter(512)
/**
 * The same frame, timed in four pieces.
 *
 * `processTimes` says the budget is blown at 1080p (p50 9.00 ms against
 * 8.33 ms) and says nothing about where, which makes it useless for fixing.
 * The plan's instruction is "measure where it goes, do not guess" - the guess
 * is the downscale, but the readback off the GPU and the decode over 9216
 * pixels are candidates too, and only one of the three is worth optimising.
 */
const downscaleTimes = createValueMeter(512)
const readbackTimes = createValueMeter(512)
const decodeTimes = createValueMeter(512)
const sampleTimes = createValueMeter(512)
let captured = 0
let pipelineDrops = 0
let border: Readonly<Border> = NO_BORDER
/**
 * Set when the capture ended without anyone asking. Cleared on the next start,
 * never by reading it: the panel polls once a second and a flag cleared by a
 * reader would be seen by whichever poller got there first and by nobody else.
 */
let captureLost = false

let state: EngineState = 'idle'
let lastError: string | undefined
let track: MediaStreamTrack | null = null
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null
let processing: Promise<void> | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let reportTimer: ReturnType<typeof setInterval> | null = null
/** Paints the self-test picture; null unless the synthetic source is running. */
let testTimer: ReturnType<typeof setInterval> | null = null
/** The test pattern, and its own timer; null unless one is running. */
let pattern: Pattern | null = null
let patternTimer: ReturnType<typeof setInterval> | null = null

// ---------------------------------------------------------------------------
// The configured stages. Rebuilt together, because they all depend on the LED
// count and a half-rebuilt pipeline would write a frame of the wrong length.
// ---------------------------------------------------------------------------

interface Stages {
  config: EngineConfig
  leds: number
  /** The analysis grid, and everything sized to it. */
  gridWidth: number
  gridHeight: number
  decoder: ReturnType<typeof createRgbaDecoder>
  grid: ReturnType<typeof allocLinearGrid>
  canvas: OffscreenCanvas
  ctx: OffscreenCanvasRenderingContext2D
  sampler: Sampler
  adjustment: Adjustment
  order: ColorOrderStage
  smoother: Smoother
  target: LedColors
  /** Colours to bytes, in the configured format; owned by lib/engine/encode. */
  encoder: FrameEncoder
}

function build (config: EngineConfig): Stages {
  const layout = resolveLayout(config)
  const leds = layout.length
  const { gridWidth, gridHeight } = config.capture
  const canvas = new OffscreenCanvas(gridWidth, gridHeight)
  return {
    config,
    leds,
    gridWidth,
    gridHeight,
    decoder: createRgbaDecoder(gridWidth, gridHeight),
    grid: allocLinearGrid(gridWidth, gridHeight),
    canvas,
    ctx: requireContext(canvas),
    sampler: createSampler({ layout, width: gridWidth, height: gridHeight }),
    adjustment: createAdjustment([{ leds: '*' }], leds),
    order: createColorOrder(leds, {
      order: config.colorOrder.order,
      ...(config.colorOrder.overrides === undefined ? {} : { overrides: config.colorOrder.overrides })
    }),
    smoother: createSmoother({ mode: 'asymmetric', count: leds, outputHz: OUTPUT_HZ }, clock),
    target: allocLedColors(leds),
    encoder: createFrameEncoder(
      // WLED never sees one of our wire formats; it gets JSON from its own sink.
      // The encoder still exists so the loopback has something to parse.
      config.output.transport === 'wled' ? 'Afx' : config.output.format,
      leds,
      config.output.format === 'Awa' ? config.output.calibration : undefined
    )
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
  const outputChanged = JSON.stringify(stages.config.output) !== JSON.stringify(config.output)
  const ledsChanged = stages.leds !== next.leds
  stages = next
  // The sink holds the encoder it was built with, so an output change - or a
  // layout change, which changes the LED count and therefore the frame - would
  // otherwise be accepted by the panel and silently not reach the device.
  if (outputChanged || ledsChanged) relink()
}

/**
 * Rebuilds the output for the configuration now in `stages`.
 *
 * An open serial port whose transport has not changed is kept and only the sink
 * around it is rebuilt: closing and reopening a working port costs a visible
 * gap on the strip, and nothing about the port itself depends on the encoder.
 */
function relink (): void {
  const writerHandle = portWriter
  if (stages.config.output.transport === 'serial' && writerHandle !== null) {
    useSink(
      createBytesSink({
        kind: 'serial',
        label: portLabel ?? 'serial',
        encoder: stages.encoder,
        transport: { write: (bytes: Uint8Array) => writerHandle.write(bytes) }
      }),
      'port',
      portLabel
    )
    return
  }
  // The loopback's encoder is part of the configuration too - it is what proves
  // the framing - so it is rebuilt rather than left parsing the old format.
  loopback = createLoopbackSink({ encoder: stages.encoder })
  void closePort().then(() => connectLink()).catch(() => { useLoopback() })
}

// ---------------------------------------------------------------------------
// The link: whichever sink the configuration asks for, the loopback otherwise.
// ---------------------------------------------------------------------------

/**
 * The output used to be "a Web Serial port, or the loopback". It is now
 * whichever `FrameSink` the configuration names, and the engine no longer knows
 * what a serial port is: it hands colours to a writer and the sink decides what
 * a device receives.
 *
 * The loopback is never merely a placeholder. It runs the real encoder through
 * the real parser, so "no device" still measures the pipeline - which is how
 * every number in the panel was obtained before any hardware existed.
 */
let linkMode: LinkMode = 'none'
let loopback: LoopbackSink = createLoopbackSink({ encoder: stagesEncoder() })
let sink: FrameSink = loopback
let writer: FrameWriter = createFrameWriter(loopback)
let port: SerialPort | null = null
let portWriter: WritableStreamDefaultWriter<Uint8Array> | null = null
let portLabel: string | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

/** The encoder the current configuration implies; read lazily to avoid an init cycle. */
function stagesEncoder (): FrameEncoder {
  return stages.encoder
}

function useLoopback (): void {
  loopback = createLoopbackSink({ encoder: stages.encoder })
  sink = loopback
  writer = createFrameWriter(loopback)
  linkMode = 'loopback'
  portLabel = undefined
}

/** Replaces the sink, closing whatever was there. Never leaves the engine without one. */
function useSink (next: FrameSink, mode: LinkMode, label?: string): void {
  const previous = sink
  sink = next
  linkMode = mode
  portLabel = label
  writer = createFrameWriter(next, { onError: (error) => { void onLinkError(error) } })
  if (previous !== next && previous !== loopback) void previous.close().catch(() => { /* already gone */ })
}

async function onLinkError (error: unknown): Promise<void> {
  lastError = `${linkMode}: ${error instanceof Error ? error.message : String(error)}`
  // A serial port that errors is gone and has to be reopened. The network sinks
  // reconnect on their own, so an error there is reported and nothing else.
  if (linkMode === 'port') await dropPort(error)
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
 * Builds the sink the configuration asks for.
 *
 * Serial first, because it is what most rigs are and it needs no network, no
 * address and no second device. The two network transports exist because on iOS
 * there is no Web Serial, no WebUSB, no WebHID and no Web Bluetooth, so a
 * captured frame there has nowhere else to go.
 */
async function connectLink (): Promise<void> {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const output = stages.config.output
  if (output.transport !== 'serial') {
    await closePort()
    const host = output.host
    if (host === undefined || host.trim() === '') {
      lastError = 'ağ çıkışı için adres girilmedi'
      useLoopback()
      return
    }
    try {
      useSink(
        output.transport === 'wled'
          ? createWledSink({ url: wledUrl(host), leds: stages.leds, segment: output.segment ?? 0 })
          : createSocketSink({ url: socketUrl(host), encoder: stages.encoder }),
        output.transport,
        host
      )
    } catch (error) {
      lastError = `${output.transport}: ${error instanceof Error ? error.message : String(error)}`
      useLoopback()
    }
    return
  }
  await connectSerial()
}

/** Our own firmware's endpoint, from whatever address the user typed. */
function socketUrl (host: string): string {
  const trimmed = host.trim()
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) return trimmed
  const bare = trimmed.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return `${trimmed.startsWith('https://') ? 'wss' : 'ws'}://${bare}`
}

/**
 * Opens the first port the user paired from the popup. The permission belongs
 * to the extension origin, so getPorts() here sees what requestPort() granted
 * there. No port means loopback: the pipeline runs and is measured either way.
 */
async function connectSerial (): Promise<void> {
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
    const label = `${(info.usbVendorId ?? 0).toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).padStart(4, '0')}`
    useSink(
      createBytesSink({
        kind: 'serial',
        label,
        encoder: stages.encoder,
        transport: { write: (bytes: Uint8Array) => w.write(bytes) }
      }),
      'port',
      label
    )
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
    void connectLink()
  }, RECONNECT_MS)
}

// ---------------------------------------------------------------------------
// Capture side.
// ---------------------------------------------------------------------------

/**
 * Starts a screen capture.
 *
 * `getDisplayMedia`, called HERE, is the whole design - and it replaces a
 * `chrome.desktopCapture` streamId chosen in the popup, which does not work and
 * cannot be made to. Measured on Chromium, deterministically:
 *
 * - The offscreen document's `chrome.*` surface is `runtime` and nothing else.
 *   `chrome.desktopCapture` is not defined here, so this document cannot open
 *   that picker at all.
 * - A streamId picked in the popup opens fine IN the popup and fails here with
 *   `AbortError: Invalid state` - some builds word it "Error starting tab
 *   capture", which names an API that is not involved. The id is bound to the
 *   context that asked for it, and a `MediaStreamTrack` cannot be handed over
 *   either: `chrome.runtime` messaging carries no transferables.
 * - `getDisplayMedia` here returns a real stream, and with no user gesture: the
 *   picker simply opens and waits. That is what the offscreen document's
 *   `DISPLAY_MEDIA` reason exists for.
 *
 * So the popup does not choose anything; it asks, and this document opens the
 * picker itself. `chrome.desktopCapture` is gone from the manifest with it.
 */
async function openCapture (): Promise<MediaStream> {
  return await navigator.mediaDevices.getDisplayMedia({
    audio: false,
    // A ceiling, not a demand: the pipeline is latest-wins, so a source faster
    // than the engine costs drops rather than correctness. Configurable because
    // halving it is the cheapest way to halve the engine's cost, and content is
    // overwhelmingly 24, 30 or 60 fps anyway.
    video: { frameRate: { max: stages.config.capture.fps } }
  })
}

function describeCaptureError (error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  // DOMException carries the useful half in `name`; the message alone reads the
  // same whatever actually went wrong.
  return error.name === '' || error.name === 'Error' ? error.message : `${error.name}: ${error.message}`
}

async function startPicked (): Promise<void> {
  await begin(async () => {
    let stream: MediaStream
    try {
      stream = await openCapture()
    } catch (error) {
      // Cancelling the picker is a decision, not a failure.
      const name = error instanceof Error ? error.name : ''
      throw new Error(name === 'NotAllowedError' ? 'Ekran seçilmedi.' : describeCaptureError(error))
    }
    const video = stream.getVideoTracks()[0]
    if (video === undefined) throw new Error('yakalama video izi vermedi')
    return video
  })
}

/**
 * Runs the whole engine on a generated picture instead of the screen.
 *
 * This is the bench run from the plan's stage 0, and it earns its place three
 * times over: it proves the pipeline end to end with no screen, no picker and
 * no board; it is the only way to tell "the engine is broken" apart from "the
 * capture never started", which are the same symptom from outside; and it is
 * what a customer can run when their strip stays dark.
 *
 * The source is a canvas captured at the output rate. Drawing happens on a
 * plain interval, never requestAnimationFrame - in a document that is never
 * rendered rAF does not fire, which is the same reason the engine is here.
 */
async function startSelfTest (): Promise<void> {
  await begin(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 360
    const paint = canvas.getContext('2d')
    if (paint === null) throw new Error('2d context yok')
    let frame = 0
    testTimer = setInterval(() => {
      // A hue that travels around the border, so every LED lights in turn and
      // the wire order is visible on the strip as a moving comet.
      const t = frame++ / 120
      const grad = paint.createLinearGradient(0, 0, canvas.width, canvas.height)
      grad.addColorStop(0, `hsl(${(t * 120) % 360} 90% 50%)`)
      grad.addColorStop(1, `hsl(${(t * 120 + 180) % 360} 90% 50%)`)
      paint.fillStyle = grad
      paint.fillRect(0, 0, canvas.width, canvas.height)
      // A black centre: the border detector must NOT read this as letterboxing,
      // because the bars it looks for are at the edges.
      paint.fillStyle = '#000'
      paint.fillRect(canvas.width * 0.2, canvas.height * 0.2, canvas.width * 0.6, canvas.height * 0.6)
    }, Math.round(1000 / 60))
    const video = canvas.captureStream(OUTPUT_HZ).getVideoTracks()[0]
    if (video === undefined) throw new Error('captureStream video vermedi')
    return video
  })
}

/**
 * Drives the strip from a generated pattern instead of the screen.
 *
 * Deliberately NOT `begin()`: there is no capture, no pump, no smoother and no
 * channel-order stage. Each of those omissions is the point.
 *
 * - No smoother, because a single LED walking the strip through a 90 ms release
 *   is a smear across four LEDs, and the walk exists precisely to make "which
 *   LED is index 7" unambiguous.
 * - No sampler and no border detector, because a pattern that went through them
 *   would be testing them; when the strip shows the wrong thing here, the fault
 *   is below the pattern - wiring, channel order, LED count, firmware.
 * - **No channel-order stage**, and this one is load-bearing rather than tidy:
 *   the wizard lights pure red and asks the user what colour they saw, and
 *   `deriveColorOrder` reads that answer assuming the wire carried pure red. Put
 *   the configured permutation in the way and a GRB strip under a GRB setting
 *   shows red, the user says "red", and the wizard derives RGB - confidently
 *   wrong, which is worse than no wizard.
 */
function startPattern (spec: unknown): void {
  const parsed = parsePatternSpec(spec)
  if (state === 'running' || state === 'starting') stop('restart')
  lastError = undefined
  captureLost = false
  const s = stages
  pattern = createPattern(parsed, s.leds, clock)
  state = 'running'
  void connectLink()
  patternTimer = setInterval(emitPattern, Math.round(1000 / OUTPUT_HZ))
  reportTimer = setInterval(report, REPORT_MS)
  emitPattern()
  report()
}

function emitPattern (): void {
  const p = pattern
  if (p === null || state !== 'running') return
  const s = stages
  const now = clock()
  p.render(s.target, now)
  outputs.mark(now)
  writer.send(s.target)
}

/** Everything both sources share: start the clocks, the link and the pump. */
async function begin (open: () => Promise<MediaStreamTrack>): Promise<void> {
  if (state === 'running' || state === 'starting') stop('restart')
  state = 'starting'
  lastError = undefined
  captureLost = false
  report()
  try {
    const video = await open()
    track = video
    // `ended` fires for Chrome's own "stop sharing" bar AND for the stream
    // dying under us; from here they are the same event, so both are reported
    // as lost. Calling stop() from the panel or the popup never reaches this,
    // because that path stops the track itself.
    video.addEventListener('ended', () => { stop('lost') }, { once: true })

    resetCounters()
    state = 'running'
    tickTimer = setInterval(tick, TICK_MS)
    reportTimer = setInterval(report, REPORT_MS)
    void connectLink()
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
  downscaleTimes.reset()
  readbackTimes.reset()
  decodeTimes.reset()
  sampleTimes.reset()
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
  // Read `stages` ONCE for the whole frame. A config swap between two of these
  // lines would mix a grid of one size with a decoder built for another, which
  // is now a real hazard rather than a theoretical one: the grid is
  // configuration and can change under a frame in flight.
  const s = stages
  try {
    // The one downscale: an area average straight from the VideoFrame, and the
    // crop happens HERE, as the source rectangle. Cropping later would mean
    // downscaling pixels that are about to be thrown away, and cropping the
    // grid would quantise the crop to whole grid cells.
    const t0 = clock()
    const crop = s.config.capture.crop
    const sx = Math.round(frame.displayWidth * crop.left)
    const sy = Math.round(frame.displayHeight * crop.top)
    const sw = Math.max(1, Math.round(frame.displayWidth * (1 - crop.left - crop.right)))
    const sh = Math.max(1, Math.round(frame.displayHeight * (1 - crop.top - crop.bottom)))
    const options = { resizeWidth: s.gridWidth, resizeHeight: s.gridHeight, resizeQuality: 'high' } as const
    bitmap = sx === 0 && sy === 0 && sw === frame.displayWidth && sh === frame.displayHeight
      ? await createImageBitmap(frame, options)
      : await createImageBitmap(frame, sx, sy, sw, sh, options)
    frame.close()
    const t1 = clock()
    s.ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    bitmap = null
    // getImageData is where the GPU work is actually waited on: the drawImage
    // above only queues, so timing them apart would credit the wrong stage.
    const image = s.ctx.getImageData(0, 0, s.gridWidth, s.gridHeight)
    const t2 = clock()
    s.decoder.decode(image.data, s.grid)
    const t3 = clock()

    border = detector.process(s.grid, t3)
    s.sampler.setBorder(border)
    s.sampler.sample(s.grid, s.target, 'mean')
    s.adjustment.apply(s.target)
    s.smoother.setTarget(s.target, t3)
    const t4 = clock()

    downscaleTimes.add(t1 - t0)
    readbackTimes.add(t2 - t1)
    decodeTimes.add(t3 - t2)
    sampleTimes.add(t4 - t3)
    // Still measured from ARRIVAL, not from t0: the four stages above sum to
    // the work, and the difference between that sum and this is the queueing
    // delay - which is the number that says whether the engine is behind.
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
  // The channel order is the last thing the engine does: everything above it,
  // the corner calibration included, works in real colours. What those colours
  // become on the wire is the sink's business, not this file's.
  s.order.apply(out)
  writer.send(out)
}


/**
 * Why a capture ended.
 *
 * 'user' is a decision; 'lost' is the stream ending underneath us - a
 * resolution change, an HDR toggle, the monitor sleeping - which happens on
 * real desks every day and needs a different sentence and a button, not an
 * error. 'restart' is this file replacing one source with another and must set
 * neither, or starting the self-test would leave the panel claiming the screen
 * capture had died.
 */
type StopReason = 'user' | 'lost' | 'restart'

function stop (reason: StopReason = 'user'): void {
  if (reason === 'lost') captureLost = true
  if (tickTimer !== null) clearInterval(tickTimer)
  if (reportTimer !== null) clearInterval(reportTimer)
  if (reconnectTimer !== null) clearTimeout(reconnectTimer)
  if (testTimer !== null) clearInterval(testTimer)
  if (patternTimer !== null) clearInterval(patternTimer)
  tickTimer = null
  reportTimer = null
  reconnectTimer = null
  testTimer = null
  patternTimer = null
  pattern = null
  const r = reader
  reader = null
  void r?.cancel().catch(() => { /* already closed */ })
  track?.stop()
  track = null
  if (state !== 'error') state = 'idle'
  // One black frame so the strip does not hold the last picture; the port
  // stays open for the next session.
  // One black frame so the strip does not hold the last picture. Through the
  // same sink as every other frame, and for every real link rather than only a
  // serial one: a WLED left on the last frame is just as stuck.
  if (linkMode !== 'none' && linkMode !== 'loopback') {
    writer.send(stages.target.fill(0))
  }
  report()
}

function report (): void {
  const a = arrivals.snapshot(clock())
  const o = outputs.snapshot(clock())
  const p = processTimes.snapshot()
  const w = writer.stats()
  const l = loopback.loopback()
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
    stageMs: {
      downscale: downscaleTimes.snapshot().p50,
      readback: readbackTimes.snapshot().p50,
      decode: decodeTimes.snapshot().p50,
      sample: sampleTimes.snapshot().p50
    },
    outputFps: o.fps,
    link: {
      mode: linkMode,
      written: w.written,
      dropped: w.dropped,
      errors: w.errors,
      // Loopback-only counters. They stay at their last values on a real link
      // rather than being reset, because a user who switches from loopback to a
      // device should still be able to read what the loopback proved.
      accepted: l.accepted,
      rejected: l.rejected,
      ...(portLabel !== undefined ? { port: portLabel } : {}),
      // Whatever this transport counts for itself: bytes on a serial port,
      // reconnects and drops on a socket. The panel shows them without knowing
      // which sink produced them.
      detail: sink.stats()
    },
    border: { unknown: border.unknown, topBottom: border.topBottom, leftRight: border.leftRight },
    ...(settings !== undefined && settings.width !== undefined && settings.height !== undefined
      ? { source: { width: settings.width, height: settings.height, ...(settings.frameRate !== undefined ? { frameRate: settings.frameRate } : {}) } }
      : {}),
    ...(pattern !== null ? { pattern: pattern.kind } : {}),
    ...(captureLost ? { lost: true } : {}),
    ...(lastError !== undefined ? { error: lastError } : {})
  }
  void chrome.runtime.sendMessage({ type: 'ambiflux/stats', target: 'sw', stats } satisfies Message).catch(() => { /* worker asleep */ })
  void chrome.runtime.sendMessage({ type: 'ambiflux/state', target: 'sw', state } satisfies Message).catch(() => { /* worker asleep */ })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isMessage(message) || !('target' in message) || message.target !== 'offscreen') return false
  switch (message.type) {
    case 'ambiflux/start':
      startPicked().then(() => sendResponse({ state, error: lastError }))
      return true
    case 'ambiflux/selftest':
      startSelfTest().then(() => sendResponse({ state, error: lastError }))
      return true
    case 'ambiflux/pattern':
      try {
        startPattern(message.spec)
        sendResponse({ state, pattern: pattern?.kind })
      } catch (error) {
        // A bad spec leaves whatever was running alone: a typo in a wizard must
        // not black out a strip that is happily following the screen.
        sendResponse({ state, error: error instanceof Error ? error.message : String(error) })
      }
      return false
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
