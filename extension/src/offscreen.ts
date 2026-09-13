import { isMessage, type EngineState, type EngineStats, type Message } from './messages'

/**
 * The engine host. Kademe 1 modules (lib/engine/*) plug in here once they land;
 * for now this file proves the plumbing: it receives a streamId, would open the
 * capture, and reports state. Nothing in here may use requestAnimationFrame -
 * this document is never painted, so rAF never fires.
 */

let state: EngineState = 'idle'
let track: MediaStreamTrack | null = null

function report (partial: Partial<EngineStats> = {}): void {
  const stats: EngineStats = {
    state,
    capturedFrames: 0,
    deliveredFps: 0,
    captureGaps: 0,
    pipelineDrops: 0,
    serialDrops: 0,
    interArrivalMs: { p50: 0, p99: 0 },
    serialConnected: false,
    ...partial
  }
  void chrome.runtime.sendMessage({ type: 'ambiflux/stats', target: 'sw', stats } satisfies Message)
  void chrome.runtime.sendMessage({ type: 'ambiflux/state', target: 'sw', state } satisfies Message)
}

async function start (streamId: string): Promise<void> {
  state = 'starting'
  report()
  try {
    // The streamId from chrome.desktopCapture is consumed through getUserMedia
    // with the Chromium-specific `mandatory` constraints; this is the
    // documented offscreen pattern and the only way a document without a user
    // gesture can begin a screen capture.
    const constraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: streamId,
          maxFrameRate: 120
        }
      }
    } as unknown as MediaStreamConstraints
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    track = stream.getVideoTracks()[0] ?? null
    if (track === null) throw new Error('no video track')
    track.addEventListener('ended', stop)
    state = 'running'
    report()
  } catch (error) {
    state = 'error'
    report({ error: error instanceof Error ? error.message : String(error) })
  }
}

function stop (): void {
  track?.stop()
  track = null
  state = 'idle'
  report()
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isMessage(message) || !('target' in message) || message.target !== 'offscreen') return false
  switch (message.type) {
    case 'ambiflux/start':
      start(message.streamId).then(() => sendResponse({ state }))
      return true
    case 'ambiflux/stop':
      stop()
      sendResponse({ state })
      return false
    case 'ambiflux/ping':
      sendResponse({ type: 'ambiflux/pong', version: 'offscreen', engine: state } satisfies Message)
      return false
    default:
      return false
  }
})

report()
