import { createAdjustment, type Adjustment } from '#lib/engine/adjust'
import { createVisualiser, parseAudioSpec, type AudioSpec, type Visualiser } from '#lib/engine/audio'
import { openDisplayAudio, openMicrophone, type AudioInputKind, type AudioSource } from '#lib/engine/audio-input'
import { createBorderDetector, type BorderDetector } from '#lib/engine/border'
import { srgbToLinear } from '#lib/light'
import { DEFAULT_ENGINE_CONFIG, parseEngineConfig, resolveLayout, type EngineConfig } from '#lib/engine/config'
import { queryControl, wifiControl } from '#lib/engine/control'
import { allocLinearGrid, createRgbaDecoder, type RgbaDecoder } from '#lib/engine/decode'
import { createFrameEncoder, type FrameEncoder } from '#lib/engine/encode'
import { afxUrl, createSocketSink, createWledSink } from '#lib/engine/net'
import { createEffect, effectGeometry, parseEffectSpec, type Effect, type EffectGeometry } from '#lib/engine/effects'
import { createColorOrder, type ColorOrderStage } from '#lib/engine/order'
import { createPattern, parsePatternSpec, type Pattern } from '#lib/engine/patterns'
import {
  BACKGROUND_PRIORITY,
  DEFAULT_STREAM_TIMEOUT_MS,
  HIGHEST_PRIORITY,
  PriorityMuxer,
  type SourceInfo
} from '#lib/engine/priority'
import { createSampler, type Sampler } from '#lib/engine/sample'
import {
  createScheduler,
  momentFrom,
  parseRules,
  type ScheduleAction,
  type ScheduleRule,
  type Scheduler
} from '#lib/engine/schedule'
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
import { TEXT } from '#lib/engine/text'

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

/**
 * Who wins when several sources are live.
 *
 * Hyperion's convention and ours: a LOWER number wins. The ordering is the
 * useful part rather than the numbers - capture sits at the bottom because it
 * is the thing you leave running, and anything you deliberately start takes
 * over until you stop it, at which point the capture is still there and comes
 * back on its own.
 *
 * Before this the sources simply stopped each other: starting an effect ended
 * the capture, and stopping the effect left the strip dark with the user
 * having to pick their screen again. The muxer has existed and been tested
 * since the protocol work; what was missing was anything feeding it.
 *
 * The gaps are deliberate. A user rule, a remote command or a second effect
 * has somewhere to land without renumbering what is already here.
 */
export const PRIORITY = Object.freeze({
  /** A test pattern outranks everything, because it is a measurement. */
  pattern: 50,
  /**
   * A colour with a time limit: "red for ten seconds, then back to whatever
   * was showing".
   *
   * Above the effects, because that is what interrupting MEANS - a
   * notification that an effect could sit on top of would not be one.
   */
  flash: 100,
  effect: 150,
  audio: 160,
  /**
   * A colour with no time limit, which is a BASE rather than an interruption.
   *
   * Below the effects on purpose, and this is the pair of decisions that took a
   * failing test to get right. "Set the strip to warm white" is a thing you
   * want to come back to after an effect; "flash red" is a thing that has to
   * cut through one. The same call does both, and which it is depends on
   * whether a duration was given - not on the caller remembering a number.
   */
  color: 200,
  /** The thing you leave running, so everything else is "instead of this". */
  capture: 240
})

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
  /**
   * An effect: light with no screen behind it.
   *
   * Unlike a test pattern this is CONTENT, so it goes through the smoother and
   * the channel-order stage exactly as a captured frame does. A pattern that
   * did the same would be testing the smoother instead of the wiring.
   */
  runEffect: (spec: unknown) => void
  /**
   * Sound on the strip.
   *
   * `input` chooses the microphone (everywhere, hears the room) or tab/system
   * audio (Chromium only, hears exactly what is playing). Like an effect this
   * is content and goes through the whole output path.
   */
  runAudio: (spec: unknown, input?: AudioInputKind) => Promise<void>
  stop: (reason?: StopReason) => void
  /** Reopens the link - after the user pairs a serial port, or changes a host. */
  relink: () => Promise<void>
  /**
   * Drops one layer, leaving the rest running.
   *
   * The whole point of the muxer: stopping an effect reveals the capture that
   * was underneath it rather than leaving the strip dark.
   */
  clearLayer: (priority: number) => void
  /** Drives the strip with one colour, optionally for a fixed time. */
  setColor: (color: { r: number, g: number, b: number }, durationMs?: number) => void
  /**
   * Replaces the time-of-day rules.
   *
   * The scheduler runs whether or not anything is showing - "start the capture
   * at eight" is useless if it needs the engine to already be running.
   */
  setSchedule: (rules: unknown) => ScheduleRule[]
  schedule: () => ScheduleRule[]
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
  /**
   * Rebuilt with the stages rather than reconfigured, because a mode change
   * SHOULD start again: the candidate border it is holding was found by the
   * OLD probe pattern, and carrying it into the new one would mean the first
   * seconds after the change show a border the new mode never found.
   */
  detector: BorderDetector
  target: LedColors
  encoder: FrameEncoder
  geometry: EffectGeometry
  /**
   * The wire indices the blacklist keeps dark. The sampler reads their
   * zero-area rectangles as black on its own; every other source - effects,
   * patterns, colours, audio, the two automatic layers - writes all `leds`,
   * so the mask is applied once, where every frame passes: in tick().
   */
  dark: number[]
}

