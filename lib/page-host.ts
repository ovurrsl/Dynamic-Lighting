import type { EngineConfig } from '#lib/engine/config'
import { createEngine, type CanvasLike, type Engine, type EngineHost } from '#lib/engine/runtime'
import {
  createStreamSource,
  createVideoSource,
  hasStreamSource,
  type FrameSource,
  type VideoElement
} from '#lib/engine/source'
import type { EngineState, EngineStats } from '#lib/extension/messages'

/**
 * The engine, running in the panel page itself.
 *
 * The second host. The extension's offscreen document is still the better one
 * on a Chromium desktop and this does not replace it - it is what exists
 * everywhere the extension cannot:
 *
 * - **iOS.** There is no extension, and there is no Web Serial, WebUSB, WebHID
 *   or Web Bluetooth either - all four are Chromium-only and Apple requires
 *   WebKit. An iPhone can capture its screen (measured, against a compatibility
 *   table that says it cannot) and, since the network drivers, can reach a
 *   strip over WiFi. This is the piece that was missing in between.
 * - **Safari and Firefox on a desktop**, for the same reason minus the phone.
 * - **Trying the application before installing anything**, which is worth more
 *   than it sounds for a project whose first screen used to be a dead card.
 *
 * THE LIMITATION, stated plainly because the user must not discover it during a
 * film: a page is throttled when its tab is hidden or minimised. Timers slow
 * to once a minute and frame callbacks stop. There is no arrangement of timers
 * that escapes this - it is the entire reason the engine went into an extension
 * in the first place. So a page host is honest for a phone propped beside a
 * screen, a second machine, or a browser with no extension; it is not honest
 * for someone playing a full-screen game on one monitor.
 *
 * The panel says so rather than letting the counters say it silently an hour
 * later.
 */

/** A 1x1 transparent element, NOT `display: none`. */
const VIDEO_STYLE = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'

export interface PageEngine {
  engine: Engine
  /** Stops the engine and takes the hidden video element back out of the page. */
  dispose: () => void
}

/**
 * Builds the page's host.
 *
 * `onReport` is how the numbers reach React: the engine pushes on its own
 * cadence, exactly as the extension pushes to the worker, so the panel never
 * polls itself.
 */
export function createPageEngine (onReport: (stats: EngineStats, state: EngineState) => void): PageEngine {
  let video: HTMLVideoElement | null = null
  let selfTestTimer: ReturnType<typeof setInterval> | null = null

  /**
   * One hidden `<video>`, reused.
   *
   * In the document rather than detached, and sized 1x1 at zero opacity rather
   * than `display: none`: a video that is not displayed is allowed to stop
   * producing frames, and on iOS an element outside the document may not play
   * at all. Both would show up as a capture that starts and delivers nothing.
   */
  function element (): VideoElement {
    if (video === null) {
      video = document.createElement('video')
      video.setAttribute('style', VIDEO_STYLE)
      video.muted = true
      video.playsInline = true
      document.body.appendChild(video)
    }
    return video as unknown as VideoElement
  }

  async function sourceFor (stream: MediaStream, config: EngineConfig): Promise<FrameSource> {
    const track = stream.getVideoTracks()[0]
    if (track === undefined) throw new Error('yakalama video izi vermedi')
    // The stream route where the browser has it - it delivers a frame per
    // change, so a still screen costs nothing - and the video element
    // everywhere else. Asked of the browser, never read from a table.
    if (hasStreamSource()) return createStreamSource({ track, clock })
    return createVideoSource({ stream, track, video: element(), clock, fps: config.capture.fps })
  }

  const clock = (): number => performance.now()

  const host: EngineHost = {
    clock,

    /**
     * `OffscreenCanvas` where it exists and a detached `<canvas>` where it does
     * not. Safari only got OffscreenCanvas recently, and this host exists
     * precisely for the browsers that are not Chrome.
     */
    createCanvas: (width, height) => {
      if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height) as unknown as CanvasLike
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      return canvas as unknown as CanvasLike
    },

    async openSource (config: EngineConfig): Promise<FrameSource> {
      const media = navigator.mediaDevices
      if (media?.getDisplayMedia === undefined) {
        throw new Error('bu tarayıcı ekran yakalamayı desteklemiyor')
      }
      let stream: MediaStream
      try {
        stream = await media.getDisplayMedia({
          audio: false,
          video: { frameRate: { max: config.capture.fps } }
        })
      } catch (error) {
        // Cancelling the picker is a decision, not a failure.
        const name = error instanceof Error ? error.name : ''
        throw new Error(name === 'NotAllowedError' ? 'Ekran seçilmedi.' : describe(error))
      }
      return await sourceFor(stream, config)
    },

    async openSelfTest (config: EngineConfig): Promise<FrameSource> {
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 360
      const paint = canvas.getContext('2d')
      if (paint === null) throw new Error('2d context yok')
      let frame = 0
      if (selfTestTimer !== null) clearInterval(selfTestTimer)
      // A plain interval, never requestAnimationFrame: the same pattern has to
      // keep being drawn when this tab is not the front one, and rAF is the
      // first thing a browser stops.
      selfTestTimer = setInterval(() => {
        const t = frame++ / 120
        const grad = paint.createLinearGradient(0, 0, canvas.width, canvas.height)
        grad.addColorStop(0, `hsl(${(t * 120) % 360} 90% 50%)`)
        grad.addColorStop(1, `hsl(${(t * 120 + 180) % 360} 90% 50%)`)
        paint.fillStyle = grad
        paint.fillRect(0, 0, canvas.width, canvas.height)
        // A black centre: the border detector must NOT read this as
        // letterboxing, because the bars it looks for are at the edges.
        paint.fillStyle = '#000'
        paint.fillRect(canvas.width * 0.2, canvas.height * 0.2, canvas.width * 0.6, canvas.height * 0.6)
      }, Math.round(1000 / 60))
      return await sourceFor(canvas.captureStream(120), config)
    },

    onReport
  }

  const engine = createEngine(host)

  return {
    engine,
    dispose () {
      engine.stop()
      if (selfTestTimer !== null) {
        clearInterval(selfTestTimer)
        selfTestTimer = null
      }
      video?.remove()
      video = null
    }
  }
}

/**
 * Whether this browser can host the engine in the page at all.
 *
 * One question, asked of the browser: can it capture the screen. Everything
 * else on the path - a canvas, `createImageBitmap`, a WebSocket - is present
 * anywhere `getDisplayMedia` is.
 */
export function pageHostAvailable (scope: typeof globalThis = globalThis): boolean {
  const media = (scope as { navigator?: { mediaDevices?: { getDisplayMedia?: unknown } } }).navigator?.mediaDevices
  return typeof media?.getDisplayMedia === 'function'
}

function describe (error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.name === '' || error.name === 'Error' ? error.message : `${error.name}: ${error.message}`
}
