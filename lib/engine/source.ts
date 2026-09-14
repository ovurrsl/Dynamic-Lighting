/**
 * Where frames come from.
 *
 * This is the one place the platforms genuinely diverge, and pulling it out is
 * what lets the same engine run in two different hosts.
 *
 * The engine has lived in a Chrome extension's offscreen document since it was
 * written, for a reason that was measured rather than assumed: a hidden tab is
 * throttled and an offscreen document is never rendered, so it is never hidden.
 * That reasoning still holds - on Chromium. Everywhere else there is no
 * extension at all, and "the engine only exists in a Chrome extension" means
 * Safari, Firefox and iOS get a colour picker and nothing else. An iPhone can
 * capture its screen (measured, against a compatibility table that says it
 * cannot) and, with the network drivers, can now reach a strip - so the only
 * thing left between an iPhone and a working ambilight is that the engine has
 * nowhere to run there.
 *
 * Two sources, one interface:
 *
 * - `createStreamSource` is `MediaStreamTrackProcessor`: a stream of
 *   `VideoFrame`s, pushed as the source produces them. Chromium only - measured
 *   in `window` and NOT in a dedicated worker, whatever MDN says - and it is
 *   what the extension uses.
 * - `createVideoSource` is a `<video>` element, read either through
 *   `requestVideoFrameCallback` or, failing that, a plain timer. Available
 *   everywhere a browser can capture at all, and therefore the route for every
 *   host that is not the extension.
 *
 * Both hand the pipeline something `createImageBitmap` accepts together with a
 * size, so the single downscale - the measured area average - is identical on
 * both paths. That is the point: the difference between the platforms ends
 * here, at the first stage, instead of running through the whole engine.
 *
 * Nothing in this file touches a global it was not given. The track, the video
 * element, the clock and the timers are all injected, so both sources are
 * exercised in Node against fakes - including the paths that only happen on a
 * real desk, like a track that ends mid-session.
 */

/** What the source produces. Whoever receives it owns it and must release it. */
export interface SourceFrame {
  /**
   * Anything `createImageBitmap` accepts: a `VideoFrame` on the stream route, a
   * `<video>` element on the other. The pipeline does not care which.
   */
  readonly image: unknown
  readonly width: number
  readonly height: number
  /**
   * Releases it. Exactly once, and always - a `VideoFrame` that is not closed
   * stalls the whole stream once the source's small pool runs out, which shows
   * up as a capture that simply stops after a few dozen frames.
   */
  release: () => void
}

export type SourceKind = 'stream' | 'video-callback' | 'video-timer'

export type FrameHandler = (frame: SourceFrame, at: number) => void

export interface FrameSource {
  readonly kind: SourceKind
  /** Starts delivering. Calling it twice is the caller's bug, not handled here. */
  start: (onFrame: FrameHandler, onEnd?: (error?: unknown) => void) => void
  stop: () => Promise<void>
  /**
   * What the track reports about itself.
   *
   * Worth showing rather than assuming: `frameRate` here is what the BROWSER
   * agreed to, which is routinely not what it delivers - which is why the
   * panel counts arrivals instead of trusting this number, and shows both.
   */
  settings: () => { width?: number, height?: number, frameRate?: number }
}

/** The subset of `MediaStreamTrack` these sources use. */
export interface SourceTrack {
  readonly readyState?: string
  stop: () => void
  getSettings?: () => { width?: number, height?: number, frameRate?: number }
}

// ---------------------------------------------------------------------------
// The stream route: MediaStreamTrackProcessor.
// ---------------------------------------------------------------------------

/** What a `VideoFrame` gives us. Named here so this file needs no DOM lib. */
export interface StreamFrame {
  readonly displayWidth: number
  readonly displayHeight: number
  close: () => void
}

export interface StreamReader {
  read: () => Promise<{ value?: StreamFrame, done: boolean }>
  cancel: () => Promise<void>
  releaseLock: () => void
}

export type ProcessorFactory = (track: SourceTrack) => { readable: { getReader: () => StreamReader } }

export interface StreamSourceOptions {
  track: SourceTrack
  clock: () => number
  /** Injected; defaults to the browser's own `MediaStreamTrackProcessor`. */
  processor?: ProcessorFactory
}

function defaultProcessor (track: SourceTrack): { readable: { getReader: () => StreamReader } } {
  const ctor = (globalThis as {
    MediaStreamTrackProcessor?: new (init: { track: unknown, maxBufferSize: number }) => {
      readable: { getReader: () => StreamReader }
    }
  }).MediaStreamTrackProcessor
  if (ctor === undefined) throw new Error('source: this browser has no MediaStreamTrackProcessor')
  // maxBufferSize 1: the stream holds at most one frame for us and the source
  // drops older ones itself. Anything that still arrives while the pipeline is
  // busy is dropped downstream and counted there.
  return new ctor({ track, maxBufferSize: 1 })
}