export function createEngine (host: EngineHost): Engine {
  const clock = host.clock

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
  let effect: Effect | null = null
  let effectSpec: unknown = null
  let effectTimer: ReturnType<typeof setInterval> | null = null
  /**
   * The two layers nobody starts by hand.
   *
   * Separate `Effect` instances rather than one shared with the user's effect:
   * they run at the same time by definition - the whole point of the background
   * is that it is underneath something else - and one instance driven from two
   * places would render one animation into two buffers a frame apart.
   */
  let backgroundEffect: Effect | null = null
  let startupEffect: Effect | null = null
  /**
   * When the startup layer must let go, on the injected clock.
   *
   * Its own deadline rather than the muxer's inactivity timeout, and the
   * difference is not stylistic: that timeout measures from the last INPUT, and
   * an animated startup layer feeds a frame every tick - so it would reset its
   * own expiry forever and the boot animation would never end. A colour would
   * have expired correctly and an effect never would, which is the worst kind
   * of bug: right in the case you test first.
   */
  let startupUntil: number | null = null
  let audioTimer: ReturnType<typeof setInterval> | null = null
  let visualiser: Visualiser | null = null
  /** What the visualiser was asked to show, kept like `effectSpec` so a layout edit rebuilds it with the same gain, colour and decay. */
  let audioSpec: AudioSpec | null = null
  let audio: AudioSource | null = null
  let bins: Float32Array = new Float32Array(0)

  /**
   * The arbiter, and a buffer per source.
   *
   * Separate buffers because the sources are now SIMULTANEOUS: a capture and an
   * effect can both be live, each writing its own frame, and the muxer decides
   * once per tick which one the strip sees. One shared buffer would have them
   * overwriting each other and the winner showing whichever wrote last.
   */
  const muxer = new PriorityMuxer(clock)

  /**
   * Time-of-day rules, on their own clock.
   *
   * Deliberately NOT tied to the engine running: "start the capture at eight in
   * the morning" is exactly the case where nothing is running yet, and a
   * scheduler that only ticked while something was showing could never fire it.
   *
   * A second is plenty - the rules have a resolution of a minute - and it costs
   * one comparison per rule.
   */
  const scheduler: Scheduler = createScheduler()
  let scheduleTimer: ReturnType<typeof setInterval> | null = null
  let captureTarget = allocLedColors(1)
  let effectTarget = allocLedColors(1)
  let audioTarget = allocLedColors(1)
  let patternTarget = allocLedColors(1)
  let colorTarget = allocLedColors(1)
  /**
   * Its own buffer, not `colorTarget`. A flash and a base colour are live at
   * the same time by definition - the flash sits on top and the base is what
   * comes back - and one buffer for both painted the base with the flash's
   * colour, so "red, then flash blue for a second" came back blue.
   */
  let flashTarget = allocLedColors(1)
  let backgroundTarget = allocLedColors(1)
  let startupTarget = allocLedColors(1)
  /**
   * What the static layers were asked to show, kept so they can be re-fed
   * after the LED count changes: the muxer holds the buffer that was handed
   * to it, and a layout edit that reallocates the buffers has to hand it the
   * new ones with the same content, or the strip goes on reading a frame the
   * encoder no longer accepts.
   */
  let baseColor: { r: number, g: number, b: number } | null = null
  let flashColor: { r: number, g: number, b: number } | null = null
  let patternSpec: unknown = null
  /**
   * Bumped by every stop, checked after every asynchronous open: a Stop - or a
   * strip removed by the pool - while the picker is up must win, or the capture
   * comes up running for a strip nobody can see.
   */
  let captureGen = 0

  function sizeBuffers (leds: number): void {
    if (captureTarget.length === leds * 3) return
    captureTarget = allocLedColors(leds)
    effectTarget = allocLedColors(leds)
    audioTarget = allocLedColors(leds)
    patternTarget = allocLedColors(leds)
    colorTarget = allocLedColors(leds)
    flashTarget = allocLedColors(leds)
    backgroundTarget = allocLedColors(leds)
    startupTarget = allocLedColors(leds)
  }

  // -------------------------------------------------------------------------
  // The stages, rebuilt whenever the configuration changes.
  // -------------------------------------------------------------------------

  function build (config: EngineConfig): Stages {
    const layout = resolveLayout(config)
    const leds = layout.length
    const dark: number[] = []
    layout.forEach((rect, i) => {
      if (rect.xMax - rect.xMin === 0 || rect.yMax - rect.yMin === 0) dark.push(i)
    })
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
      sampler: createSampler({
        layout,
        width: gridWidth,
        height: gridHeight,
        reducedPixelSetFactor: config.sampling.reducedPixelSetFactor,
        accuracyLevel: config.sampling.accuracyLevel
      }),
      // One profile over every LED. The engine supports several, selected by
      // LED range, and the eight-corner colour cube underneath them - but those
      // belong to the calibration wizard rather than to eight more sliders on a
      // settings page nobody can interpret.
      adjustment: createAdjustment([{ leds: '*', ...config.color }], leds),
      order: createColorOrder(leds, {
        order: config.colorOrder.order,
        ...(config.colorOrder.overrides === undefined ? {} : { overrides: config.colorOrder.overrides })
      }),
      // The smoothing constants come from the configuration rather than from
      // the smoother's defaults. They were compiled in until profiles existed,
      // and the numbers were good - but "how hard to smooth" depends on what
      // is on screen, and a film and a game want opposite answers.
      detector: createBorderDetector({
        enabled: config.border.enabled,
        mode: config.border.mode,
        threshold: config.border.threshold,
        blurRemovePx: config.border.blurRemovePx
      }, clock),
      smoother: createSmoother({
        mode: 'asymmetric',
        count: leds,
        outputHz: OUTPUT_HZ,
        attackMs: config.smoothing.attackMs,
        releaseMs: config.smoothing.releaseMs,
        cutThreshold: config.smoothing.cutThreshold
      }, clock),
      target: allocLedColors(leds),
      // Built with the stages rather than with the effect: it depends on the
      // layout, and a layout edit while an effect is running must not leave the
      // effect drawing on the old geometry.
      geometry: effectGeometry(layout),
      dark,
      encoder: createFrameEncoder(
        // WLED never sees one of our wire formats; it gets JSON from its own
        // sink. The encoder still exists so the loopback has something to parse.
        config.output.transport === 'wled' ? 'Afx' : config.output.format,
        leds,
        {
          ...(config.output.format === 'Awa' && config.output.calibration !== undefined
            ? { calibration: config.output.calibration }
            : {}),
          // Guarded by the same condition the parser enforces rather than
          // passed through: a stored config from before this option existed is
          // valid, and the loopback's Afx encoder must never be handed it.
          ...(config.output.dither === true &&
              config.output.transport !== 'wled' &&
              config.output.format !== 'Afx'
            ? { dither: true }
            : {})
        }
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
  let linking: Promise<void> | null = null

  /**
   * One link attempt at a time.
   *
   * Every source start asks for the link, and two sources starting together -
   * a capture and an effect, or the pool's strips - both reached `open()` on
   * the same serial port: the second rejected, its catch fell back to the
   * loopback and replaced the sink the first had just opened, and `port` stayed
   * set so the reconnect never fired. A serialised attempt makes the second
   * caller wait for the first and then find the port already open.
   */
  function connectLink (): Promise<void> {
    if (linking !== null) return linking
    linking = connectLinkNow().finally(() => { linking = null })
    return linking
  }

  async function connectLinkNow (): Promise<void> {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    const output = stages.config.output
    if (output.transport !== 'serial') {
      await closePort()
      const address = output.host
      if (address === undefined || address.trim() === '') {
        lastError = TEXT.noNetworkAddress
        useLoopback()
        return
      }
      try {
        const url = output.transport === 'wled' ? wledUrl(address) : afxUrl(address)
        // A page served over HTTPS may not open a plain ws:// connection - the
        // browser refuses it as mixed content, and from the sink's side that
        // is an ordinary connect failure that reconnects forever. Said as what
        // it is, and said BEFORE the first attempt. And said honestly: an
        // http:// panel is NOT the way round it, because screen capture itself
        // exists only in a secure context, so the page host can reach a LAN
        // board only through wss:// (a TLS bridge the device trusts) or not at
        // all; the extension's document has no such rule.
        if (isMixedContent(url)) {
          lastError = TEXT.mixedContent(output.transport)
          useLoopback()
          return
        }
        useSink(
          output.transport === 'wled'
            ? createWledSink({ url, leds: stages.leds, segment: output.segment ?? 0, gamma: output.wledGamma })
            : createSocketSink({ url, encoder: stages.encoder }),
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
      // A port that is open again has nothing left to complain about; any
      // other error (a capture's, a schedule's) is not this link's to clear.
      if (lastError?.startsWith('seri port:') === true) lastError = undefined
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
    // format. When the loopback IS the link, the sink and the writer have to
    // follow it: replacing only the variable left frames going to the old
    // loopback with the old encoder while the panel read the counters of the
    // new one, which was never fed.
    if (linkMode === 'loopback') useLoopback()
    else loopback = createLoopbackSink({ encoder: stages.encoder })
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
    if (send === undefined) throw new Error(TEXT.noControlChannel(linkMode))
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
    let released = false
    // Read `stages` ONCE for the whole frame. A config swap between two of these
    // lines would mix a grid of one size with a decoder built for another, which
    // is a real hazard rather than a theoretical one: the grid is configuration.
    const s = stages
    // And the source, for the same reason: this frame belongs to the capture
    // that was live when it arrived, and if that capture is stopped during one
    // of the awaits below the frame must not be fed - it would register the
    // capture layer again, with a stale picture and nothing to ever clear it.
    const mine = source
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
      // Released as soon as the bitmap exists, so the source's small frame pool
      // gets it back before the rest of the work - and exactly once, which is
      // the contract, rather than again in `finally`.
      frame.release()
      released = true
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

      border = s.detector.process(s.grid, t3)
      s.sampler.setBorder(border)
      // The mode was hardcoded here, which left six of the sampler's seven
      // reductions - and its decimation and accuracy options - written, tested
      // and unreachable.
      s.sampler.sample(s.grid, s.target, s.config.sampling.mode)
      // Not adjusted here any more: the colour chain runs in tick(), on
      // whatever the muxer chose, so it reaches an effect or a colour exactly
      // as it reaches the screen.
      captureTarget.set(s.target)
      // NO inactivity timeout on the capture layer, and this is a decision the
      // background forced rather than a simplification.
      //
      // Hyperion stands a grabber down after a few silent seconds. That is
      // right for it and wrong here, because a screen capture that sends
      // nothing is overwhelmingly a STILL SCREEN rather than a broken one - a
      // frame arrives per change, so a desktop nobody is touching is silent by
      // design. With a background configured, expiring the capture would hand
      // the strip to the background whenever somebody stopped moving the
      // mouse, and hand it back on the next change: a strip that flickers
      // between the screen and warm white on an idle desk.
      //
      // A capture that really ends is already caught, and caught better: the
      // track fires `onEnd`, which is a fact rather than an inference. Audio
      // keeps its timeout because a live microphone delivers silence rather
      // than nothing, so a silent audio layer really is a dead input.
      if (source !== mine) return
      feed(PRIORITY.capture, 'capture', captureTarget)
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
      if (!released) frame.release()
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

  /**
   * One output frame: ask the muxer who wins, then run the usual path.
   *
   * The arbitration happens HERE, once per frame, rather than when a source is
   * started. That is what makes the winner exactly what the strip is showing:
   * a source that expired between two frames never gets a frame of its own.
   *
   * A test pattern bypasses the smoother, and that bypass is load-bearing
   * rather than an optimisation - a single LED walking the strip through a
   * 90 ms release is a smear across four LEDs, and the pattern exists to make
   * "which LED is index 7" unambiguous. Everything else is content and is
   * smoothed.
   */
  function tick (fromPattern = false): void {
    if (state !== 'running') return
    const s = stages
    const now = clock()
    // Here as well as in the effect loop: a startup layer showing a flat colour
    // has no effect timer to end it, and the tick is the only clock it gets.
    endStartupIfDue(now)
    const won = muxer.tick(now)
    if (won === null) {
      // A layer that ends on its own - a timed colour expiring, the startup
      // deadline, the background switched off under nothing - goes through no
      // stopper, so nothing else would notice that the LAST layer has gone.
      // Without this the engine stayed "running" with no layers: timers alive,
      // no blackout, and the strip holding whatever frame came last.
      if (muxer.sources().length === 0) idleIfEmpty()
      return
    }
    if (won.input.kind !== 'colors') return

    if (won.component === 'pattern') {
      // Sent from the pattern's own timer only. The tick runs every 4 ms and
      // on every frame and every layer change besides, and a pattern bypasses
      // the smoother that paces everything else - so it went to the link at
      // several times OUTPUT_HZ and the latest-wins writer counted the excess
      // as drops on a perfectly healthy link.
      if (!fromPattern) return
      // Into the pipeline's scratch, never in place: the buffer is the muxer's
      // own, and permuting the channel order in place meant a second pass over
      // the same frame permuted it again.
      s.target.set(won.input.colors as LedColors)
      maskDark(s)
      outputs.mark(now)
      s.order.apply(s.target)
      writer.send(s.target)
      return
    }

    s.smoother.setTarget(won.input.colors as LedColors, now)
    const out = s.smoother.tick(now)
    if (out === null) return
    outputs.mark(now)
    // The colour chain - ceiling, white balance, saturation, taper, floor -
    // runs HERE, on whatever the muxer chose, which is Hyperion's order too: a
    // brightness ceiling of 20% has to dim an effect and a solid colour exactly
    // as it dims the screen, and it used to reach the captured picture only.
    // Copied first: the smoother owns `out` and overwrites it in place.
    s.target.set(out)
    // The floor is for the picture, where "the scene is dark" and "it broke"
    // look the same: a colour somebody chose as black stays black.
    s.adjustment.setBacklightEnabled(won.component === 'capture')
    s.adjustment.apply(s.target)
    maskDark(s)
    // The channel order is the last thing the engine does: everything above it,
    // the corner calibration included, works in real colours. What those become
    // on the wire is the sink's business.
    s.order.apply(s.target)
    writer.send(s.target)
  }

  /** Blacklisted LEDs are sent black whatever the source painted on them. */
  function maskDark (s: Stages): void {
    for (const led of s.dark) {
      const at = led * 3
      s.target[at] = 0
      s.target[at + 1] = 0
      s.target[at + 2] = 0
    }
  }

  /** Feeds a source, registering it again if it timed out while nothing looked. */
  function feed (priority: number, component: string, colors: LedColors, timeoutMs?: number): void {
    if (!muxer.has(priority)) {
      muxer.register(priority, { component, ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
    }
    muxer.setInput(priority, { kind: 'colors', colors })
  }

  /**
   * One effect frame.
   *
   * Into the smoother's TARGET, not straight to the writer: an effect is
   * content and gets the same output path a captured frame gets, so the
   * asymmetric smoothing and the channel order both apply. The effects are
   * already continuous, so the smoother has almost nothing to do - but "almost
   * nothing" is the right amount for a second code path to be doing.
   */
  function emitEffect (): void {
    if (state !== 'running') return
    const now = clock()
    if (effect !== null) {
      effect.render(effectTarget, now)
      feed(PRIORITY.effect, 'effect', effectTarget)
    }
    // The two automatic layers ride the same timer. A second interval for them
    // would render the same kind of thing at the same rate on a different
    // phase, which on a strip is two animations a few milliseconds apart.
    if (backgroundEffect !== null) {
      backgroundEffect.render(backgroundTarget, now)
      feed(BACKGROUND_PRIORITY, 'background', backgroundTarget)
    }
    if (startupEffect !== null) {
      startupEffect.render(startupTarget, now)
      feed(HIGHEST_PRIORITY, 'startup', startupTarget)
    }
    endStartupIfDue(now)
    tick()
  }

  /**
   * Keeps the effect timer alive exactly while something needs rendering.
   *
   * Three layers share it now, so neither starting nor stopping any one of them
   * can decide on its own whether the timer should run.
   */
  function ensureEffectTimer (): void {
    if (effect === null && backgroundEffect === null && startupEffect === null) {
      idleEffectTimer()
      return
    }
    effectTimer ??= setInterval(emitEffect, Math.round(1000 / OUTPUT_HZ))
  }

  function idleEffectTimer (): void {
    if (effect !== null || backgroundEffect !== null || startupEffect !== null) return
    if (effectTimer !== null) {
      clearInterval(effectTimer)
      effectTimer = null
    }
  }

  /**
   * Puts the configured background under everything, or takes it away.
   *
   * Called whenever the engine starts running and whenever the configuration
   * changes, because both can turn it on or off. A colour is fed once and stays
   * - the muxer holds the input, and a static colour has nothing to re-render.
   */
  function applyBackground (): void {
    const layer = stages.config.background
    if (!layer.enabled || state !== 'running') {
      backgroundEffect = null
      muxer.clear(BACKGROUND_PRIORITY)
      idleEffectTimer()
      return
    }
    sizeBuffers(stages.leds)
    if (layer.kind === 'effect') {
      backgroundEffect = createEffect({ kind: layer.effect }, stages.geometry, clock)
      ensureEffectTimer()
      // Drawn once straight away rather than at the next tick: waiting a frame
      // for the fallback to appear is a visible gap in the exact moment the
      // background exists to cover.
      emitEffect()
      return
    }
    backgroundEffect = null
    fillLinear(backgroundTarget, layer.color)
    feed(BACKGROUND_PRIORITY, 'background', backgroundTarget)
    idleEffectTimer()
  }

  /**
   * Runs the startup layer once, above everything, on its own deadline.
   *
   * The deadline is ours rather than the muxer's inactivity timeout because an
   * animated layer feeds every tick and would keep resetting that timeout - see
   * `startupUntil`.
   */
  function runStartup (): void {
    const layer = stages.config.startup
    if (!layer.enabled) return
    sizeBuffers(stages.leds)
    startupUntil = clock() + layer.durationMs
    muxer.register(HIGHEST_PRIORITY, { component: 'startup' })
    if (layer.kind === 'effect') {
      startupEffect = createEffect({ kind: layer.effect }, stages.geometry, clock)
      ensureEffectTimer()
      emitEffect()
      return
    }
    startupEffect = null
    fillLinear(startupTarget, layer.color)
    muxer.setInput(HIGHEST_PRIORITY, { kind: 'colors', colors: startupTarget })
  }

  /** Lets the startup layer go when its time is up, from wherever the clock is read. */
  function endStartupIfDue (now: number): void {
    if (startupUntil === null || now < startupUntil) return
    startupUntil = null
    startupEffect = null
    idleEffectTimer()
    muxer.clear(HIGHEST_PRIORITY)
  }

  /** sRGB bytes as a person picked them, decoded once into the engine's linear light. */
  function fillLinear (into: LedColors, color: { r: number, g: number, b: number }): void {
    const r = srgbToLinear(color.r / 255)
    const g = srgbToLinear(color.g / 255)
    const b = srgbToLinear(color.b / 255)
    for (let i = 0; i < into.length; i += 3) {
      into[i] = r
      into[i + 1] = g
      into[i + 2] = b
    }
  }

  /**
   * Everything that has to happen the moment the engine starts producing.
   *
   * Only on the IDLE -> RUNNING edge: starting a second source while one is
   * already running is not a boot, and replaying the boot animation over a
   * capture somebody is watching would be a bug rather than a flourish.
   */
  function enterRunning (): void {
    if (state === 'running') return
    state = 'running'
    applyBackground()
    runStartup()
  }

  /**
   * One audio frame.
   *
   * Into the smoother's target, like an effect: this is content. A source that
   * has gone - a microphone unplugged, a shared tab closed - stops the engine
   * rather than rendering silence forever, because silence and a dead input
   * look identical on a strip.
   */
  function emitAudio (): void {
    const v = visualiser
    const input = audio
    if (v === null || input === null || state !== 'running') return
    if (!input.read(bins)) {
      // A source that has gone - a microphone unplugged, a shared tab closed -
      // drops its LAYER rather than the whole engine. If a capture is running
      // underneath, it comes back rather than the strip going dark.
      lastError = TEXT.audioSourceLost
      stopAudio()
      return
    }
    v.render(bins, audioTarget, clock())
    feed(PRIORITY.audio, 'audio', audioTarget, DEFAULT_STREAM_TIMEOUT_MS.audio)
    tick()
  }

  function emitPattern (): void {
    const p = pattern
    if (p === null || state !== 'running') return
    p.render(patternTarget, clock())
    feed(PRIORITY.pattern, 'pattern', patternTarget)
    tick(true)
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
    stages.detector.reset()
    stages.smoother.reset()
  }

  /**
   * Stops ONE layer rather than the engine.
   *
   * This is what priority layers buy: before them every source stopped every
   * other, so ending an effect left the strip dark and the user picking their
   * screen again. Now whatever was underneath comes back by itself.
   */
  /*
   * `settle` is false when the caller is about to put the same kind of layer
   * straight back - runEffect replacing an effect, begin() replacing a capture.
   * With it true, replacing the only live layer went through idleIfEmpty:
   * clocks stopped, state idle, a black frame to the strip, and then
   * enterRunning played the startup animation again. Switching from one
   * effect to the next blinked black and replayed the boot sequence.
   */
  function stopAudio (settle = true): void {
    if (audioTimer !== null) {
      clearInterval(audioTimer)
      audioTimer = null
    }
    visualiser = null
    audioSpec = null
    const a = audio
    audio = null
    void a?.stop().catch(() => { /* already gone */ })
    muxer.clear(PRIORITY.audio)
    if (settle) idleIfEmpty()
  }

  function stopEffect (settle = true): void {
    effect = null
    effectSpec = null
    // Only if nothing else is rendering: a background effect keeps the timer.
    idleEffectTimer()
    muxer.clear(PRIORITY.effect)
    if (settle) idleIfEmpty()
  }

  function stopPattern (settle = true): void {
    pattern = null
    patternSpec = null
    if (patternTimer !== null) {
      clearInterval(patternTimer)
      patternTimer = null
    }
    muxer.clear(PRIORITY.pattern)
    if (settle) idleIfEmpty()
  }

  function stopCapture (lost: boolean, settle = true): void {
    if (lost) captureLost = true
    captureGen++
    const s = source
    source = null
    sourceKind = undefined
    void s?.stop().catch(() => { /* already gone */ })
    muxer.clear(PRIORITY.capture)
    if (settle) idleIfEmpty()
  }

  /** Clears one layer by priority, for the panel's layer list. */
  function clearLayer (priority: number): void {
    switch (priority) {
      case PRIORITY.capture: stopCapture(false); return
      case PRIORITY.effect: stopEffect(); return
      case PRIORITY.audio: stopAudio(); return
      case PRIORITY.pattern: stopPattern(); return
      // The two automatic layers keep their own state beside the muxer slot,
      // and clearing the slot alone let feed() register it again on the next
      // effect tick - the layer list's Stop button vanished the row for one
      // poll and it came straight back.
      case HIGHEST_PRIORITY:
        startupUntil = null
        startupEffect = null
        muxer.clear(HIGHEST_PRIORITY)
        idleEffectTimer()
        idleIfEmpty()
        return
      case BACKGROUND_PRIORITY:
        backgroundEffect = null
        muxer.clear(BACKGROUND_PRIORITY)
        idleEffectTimer()
        idleIfEmpty()
        return
      default:
        muxer.clear(priority)
        idleIfEmpty()
    }
  }

  /**
   * With every layer gone the engine is idle, and the strip is blacked.
   *
   * Checked after each layer stops rather than assumed: "the last source ended"
   * and "a source ended" need different things done, and only the first of them
   * should leave the strip dark.
   *
   * A background counts as a layer here, and that is the whole feature: "the
   * capture ended" has to leave warm white behind it rather than darkness. This
   * used to skip the background slot, which was correct while nothing could
   * ever register there - and would now black the strip in exactly the case the
   * background exists for.
   */
  function idleIfEmpty (): void {
    if (muxer.sources().length > 0) {
      // Arbitrate NOW rather than waiting for the 4 ms timer: a layer that has
      // just been cleared should reveal what is under it immediately, and until
      // a tick runs both the strip and the reported winner are still showing
      // the layer that is gone.
      tick()
      report()
      return
    }
    stopClocks()
    if (state !== 'error') state = 'idle'
    blackout()
    report()
  }

  /**
   * Applies one scheduled action.
   *
   * `capture` is the one that can fail, and honestly so: most browsers require
   * a user gesture for `getDisplayMedia`, which a timer does not have. It
   * fails in the page host and works in the extension's offscreen document,
   * where the picker opens without one - and the failure is reported rather
   * than swallowed, because a schedule that silently does nothing is worse than
   * no schedule.
   */
  function applyScheduled (action: ScheduleAction): void {
    switch (action.kind) {
      case 'stop': stop('user'); return
      case 'capture': void api.start(); return
      case 'effect': api.runEffect(action.spec); return
      default: api.setColor(action.color)
    }
  }

  function runSchedule (): void {
    const actions = scheduler.tick(momentFrom(new Date(), clock()))
    for (const action of actions) {
      try {
        applyScheduled(action)
      } catch (error) {
        lastError = `zamanlama: ${describe(error)}`
      }
    }
    if (actions.length > 0) report()
  }

  function stopClocks (): void {
    if (tickTimer !== null) clearInterval(tickTimer)
    if (reportTimer !== null) clearInterval(reportTimer)
    if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    tickTimer = null
    reportTimer = null
    reconnectTimer = null
  }

  /**
   * One black frame so the strip does not hold the last picture.
   *
   * Through the same sink as every other frame, and for every real link rather
   * than only a serial one: a WLED left on the last frame is just as stuck.
   */
  function blackout (): void {
    if (linkMode === 'none' || linkMode === 'loopback') return
    // Its own buffer: the pipeline's target is overwritten by the next frame,
    // and this frame may have to wait for the writer.
    const black = allocLedColors(stages.leds)
    // AFTER the black frame has gone, never before it: a device that is handed
    // back first and then painted black is frozen black - the one state worse
    // than holding the last picture.
    const handBack = (): void => {
      if (state !== 'running') void sink.release?.().catch(() => { /* the link will say */ })
    }
    // The writer is latest-wins and DROPS a frame while a send is in flight,
    // which on a Stop is exactly when the previous frame is still being
    // written - so the black frame was lost and the strip held the last
    // picture. Wait for the writer instead, and still only send if nothing has
    // started again in the meantime.
    if (writer.send(black)) {
      void writer.idle().then(handBack)
      return
    }
    void writer.idle().then(() => {
      if (state === 'running') return
      writer.send(black)
      void writer.idle().then(handBack)
    })
  }

  /** Starts the shared clocks if they are not already running. */
  function startClocks (): void {
    tickTimer ??= setInterval(tick, TICK_MS)
    reportTimer ??= setInterval(report, REPORT_MS)
  }

  /** Everything both sources share: start the clocks, the link and the pump. */
  async function begin (open: () => Promise<FrameSource>): Promise<void> {
    // Only the CAPTURE layer is replaced: an effect or a visualiser running
    // above it keeps running, and is what the strip goes on showing until it
    // is stopped - and it is not put through idle on the way, so restarting
    // the capture over a running effect neither blacks the strip nor replays
    // the startup layer.
    stopCapture(false, false)
    const gen = ++captureGen
    // "Starting" is only a state of the whole engine when nothing else is
    // showing. With an effect live the engine IS running, and calling it
    // starting would have enterRunning() treat the capture as an idle edge.
    if (muxer.sources().length === 0) state = 'starting'
    lastError = undefined
    captureLost = false
    report()
    try {
      const next = await open()
      // A Stop, a lost capture or a strip removed by the pool while the picker
      // was up: the answer arrived for a capture nobody wants any more.
      if (gen !== captureGen) {
        void next.stop().catch(() => { /* already gone */ })
        return
      }
      source = next
      sourceKind = next.kind
      resetCounters()
      sizeBuffers(stages.leds)
      // The capture layer exists from the moment the source is open, not from
      // its first frame: registered without input, the muxer lists it and does
      // not choose it, which is the state between the picker closing and the
      // first frame arriving. Left unregistered, the very first output tick
      // found no layers at all and put the engine back to idle before a frame
      // could arrive - measured on both hosts.
      if (!muxer.has(PRIORITY.capture)) muxer.register(PRIORITY.capture, { component: 'capture' })
      enterRunning()
      startClocks()
      void connectLink()
      next.start(onFrame, (error) => {
        // An ended source is the stream dying under us - a resolution change,
        // an HDR toggle, the monitor sleeping, or the browser's own "stop
        // sharing" - and all of those are the same event from here. Unless it
        // is an OLD source ending late, after a restart replaced it: that one
        // must not stop the capture that took its place.
        if (source !== next) return
        if (error !== undefined) lastError = describe(error)
        stopCapture(true)
      })
      report()
    } catch (error) {
      lastError = describe(error)
      if (gen !== captureGen) return
      // A refused picker must not take a running effect down with it - the
      // same rule runAudio already follows. Only with nothing else live is the
      // whole engine in error, and then it is also stopped like a stop.
      if (muxer.sources().length > 0) {
        state = 'running'
      } else {
        stopClocks()
        state = 'error'
        blackout()
      }
      report()
    }
  }

  /** Stops EVERYTHING. The panel's Stop button, and nothing else. */
  function stop (reason: StopReason = 'user'): void {
    if (reason === 'lost') captureLost = true
    captureGen++
    stopClocks()
    if (patternTimer !== null) clearInterval(patternTimer)
    if (effectTimer !== null) clearInterval(effectTimer)
    if (audioTimer !== null) clearInterval(audioTimer)
    patternTimer = null
    effectTimer = null
    audioTimer = null
    pattern = null
    patternSpec = null
    effect = null
    effectSpec = null
    baseColor = null
    flashColor = null
    visualiser = null
    audioSpec = null
    const a = audio
    audio = null
    void a?.stop().catch(() => { /* already gone */ })
    const s = source
    source = null
    sourceKind = undefined
    void s?.stop().catch(() => { /* already gone */ })
    // The background goes too: it belongs to "running", not to "idle". A strip
    // still glowing after the user pressed Stop is a strip that ignored them.
    backgroundEffect = null
    startupEffect = null
    startupUntil = null
    idleEffectTimer()
    muxer.clearAll()
    muxer.clear(BACKGROUND_PRIORITY)
    if (state !== 'error') state = 'idle'
    blackout()
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
      sampling: { mode: stages.config.sampling.mode, warnings: [...stages.sampler.warnings] },
      link: {
        mode: linkMode,
        // The sink's own word for what it is doing. A network link spends real
        // time connecting and can drop at any moment, and "nothing is lighting
        // up" has to be distinguishable from "still dialling" on the panel.
        state: sink.state(),
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
      ...(effect !== null ? { effect: effect.kind } : {}),
      ...(visualiser !== null
        ? { audio: { kind: visualiser.kind, input: audio?.kind ?? 'microphone', level: visualiser.level() } }
        : {}),
      layers: describeLayers(),
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

  /**
   * The layer list for the panel, winner marked.
   *
   * Reported rather than inferred from `pattern`/`effect`/`audio` being set:
   * which one the strip is actually showing is the muxer's decision and only
   * the muxer knows it, and a panel that worked it out separately would
   * disagree with the strip exactly when it mattered.
   */
  function describeLayers (): Array<{ priority: number, component: string, active: boolean, winning: boolean }> {
    const won = muxer.current()
    return muxer.sources().map((info: SourceInfo) => ({
      priority: info.priority,
      component: String(info.component),
      active: info.active,
      winning: won !== null && won.priority === info.priority
    }))
  }

  function report (): void {
    host.onReport?.(snapshot(), state)
  }

  const api: Engine = {
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
      if (ledsChanged) {
        // Every layer buffer is the old size and the muxer holds references to
        // them. The animated layers render into fresh buffers on their next
        // frame; the static ones - a colour, a flash, a flat startup - have to
        // be re-fed by hand, or the strip goes on reading a frame the new
        // encoder rejects on every tick with nothing telling the user.
        sizeBuffers(next.leds)
        if (baseColor !== null && muxer.has(PRIORITY.color)) {
          fillLinear(colorTarget, baseColor)
          muxer.setInput(PRIORITY.color, { kind: 'colors', colors: colorTarget })
        }
        if (flashColor !== null && muxer.has(PRIORITY.flash)) {
          fillLinear(flashTarget, flashColor)
          muxer.setInput(PRIORITY.flash, { kind: 'colors', colors: flashTarget })
        }
        if (startupUntil !== null && startupEffect === null && next.config.startup.kind === 'color') {
          fillLinear(startupTarget, next.config.startup.color)
          muxer.setInput(HIGHEST_PRIORITY, { kind: 'colors', colors: startupTarget })
        }
        // A pattern is built for a LED count, not a geometry.
        if (pattern !== null && patternSpec !== null) pattern = createPattern(parsePatternSpec(patternSpec), next.leds, clock)
      }
      // A running effect holds the geometry it was built with, so a layout edit
      // would otherwise leave it drawing the old rig onto the new one.
      if (effectSpec !== null) effect = createEffect(parseEffectSpec(effectSpec), next.geometry, clock)
      // The visualiser holds the geometry AND the band layout, so a layout edit
      // has to rebuild it as well or the spectrum keeps drawing the old rig.
      if (visualiser !== null && audio !== null) {
        visualiser = createVisualiser({
          // With the gain, colour and decay it was given, not the defaults: a
          // layout edit on another page used to snap a dim red visualiser to
          // full-bright blue.
          spec: audioSpec ?? parseAudioSpec({ kind: visualiser.kind }),
          geometry: next.geometry,
          sampleRate: audio.sampleRate,
          binCount: audio.binCount,
          outputHz: OUTPUT_HZ
        })
      }
      // The background is a configured layer, so a configuration change is the
      // only way it ever turns on or off. Rebuilt rather than left alone for
      // the same reason the effect is: it holds the geometry it was made with.
      applyBackground()
      return config
    },

    async start (): Promise<void> {
      await begin(async () => await host.openSource(stages.config))
    },

    async selfTest (): Promise<void> {
      const open = host.openSelfTest
      if (open === undefined) {
        // Reported, not imposed: an effect that is showing keeps showing.
        state = muxer.sources().length > 0 ? 'running' : 'error'
        lastError = TEXT.noSelfTest
        report()
        return
      }
      await begin(async () => await open(stages.config))
    },

    /**
     * Starts an effect.
     *
     * Deliberately NOT `begin()`: there is no capture, no source and no pump.
     * The effect renders into the same target the sampler would fill, on its
     * own timer, and everything downstream is unchanged.
     */
    runEffect (spec: unknown): void {
      const parsed = parseEffectSpec(spec)
      // Replaces the EFFECT layer and nothing else. A capture underneath keeps
      // running and is what comes back when this is stopped - and the engine
      // is not put through idle on the way, so one effect follows another
      // without a black frame or a second boot animation.
      stopEffect(false)
      lastError = undefined
      effectSpec = parsed
      sizeBuffers(stages.leds)
      effect = createEffect(parsed, stages.geometry, clock)
      enterRunning()
      void connectLink()
      // The smoother paces the output; this timer only has to keep the target
      // moving, so it runs at the output rate and no faster. Shared with the
      // background and startup layers, so it is claimed rather than created.
      ensureEffectTimer()
      startClocks()
      emitEffect()
      report()
    },

    /**
     * Starts an audio visualiser.
     *
     * Asynchronous where the effects are not, because opening an input means a
     * permission prompt - and a refusal is a decision the user made, reported
     * as a sentence rather than left as a strip that never lights.
     */
    async runAudio (spec: unknown, input: AudioInputKind = 'microphone'): Promise<void> {
      const parsed = parseAudioSpec(spec)
      lastError = undefined
      // The same input, already open: retune the visualiser on it and leave the
      // source alone. Reopening meant a new picker on every slider step for
      // tab audio - getDisplayMedia never remembers a grant - and a new
      // permission prompt on some browsers for the microphone.
      if (audio !== null && audio.kind === input) {
        audioSpec = parsed
        visualiser = createVisualiser({
          spec: parsed,
          geometry: stages.geometry,
          sampleRate: audio.sampleRate,
          binCount: audio.binCount,
          outputHz: OUTPUT_HZ
        })
        report()
        return
      }
      stopAudio(false)
      if (state === 'idle') state = 'starting'
      report()
      try {
        const opened = input === 'display' ? await openDisplayAudio() : await openMicrophone()
        audio = opened
        audioSpec = parsed
        bins = new Float32Array(opened.binCount)
        sizeBuffers(stages.leds)
        visualiser = createVisualiser({
          spec: parsed,
          geometry: stages.geometry,
          sampleRate: opened.sampleRate,
          binCount: opened.binCount,
          outputHz: OUTPUT_HZ
        })
        enterRunning()
        void connectLink()
        audioTimer = setInterval(emitAudio, Math.round(1000 / OUTPUT_HZ))
        startClocks()
        emitAudio()
      } catch (error) {
        // A refused microphone must not take a running capture down with it.
        state = muxer.sources().length > 0 ? 'running' : 'error'
        lastError = describe(error)
      }
      report()
    },

    runPattern (spec: unknown): void {
      const parsed = parsePatternSpec(spec)
      // A pattern OUTRANKS content: it is a measurement, and whatever was
      // showing has to get out of the way of it completely. What it does not do
      // is stop anything - the capture or effect underneath is still there when
      // the pattern is cleared, which is what makes the calibration wizard
      // usable without losing the screen the user picked.
      stopPattern(false)
      lastError = undefined
      sizeBuffers(stages.leds)
      patternSpec = parsed
      pattern = createPattern(parsed, stages.leds, clock)
      enterRunning()
      void connectLink()
      patternTimer = setInterval(emitPattern, Math.round(1000 / OUTPUT_HZ))
      startClocks()
      emitPattern()
      report()
    },

    stop,
    clearLayer,

    /**
     * A solid colour, at the highest content priority.
     *
     * `durationMs` is what makes this more than a colour picker: "red for ten
     * seconds, then back to whatever was showing" is one call, and the muxer
     * drops the layer on its own when the time is up. Nothing underneath is
     * touched.
     */
    setSchedule (rules: unknown): ScheduleRule[] {
      const parsed = parseRules(rules)
      scheduler.setRules(parsed)
      if (parsed.length === 0) {
        if (scheduleTimer !== null) {
          clearInterval(scheduleTimer)
          scheduleTimer = null
        }
      } else {
        // Started on the first rule and never stopped while any remain: the
        // whole point is that it fires with the engine idle.
        scheduleTimer ??= setInterval(runSchedule, 1000)
        runSchedule()
      }
      return scheduler.rules()
    },

    schedule: () => scheduler.rules(),

    setColor (color: { r: number, g: number, b: number }, durationMs?: number): void {
      // Timed means "interrupt"; untimed means "this is the base". The caller
      // does not choose a priority, because the difference is already in what
      // they asked for.
      const priority = durationMs === undefined ? PRIORITY.color : PRIORITY.flash
      sizeBuffers(stages.leds)
      const clamped = { r: clampByte(color.r), g: clampByte(color.g), b: clampByte(color.b) }
      // Each in its own buffer and remembered: the two are live together, and
      // a layout edit has to be able to hand the muxer both again.
      const into = durationMs === undefined ? colorTarget : flashTarget
      if (durationMs === undefined) baseColor = clamped
      else flashColor = clamped
      fillLinear(into, clamped)
      muxer.clear(priority)
      muxer.register(priority, {
        component: durationMs === undefined ? 'color' : 'flash',
        ...(durationMs !== undefined ? { durationMs } : {})
      })
      muxer.setInput(priority, { kind: 'colors', colors: into })
      enterRunning()
      void connectLink()
      startClocks()
      tick()
      report()
    },

    async relink (): Promise<void> {
      // The loopback first, so no output tick writes to a port that is being
      // closed: that write rejected, stamped a "seri port" error, and the
      // sentence stayed on the panel after the relink had succeeded.
      useLoopback()
      await closePort()
      await connectLink()
    },

    sendControl
  }

  return api
}

/**
 * Whether this document is secure and the URL is not. `location` is a global
 * only in a document; the offscreen document's is `chrome-extension:`, which
 * the mixed-content rule does not apply to, and Node has none.
 */
function isMixedContent (url: string): boolean {
  const protocol = (globalThis as { location?: { protocol?: string } }).location?.protocol
  return protocol === 'https:' && url.startsWith('ws://')
}

function clampByte (value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(255, Math.max(0, Math.round(value)))
}

function describe (error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  // DOMException carries the useful half in `name`; the message alone reads the
  // same whatever actually went wrong.
  return error.name === '' || error.name === 'Error' ? error.message : `${error.name}: ${error.message}`
}
