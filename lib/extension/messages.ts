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
   * Capture start. `streamId` comes from chrome.desktopCapture.chooseDesktopMedia,
   * which must be called from a page WITH a user gesture (the popup). The
   * offscreen document has no gesture and cannot show a picker itself; it can
   * only consume a streamId handed to it. The id is single-use and expires in
   * seconds, so this message is sent the moment the picker returns.
   */
  | { type: 'ambiflux/start'; target: Target; streamId: string }
  | { type: 'ambiflux/stop'; target: Target }
  /** Asks the worker for the engine's state and its latest statistics. */
  | { type: 'ambiflux/status'; target: Target }
  | { type: 'ambiflux/status-reply'; version: string; state: EngineState; stats: EngineStats | null }
  /**
   * The popup paired a serial port (navigator.serial.requestPort needs a
   * gesture); the engine should look again with getPorts() and connect.
   */
  | { type: 'ambiflux/serial'; target: Target }
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
  /** The black-border inset currently applied, in grid pixels. */
  border: { unknown: boolean; topBottom: number; leftRight: number }
  /** Capture source size as the track reports it. */
  source?: { width: number; height: number; frameRate?: number }
  error?: string
}

export function isMessage (value: unknown): value is Message {
  return typeof value === 'object' && value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    (value as { type: string }).type.startsWith('ambiflux/')
}
