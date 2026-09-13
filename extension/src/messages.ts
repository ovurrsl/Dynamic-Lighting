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
  | { type: 'ambiflux/stats'; target: Target; stats: EngineStats }
  | { type: 'ambiflux/state'; target: Target; state: EngineState }

export type EngineState = 'idle' | 'starting' | 'running' | 'error'

/**
 * Four separate counters, because the stages fail in different ways and a
 * single "FPS" would hide which one. captureGaps: frames the source never
 * delivered. pipelineDrops: frames that arrived while the previous one was
 * still being processed. serialDrops: frames dropped because a write was still
 * in flight (latest-wins, never queue). The firmware's own framesRx-framesShown
 * comes back over the serial feedback channel later.
 */
export interface EngineStats {
  state: EngineState
  capturedFrames: number
  deliveredFps: number
  captureGaps: number
  pipelineDrops: number
  serialDrops: number
  /** p50 / p99 inter-arrival in ms; the mean would hide the stalls. */
  interArrivalMs: { p50: number; p99: number }
  serialConnected: boolean
  error?: string
}

export function isMessage (value: unknown): value is Message {
  return typeof value === 'object' && value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    (value as { type: string }).type.startsWith('ambiflux/')
}
