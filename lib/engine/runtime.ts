import { createAdjustment, type Adjustment } from '#lib/engine/adjust'
import { createBorderDetector } from '#lib/engine/border'
import { DEFAULT_ENGINE_CONFIG, parseEngineConfig, resolveLayout, type EngineConfig } from '#lib/engine/config'
import { queryControl, wifiControl } from '#lib/engine/control'
import { allocLinearGrid, createRgbaDecoder, type RgbaDecoder } from '#lib/engine/decode'
import { createFrameEncoder, type FrameEncoder } from '#lib/engine/encode'
import { afxUrl, createSocketSink, createWledSink } from '#lib/engine/net'
import { createColorOrder, type ColorOrderStage } from '#lib/engine/order'
import { createPattern, parsePatternSpec, type Pattern } from '#lib/engine/patterns'
import { createSampler, type Sampler } from '#lib/engine/sample'
import {
  createBytesSink,
  createFrameWriter,
  createLoopbackSink,
  type FrameSink,
  type FrameWriter,
  type LoopbackSink
} from '#lib/engine/sink'
import { createSmoother, type Smoother } from '#lib/engine/smooth'
import { type FrameSource, type SourceFrame } from '#lib/engine/source'
import { createArrivalMeter, createValueMeter } from '#lib/engine/stats'
import { NO_BORDER, allocLedColors, type Border, type LedColors, type LinearGrid } from '#lib/engine/types'
import { wledUrl } from '#lib/engine/wled'
import type { ControlRequest, EngineState, EngineStats, LinkMode } from '#lib/extension/messages'

/**
 * The engine, with no host in it.
 *
 * This file used to be `extension/src/offscreen.ts`, and that was the problem:
 * the pipeline and the Chrome extension were the same 875 lines, so the engine
 * could only ever run where `chrome.*` exists. Everywhere else - Safari,
 * Firefox, an iPhone - the application was a colour picker.
 *
 * That mattered more after the network drivers landed. An iPhone can capture
 * its screen (measured, against a compatibility table that still says it
 * cannot) and can now reach a strip over WiFi. The only thing left in the way
 * was that the engine had nowhere to run there.
 *
 * So the host is injected and there are two of them:
 *
 * - the extension's offscreen document, which is never rendered and therefore
 *   never throttled - still the right answer on a Chromium desktop, and still
 *   the only one that survives a full-screen game;
 * - the panel page itself, which is throttled when hidden and says so, and is
 *   the ONLY route on every platform with no extension.
 *
 * What the host provides is small and deliberately so: a clock, a 2D canvas,
 * and a capture source. Everything else - the stages, the meters, the border
 * detector, the smoother, the link, the counters, the patterns - is here,
 * shared, and tested once.
 *
 * Two rules hold throughout, and both come from the original file:
 *
 * - **No `requestAnimationFrame`.** The offscreen document is never painted, so
 *   rAF never fires there. Frames drive the capture side; a timer drives the
 *   output side.
 * - **Nothing queues.** A frame arriving while the previous one is in flight is
 *   dropped and counted (`pipelineDrops`); a frame ready while a write is in
 *   flight is dropped and counted (`link.dropped`). Every drop is visible in
 *   the panel.
 */

/** The output rate: a property of the strip and the firmware, not of the capture. */
export const OUTPUT_HZ = 120
/** Output timer period. Chrome clamps nested timers to 4 ms; the smoother paces itself. */
const TICK_MS = 4
const REPORT_MS = 1000
const RECONNECT_MS = 3000
/** Never 1200: on some cores that baud triggers a bootloader reset. */
const BAUD_RATE = 921600

/** The 2D surface the pipeline draws its one downscale onto. */
export interface Context2DLike {
  drawImage: (image: never, dx: number, dy: number) => void
  getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray }
}

export interface CanvasLike {
  getContext: (id: '2d', options?: { willReadFrequently?: boolean }) => Context2DLike | null
}

/**
 * What a host has to supply.
 *
 * Small on purpose. Every capability that a plain document has - sockets,
 * Web Serial, `createImageBitmap` - is used directly below rather than routed
 * through here, because routing it would mean two implementations of the same
 * thing and one of them would rot.
 */
