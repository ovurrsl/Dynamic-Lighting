import type { EngineConfig } from '#lib/engine/config'

/**
 * Every message that crosses a boundary in the extension, as one discriminated
 * union. Three boundaries exist and they are not interchangeable:
 *
 *   page  -> sw         chrome.runtime.sendMessage(EXTENSION_ID, msg)  (externally_connectable)
 *   popup -> sw         chrome.runtime.sendMessage(msg)
 *   sw   <-> offscreen  chrome.runtime.sendMessage(msg) with a `target` field
 *
 * The `target` field exists because the service worker and the offscreen
 * document share one runtime message bus; without it each would answer the
 * other's traffic.
 *
 * This file lives under lib/ rather than extension/ because the panel reads
 * the same types: it is the one contract both sides compile against.
 */

export type Target = 'sw' | 'offscreen'

export type Message =
  | { type: 'ambiflux/ping'; target: Target }
  | { type: 'ambiflux/pong'; version: string; engine: EngineState }
  /**
   * Capture start. Carries nothing: the engine document opens the screen picker
   * itself with `getDisplayMedia`, which is the only thing that works there.
   * An earlier version passed a `chrome.desktopCapture` streamId chosen in the
   * popup; such an id is bound to the context that asked for it and fails in
   * the offscreen document with `AbortError` (see offscreen.ts openCapture).
   */
  | { type: 'ambiflux/start'; target: Target }
  | { type: 'ambiflux/stop'; target: Target }
  /**
   * Build the engine document NOW, before anything needs it.
   *
   * Creating the offscreen document is not instant, and it is the thing that
   * opens the screen picker - so building it when the popup opens means Start
   * shows the picker at once rather than after a document boot.
   */
  | { type: 'ambiflux/prepare'; target: Target }
  /**
   * Runs the engine on a generated picture instead of the screen.
   *
   * The bench run: it proves the pipeline with no screen, no picker and no
   * board, and it is the only way to tell "the engine is broken" apart from
   * "the capture never started" - which look identical from outside.
   */
  | { type: 'ambiflux/selftest'; target: Target }
  /**
   * Drives the strip from a generated pattern instead of the screen.
   *
   * The bench run, and the thing both calibration wizards are built on: the
   * walk lights one LED at a known index so corners can be clicked, and a solid
   * pure channel is what the channel-order wizard asks the user to name.
   *
   * `spec` is UNVALIDATED here on purpose - it crosses from the panel, which is
   * a separately installed program of a possibly different version - so the
   * engine parses it with `parsePatternSpec` and answers with the error.
   */
  | { type: 'ambiflux/pattern'; target: Target; spec: unknown }
  /** Asks the worker for the engine's state and its latest statistics. */
  | { type: 'ambiflux/status'; target: Target }
  | { type: 'ambiflux/status-reply'; version: string; state: EngineState; stats: EngineStats | null }
  /**
   * The popup paired a serial port (navigator.serial.requestPort needs a
   * gesture); the engine should look again with getPorts() and connect.
   */
  | { type: 'ambiflux/serial'; target: Target }
  /**
   * Replaces the engine's configuration - the layout, the blacklist, the
   * channel order. `config` is UNVALIDATED here on purpose: it arrives from
   * the panel or from chrome.storage, so the worker parses it with
   * parseEngineConfig and answers with the error rather than trusting it.
   */
  | { type: 'ambiflux/config'; target: Target; config: unknown }
  /** Asks for the configuration in force. */
  | { type: 'ambiflux/config-get'; target: Target }
  | { type: 'ambiflux/config-reply'; config: EngineConfig | null; error?: string }
  /** Offscreen -> worker: the latest statistics, kept for whoever asks next. */
  | { type: 'ambiflux/stats'; target: Target; stats: EngineStats }
  | { type: 'ambiflux/state'; target: Target; state: EngineState }

export type EngineState = 'idle' | 'starting' | 'running' | 'error'

/** How frames leave the engine. */
export type LinkMode = 'none' | 'loopback' | 'port'

/**
 * Separate counters, because the stages fail in different ways and a single
 * "FPS" would hide which one:
 *
 * - captureGaps: inter-arrival gaps in the frames the source delivered.
 * - pipelineDrops: frames that arrived while the previous one was still being
 *   processed (latest wins; the processing never queues).
 * - link.dropped: frames dropped because a serial write was still in flight
 *   (latest wins; the link never queues).
 * - link.rejected: frames the loopback's reference parser refused - a framing
 *   bug, so healthy is exactly 0.
 *
 * The firmware's own framesRx - framesShown comes back over the serial
 * feedback channel later.
 */
export interface EngineStats {
  state: EngineState
  /** LEDs the configured layout describes, so the panel can show what it is driving. */
  leds: number
  /** Frames the capture delivered since start. */
  capturedFrames: number
  /** Delivered capture rate over the last two seconds; count-based, never getSettings(). */
  deliveredFps: number
  /** Percentiles of the capture inter-arrival, ms; the mean would hide the stalls. */
  interArrivalMs: { p50: number; p99: number; max: number }
  captureGaps: number
  pipelineDrops: number
  /** Time from frame arrival to smoother target, ms. */
  processMs: { p50: number; p99: number; max: number }
  /**
   * Where that time goes, median per stage, ms.
   *
   * The whole of `processMs` was one number, and at 1080p its p50 sat at 9.00 ms
   * against an 8.33 ms budget - which says there is a problem and nothing about
   * where. The plan's own first instruction for this is "measure where it goes,
   * do not guess", and the guess (the downscale) is only a guess: the readback
   * off the GPU is a candidate too, and so is the decode.
   *
   * Optional because an older extension answers without it. The panel is a
   * hosted page and the extension is installed separately, so they are always
   * two different versions of two different programs.
   */
  stageMs?: {
    /** createImageBitmap: the area-average downscale, on the GPU. */
    downscale: number
    /** drawImage + getImageData: pulling the small grid back to the CPU. */
    readback: number
    /** sRGB -> linear, over the whole grid. */
    decode: number
    /** Border detect, sample, adjust, hand to the smoother. */
    sample: number
  }
  /** Frames the smoother emitted per second over the last two seconds. */
  outputFps: number
  link: {
    mode: LinkMode
    /** Frames whose write resolved. */
    written: number
    dropped: number
    errors: number
    /** Loopback only: frames the reference parser accepted / refused. */
    accepted: number
    rejected: number
    /** `usbVendorId:usbProductId` in hex when a port is open. */
    port?: string
  }
  /**
   * The test pattern running, if one is. Distinct from `state`, which only says
   * the engine is producing frames: a strip lit by the walk and a strip
   * following the screen are both "running", and confusing them would have the
   * panel claim a capture that is not happening.
   */
  pattern?: string
  /** The black-border inset currently applied, in grid pixels. */
  border: { unknown: boolean; topBottom: number; leftRight: number }
  /** Capture source size as the track reports it. */
  source?: { width: number; height: number; frameRate?: number }
  /**
   * The capture ended on its own rather than being stopped.
   *
   * A resolution change, a refresh-rate change, toggling HDR, or the monitor
   * sleeping all end the stream, and on a real desk at least one of those
   * happens every day. It is not an error and must not be shown as one - but it
   * is also not the same as "idle", because the user did not ask for it and
   * their strip just went dark. It is the reason the panel can offer one click
   * to pick the screen again.
   */
  lost?: boolean
  error?: string
}

export function isMessage (value: unknown): value is Message {
  return typeof value === 'object' && value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    (value as { type: string }).type.startsWith('ambiflux/')
}
