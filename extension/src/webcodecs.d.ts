/**
 * MediaStreamTrackProcessor is shipped in Chromium (since 94) but is not in
 * TypeScript's lib.dom, which tracks the standard rather than Chrome. This is
 * the subset the engine uses, declared for the extension build only.
 *
 * Measured on Chromium 141 (docs/hyperion-port-plan.md section 2a): present
 * in `window`, absent in a DedicatedWorker. That absence is why the engine
 * lives in the offscreen document at all.
 */

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack
  /** Frames the processor may hold before it starts dropping the oldest. */
  maxBufferSize?: number
}

interface MediaStreamTrackProcessor {
  readonly readable: ReadableStream<VideoFrame>
}

declare var MediaStreamTrackProcessor: {
  prototype: MediaStreamTrackProcessor
  new (init: MediaStreamTrackProcessorInit): MediaStreamTrackProcessor
}