export interface EngineHost {
  clock: () => number
  /** `OffscreenCanvas` in the extension, a detached `<canvas>` in a page. */
  createCanvas: (width: number, height: number) => CanvasLike
  /** Opens the screen capture. The picker, and its error wording, belong to the host. */
  openSource: (config: EngineConfig) => Promise<FrameSource>
  /** A generated picture instead of the screen. Absent where the host cannot make one. */
  openSelfTest?: (config: EngineConfig) => Promise<FrameSource>
  /** Called on every statistics tick and on every state change. */
  onReport?: (stats: EngineStats, state: EngineState) => void
}

/**
 * Why a capture ended.
 *
 * 'user' is a decision; 'lost' is the stream ending underneath us - a
 * resolution change, an HDR toggle, a monitor sleeping - which happens on real
 * desks every day and needs a different sentence and a button, not an error.
 * 'restart' is one source replacing another and must set neither.
 */
export type StopReason = 'user' | 'lost' | 'restart'

export interface Engine {
  state: () => EngineState
  stats: () => EngineStats
  config: () => EngineConfig
  error: () => string | undefined
  /** Validates and applies a configuration, rebuilding the stages and the link. */
  applyConfig: (value: unknown) => EngineConfig
  start: () => Promise<void>
  selfTest: () => Promise<void>
  /** A test pattern straight to the strip: no capture, no smoothing, no sampling. */
  runPattern: (spec: unknown) => void
  stop: (reason?: StopReason) => void
  /** Reopens the link - after the user pairs a serial port, or changes a host. */
  relink: () => Promise<void>
  /** One AxC control frame to the board, down whichever link is carrying frames. */
  sendControl: (request: ControlRequest) => Promise<void>
  /** The current link, for a host that needs to name it. */
  link: () => { mode: LinkMode, label?: string }
}

interface Stages {
  config: EngineConfig
  leds: number
  gridWidth: number
  gridHeight: number
  decoder: RgbaDecoder
  grid: LinearGrid
  canvas: CanvasLike
  ctx: Context2DLike
  sampler: Sampler
  adjustment: Adjustment
  order: ColorOrderStage
  smoother: Smoother
  target: LedColors
  encoder: FrameEncoder
}