export function createStreamSource (options: StreamSourceOptions): FrameSource {
  const { track, clock } = options
  const makeProcessor = options.processor ?? defaultProcessor
  let reader: StreamReader | null = null
  let stopped = false

  return {
    kind: 'stream',
    settings: () => track.getSettings?.() ?? {},
    start (onFrame, onEnd): void {
      let r: StreamReader
      try {
        r = makeProcessor(track).readable.getReader()
      } catch (error) {
        onEnd?.(error)
        return
      }
      reader = r
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await r.read()
            if (done || value === undefined) break
            onFrame({
              image: value,
              width: value.displayWidth,
              height: value.displayHeight,
              release: () => { value.close() }
            }, clock())
          }
          if (!stopped) onEnd?.()
        } catch (error) {
          if (!stopped) onEnd?.(error)
        } finally {
          if (reader === r) reader = null
          try { r.releaseLock() } catch { /* already cancelled */ }
        }
      })()
    },
    async stop (): Promise<void> {
      stopped = true
      const r = reader
      reader = null
      try { await r?.cancel() } catch { /* already closed */ }
      track.stop()
    }
  }
}

// ---------------------------------------------------------------------------
// The video route: a <video> element, everywhere else.
// ---------------------------------------------------------------------------

/** The subset of `HTMLVideoElement` this uses. A real one satisfies it. */
export interface VideoElement {
  srcObject: unknown
  readonly videoWidth: number
  readonly videoHeight: number
  muted: boolean
  playsInline?: boolean
  play: () => Promise<void>
  pause?: () => void
  requestVideoFrameCallback?: (callback: (now: number) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

export interface VideoSourceOptions {
  /** The stream to attach. Kept whole: a `<video>` wants a stream, not a track. */
  stream: unknown
  track: SourceTrack
  video: VideoElement
  clock: () => number
  /** Fallback cadence when there is no `requestVideoFrameCallback`, in frames a second. */
  fps: number
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
  /**
   * Forces the timer route even where the callback exists. For measuring one
   * against the other on a real machine, which is the only place the answer is.
   */
  preferTimer?: boolean
}

/**
 * Reads frames from a `<video>`.
 *
 * `requestVideoFrameCallback` where it exists, because it fires once per frame
 * the video actually produced - which for a screen capture means once per
 * CHANGE, so a still screen costs nothing. A timer instead would re-read the
 * same picture sixty times a second and spend the whole pipeline on it.
 *
 * Where it does not exist (Firefox, at the time of writing) a timer stands in,
 * and the cost above is real rather than theoretical: it is the honest reason
 * this route reports its kind, so the panel can say which one is running
 * instead of claiming one number for every browser.
 *
 * **The limitation nobody should have to discover for themselves:** both of
 * these stop when the tab is hidden or minimised. That is exactly the
 * throttling the extension exists to escape, and no arrangement of timers gets
 * around it in a page. A page host is therefore honest for a phone, a second
 * machine, or a browser with no extension - and the extension is still the
 * right answer on a Chromium desktop where the user wants to play a game.
 */
export function createVideoSource (options: VideoSourceOptions): FrameSource {
  const { video, track, clock } = options
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const cancel = options.cancel ?? ((handle: unknown) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  const useCallback = options.preferTimer !== true && typeof video.requestVideoFrameCallback === 'function'
  const periodMs = Math.max(1, Math.round(1000 / Math.max(1, options.fps)))

  let stopped = false
  let timer: unknown = null
  let rvfc: number | null = null

  /**
   * A `<video>` needs no release, but the frame contract says every frame is
   * released exactly once - so this is a no-op rather than an optional call.
   * Making the caller branch on the source kind is how a VideoFrame leak gets
   * written on the other route.
   */
  const noRelease = (): void => { /* a <video> owns its own picture */ }

  const deliver = (onFrame: FrameHandler): boolean => {
    const width = video.videoWidth
    const height = video.videoHeight
    // Zero until the first frame has arrived, and `drawImage`/`createImageBitmap`
    // throw on a source that size rather than drawing nothing.
    if (width === 0 || height === 0) return false
    onFrame({ image: video, width, height, release: noRelease }, clock())
    return true
  }

  return {
    kind: useCallback ? 'video-callback' : 'video-timer',
    settings: () => track.getSettings?.() ?? {},
    start (onFrame, onEnd): void {
      video.srcObject = options.stream
      video.muted = true
      video.playsInline = true
      void video.play().catch((error: unknown) => { if (!stopped) onEnd?.(error) })

      if (useCallback) {
        const pump = (): void => {
          if (stopped) return
          deliver(onFrame)
          // Re-armed AFTER the frame is handled: arming first would queue a
          // second callback behind a slow frame and the drops would be counted
          // as the pipeline's rather than as the source outrunning it.
          rvfc = video.requestVideoFrameCallback?.(pump) ?? null
        }
        rvfc = video.requestVideoFrameCallback?.(pump) ?? null
        return
      }

      const beat = (): void => {
        if (stopped) return
        deliver(onFrame)
        timer = schedule(beat, periodMs)
      }
      timer = schedule(beat, periodMs)
    },
    async stop (): Promise<void> {
      stopped = true
      if (timer !== null) {
        cancel(timer)
        timer = null
      }
      if (rvfc !== null) {
        video.cancelVideoFrameCallback?.(rvfc)
        rvfc = null
      }
      video.pause?.()
      video.srcObject = null
      track.stop()
    }
  }
}

/**
 * Whether this runtime has the stream route.
 *
 * Asked of the browser rather than read from a table - the tables have been
 * wrong about this project three times, each time in a way that changed the
 * design.
 */
export function hasStreamSource (scope: unknown = globalThis): boolean {
  return typeof (scope as { MediaStreamTrackProcessor?: unknown })?.MediaStreamTrackProcessor === 'function'
}