export function createEngine (host: EngineHost): Engine {
  const clock = host.clock
  const detector = createBorderDetector({}, clock)

  const arrivals = createArrivalMeter({ windowMs: 2000, gapMs: 50 })
  const outputs = createArrivalMeter({ windowMs: 2000, gapMs: 50 })
  const processTimes = createValueMeter(512)
  const downscaleTimes = createValueMeter(512)
  const readbackTimes = createValueMeter(512)
  const decodeTimes = createValueMeter(512)
  const sampleTimes = createValueMeter(512)

  let captured = 0
  let pipelineDrops = 0
  let border: Readonly<Border> = NO_BORDER
  let captureLost = false

  let state: EngineState = 'idle'
  let lastError: string | undefined
  let source: FrameSource | null = null
  let sourceKind: string | undefined
  let processing: Promise<void> | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null
  let reportTimer: ReturnType<typeof setInterval> | null = null
  let patternTimer: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pattern: Pattern | null = null

  // -------------------------------------------------------------------------
  // The stages, rebuilt whenever the configuration changes.
  // -------------------------------------------------------------------------

  function build (config: EngineConfig): Stages {
    const layout = resolveLayout(config)
    const leds = layout.length
    const { gridWidth, gridHeight } = config.capture
    const canvas = host.createCanvas(gridWidth, gridHeight)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx === null) throw new Error('engine: this host gave no 2d context')
    return {
      config,
      leds,
      gridWidth,
      gridHeight,
      decoder: createRgbaDecoder(gridWidth, gridHeight),
      grid: allocLinearGrid(gridWidth, gridHeight),
      canvas,
      ctx,
      sampler: createSampler({ layout, width: gridWidth, height: gridHeight }),
      adjustment: createAdjustment([{ leds: '*' }], leds),
      order: createColorOrder(leds, {
        order: config.colorOrder.order,
        ...(config.colorOrder.overrides === undefined ? {} : { overrides: config.colorOrder.overrides })
      }),
      smoother: createSmoother({ mode: 'asymmetric', count: leds, outputHz: OUTPUT_HZ }, clock),
      target: allocLedColors(leds),
      encoder: createFrameEncoder(
        // WLED never sees one of our wire formats; it gets JSON from its own
        // sink. The encoder still exists so the loopback has something to parse.
        config.output.transport === 'wled' ? 'Afx' : config.output.format,
        leds,
        config.output.format === 'Awa' ? config.output.calibration : undefined
      )
    }
  }

  let stages = build(DEFAULT_ENGINE_CONFIG as EngineConfig)

  // -------------------------------------------------------------------------
  // The link.
  // -------------------------------------------------------------------------

  let linkMode: LinkMode = 'none'
  let loopback: LoopbackSink = createLoopbackSink({ encoder: stages.encoder })
  let sink: FrameSink = loopback
  let writer: FrameWriter = createFrameWriter(loopback)
  let port: SerialPort | null = null
  let portWriter: WritableStreamDefaultWriter<Uint8Array> | null = null
  let portLabel: string | undefined

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
    lastError = `${linkMode}: ${describe(error)}`
    // A serial port that errors is gone and has to be reopened. The network
    // sinks reconnect on their own, so an error there is reported and no more.
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
   * address and no second device. The two network transports exist because on
   * iOS there is no Web Serial, no WebUSB, no WebHID and no Web Bluetooth, so a
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
      const address = output.host
      if (address === undefined || address.trim() === '') {
        lastError = 'ağ çıkışı için adres girilmedi'
        useLoopback()
        return
      }
      try {
        useSink(
          output.transport === 'wled'
            ? createWledSink({ url: wledUrl(address), leds: stages.leds, segment: output.segment ?? 0 })
            : createSocketSink({ url: afxUrl(address), encoder: stages.encoder }),
          output.transport,
          address
        )
      } catch (error) {
        lastError = `${output.transport}: ${describe(error)}`
        useLoopback()
      }
      return
    }
    await connectSerial()
  }

  /**
   * Opens the first port the user has paired.
   *
   * `getPorts()` rather than `requestPort()`: the permission belongs to the
   * origin and was granted by a gesture somewhere else - the extension's popup,
   * or a button in the panel. This can therefore run at start-up, with no
   * gesture, in either host. No port means the loopback: the pipeline runs and
   * is measured either way.
   */
  async function connectSerial (): Promise<void> {
    if (port !== null) return
    const serial = (globalThis as { navigator?: { serial?: { getPorts: () => Promise<SerialPort[]> } } }).navigator?.serial
    if (serial === undefined) {
      // Web Serial is Chromium-only, and on the platforms without it the
      // network transports are the answer rather than an error.
      if (linkMode !== 'loopback') useLoopback()
      return
    }
    const ports = await serial.getPorts()
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
      lastError = `seri port: ${describe(error)}`
      if (linkMode !== 'loopback') useLoopback()
      scheduleReconnect()
    }
  }

  async function dropPort (error: unknown): Promise<void> {
    lastError = `seri port: ${describe(error)}`
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

  /**
   * Rebuilds the output for the configuration now in `stages`.
   *
   * An open serial port whose transport has not changed is kept and only the
   * sink around it is rebuilt: closing and reopening a working port costs a
   * visible gap on the strip, and nothing about the port depends on the encoder.
   */
  function rebuildLink (): void {
    const handle = portWriter
    if (stages.config.output.transport === 'serial' && handle !== null) {
      useSink(
        createBytesSink({
          kind: 'serial',
          label: portLabel ?? 'serial',
          encoder: stages.encoder,
          transport: { write: (bytes: Uint8Array) => handle.write(bytes) }
        }),
        'port',
        portLabel
      )
      return
    }
    // The loopback's encoder is part of the configuration too - it is what
    // proves the framing - so it is rebuilt rather than left parsing the old
    // format.
    loopback = createLoopbackSink({ encoder: stages.encoder })
    void closePort().then(connectLink).catch(() => { useLoopback() })
  }

  /**
   * Sends one AxC control frame to the board.
   *
   * Down the SAME link the pixels take, because the firmware reads both from
   * the same parser - so a board on WiFi is reconfigured over WiFi and one on
   * the cable over the cable. A link with no control channel (the loopback, a
   * WLED, nothing connected) says so rather than pretending: this is the one
   * message where a silent drop would be a lie the user acts on.
   */
  async function sendControl (request: ControlRequest): Promise<void> {
    const send = sink.sendBytes
    if (send === undefined) throw new Error(`${linkMode}: bu bağlantının kontrol kanalı yok`)
    const frame = request.kind === 'wifi'
      ? wifiControl({ ssid: request.ssid, passphrase: request.passphrase, enabled: request.enabled })
      : queryControl()
    await send(frame)
  }

  // -------------------------------------------------------------------------
  // The pipeline.
  // -------------------------------------------------------------------------

  async function processFrame (frame: SourceFrame, arrivedAt: number): Promise<void> {
    let bitmap: { close: () => void } | null = null
    // Read `stages` ONCE for the whole frame. A config swap between two of these
    // lines would mix a grid of one size with a decoder built for another, which
    // is a real hazard rather than a theoretical one: the grid is configuration.
    const s = stages
    try {
      // The one downscale: an area average straight from the source, and the
      // crop happens HERE, as the source rectangle. Cropping later would mean
      // downscaling pixels that are about to be thrown away, and cropping the
      // grid would quantise the crop to whole grid cells.
      const t0 = clock()
      const crop = s.config.capture.crop
      const sx = Math.round(frame.width * crop.left)
      const sy = Math.round(frame.height * crop.top)
      const sw = Math.max(1, Math.round(frame.width * (1 - crop.left - crop.right)))
      const sh = Math.max(1, Math.round(frame.height * (1 - crop.top - crop.bottom)))
      const options = { resizeWidth: s.gridWidth, resizeHeight: s.gridHeight, resizeQuality: 'high' } as const
      const image = frame.image as ImageBitmapSource
      bitmap = sx === 0 && sy === 0 && sw === frame.width && sh === frame.height
        ? await createImageBitmap(image, options)
        : await createImageBitmap(image, sx, sy, sw, sh, options)
      frame.release()
      const t1 = clock()
      s.ctx.drawImage(bitmap as never, 0, 0)
      bitmap.close()
      bitmap = null
      // getImageData is where the GPU work is actually waited on: the drawImage
      // above only queues, so timing them apart would credit the wrong stage.
      const rgba = s.ctx.getImageData(0, 0, s.gridWidth, s.gridHeight)
      const t2 = clock()
      s.decoder.decode(rgba.data, s.grid)
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
      // Still measured from ARRIVAL: the four stages sum to the work, and the
      // difference between that sum and this is the queueing delay - which is
      // the number that says whether the engine is behind.
      processTimes.add(clock() - arrivedAt)
      // A frame is the most precise clock edge we get; take an output slot if
      // one is open rather than wait for the 4 ms timer.
      tick()
    } finally {
      bitmap?.close()
      frame.release()
    }
  }

  function onFrame (frame: SourceFrame, at: number): void {
    arrivals.mark(at)
    captured++
    if (processing !== null) {
      pipelineDrops++
      frame.release()
      return
    }
    processing = processFrame(frame, at)
      .catch((error: unknown) => { lastError = describe(error) })
      .finally(() => { processing = null })
  }

  function tick (): void {
    if (state !== 'running') return
    const s = stages
    const now = clock()
    const out = s.smoother.tick(now)
    if (out === null) return
    outputs.mark(now)
    // The channel order is the last thing the engine does: everything above it,
    // the corner calibration included, works in real colours. What those become
    // on the wire is the sink's business.
    s.order.apply(out)
    writer.send(out)
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

  /** Everything both sources share: start the clocks, the link and the pump. */
  async function begin (open: () => Promise<FrameSource>): Promise<void> {
    if (state === 'running' || state === 'starting') stop('restart')
    state = 'starting'
    lastError = undefined
    captureLost = false
    report()
    try {
      const next = await open()
      source = next
      sourceKind = next.kind
      resetCounters()
      state = 'running'
      tickTimer = setInterval(tick, TICK_MS)
      reportTimer = setInterval(report, REPORT_MS)
      void connectLink()
      next.start(onFrame, (error) => {
        // An ended source is the stream dying under us - a resolution change,
        // an HDR toggle, the monitor sleeping, or the browser's own "stop
        // sharing" - and all of those are the same event from here.
        if (error !== undefined) lastError = describe(error)
        if (state === 'running') stop('lost')
      })
      report()
    } catch (error) {
      state = 'error'
      lastError = describe(error)
      report()
    }
  }

  function stop (reason: StopReason = 'user'): void {
    if (reason === 'lost') captureLost = true
    if (tickTimer !== null) clearInterval(tickTimer)
    if (reportTimer !== null) clearInterval(reportTimer)
    if (patternTimer !== null) clearInterval(patternTimer)
    if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    tickTimer = null
    reportTimer = null
    patternTimer = null
    reconnectTimer = null
    pattern = null
    const s = source
    source = null
    void s?.stop().catch(() => { /* already gone */ })
    if (state !== 'error') state = 'idle'
    // One black frame so the strip does not hold the last picture. Through the
    // same sink as every other frame, and for every real link rather than only
    // a serial one: a WLED left on the last frame is just as stuck.
    if (linkMode !== 'none' && linkMode !== 'loopback') {
      writer.send(stages.target.fill(0))
    }
    report()
  }

  function snapshot (): EngineStats {
    const a = arrivals.snapshot(clock())
    const o = outputs.snapshot(clock())
    const p = processTimes.snapshot()
    const w = writer.stats()
    const l = loopback.loopback()
    return {
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
        // Loopback-only counters. They keep their last values on a real link
        // rather than resetting, because a user who switches from the loopback
        // to a device should still be able to read what the loopback proved.
        accepted: l.accepted,
        rejected: l.rejected,
        ...(portLabel !== undefined ? { port: portLabel } : {}),
        detail: sink.stats()
      },
      border: { unknown: border.unknown, topBottom: border.topBottom, leftRight: border.leftRight },
      ...sourceSize(),
      ...(sourceKind !== undefined ? { sourceKind } : {}),
      ...(pattern !== null ? { pattern: pattern.kind } : {}),
      ...(captureLost ? { lost: true } : {}),
      ...(lastError !== undefined ? { error: lastError } : {})
    }
  }

  /**
   * The capture size, when the source knows it. Shown because "2560x1440" and
   * "1180x2556" are the difference between a desk and a phone, and because a
   * size that suddenly changes is what ends a stream.
   */
  function sourceSize (): { source?: { width: number, height: number, frameRate?: number } } {
    const settings = source?.settings()
    if (settings?.width === undefined || settings.height === undefined) return {}
    return {
      source: {
        width: settings.width,
        height: settings.height,
        ...(settings.frameRate !== undefined ? { frameRate: settings.frameRate } : {})
      }
    }
  }

  function report (): void {
    host.onReport?.(snapshot(), state)
  }

  return {
    state: () => state,
    stats: snapshot,
    config: () => stages.config,
    error: () => lastError,
    link: () => ({ mode: linkMode, ...(portLabel !== undefined ? { label: portLabel } : {}) }),

    applyConfig (value: unknown): EngineConfig {
      const config = parseEngineConfig(value)
      const next = build(config)
      next.sampler.setBorder(border)
      const outputChanged = JSON.stringify(stages.config.output) !== JSON.stringify(config.output)
      const ledsChanged = stages.leds !== next.leds
      stages = next
      // The sink holds the encoder it was built with, so an output change - or
      // a layout change, which changes the LED count and therefore the frame -
      // would otherwise be accepted by the panel and silently not reach the
      // device.
      if (outputChanged || ledsChanged) rebuildLink()
      return config
    },

    async start (): Promise<void> {
      await begin(async () => await host.openSource(stages.config))
    },

    async selfTest (): Promise<void> {
      const open = host.openSelfTest
      if (open === undefined) {
        state = 'error'
        lastError = 'bu ortamda kendi kendine test yok'
        report()
        return
      }
      await begin(async () => await open(stages.config))
    },

    runPattern (spec: unknown): void {
      const parsed = parsePatternSpec(spec)
      if (state === 'running' || state === 'starting') stop('restart')
      lastError = undefined
      captureLost = false
      sourceKind = undefined
      pattern = createPattern(parsed, stages.leds, clock)
      state = 'running'
      void connectLink()
      patternTimer = setInterval(emitPattern, Math.round(1000 / OUTPUT_HZ))
      reportTimer = setInterval(report, REPORT_MS)
      emitPattern()
      report()
    },

    stop,

    async relink (): Promise<void> {
      await closePort()
      await connectLink()
    },

    sendControl
  }
}

function describe (error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  // DOMException carries the useful half in `name`; the message alone reads the
  // same whatever actually went wrong.
  return error.name === '' || error.name === 'Error' ? error.message : `${error.name}: ${error.message}`
}
