import { defaultInstances } from '#lib/engine/instances'
import { createEnginePool, type PoolStats } from '#lib/engine/pool'
import type { CanvasLike, Engine } from '#lib/engine/runtime'
import { createStreamSource, type FrameSource } from '#lib/engine/source'
import type { EngineConfig } from '#lib/engine/config'
import { openConfiguredStream } from '#lib/engine/open-source'
import { isMessage, type Message } from '#lib/extension/messages'

/**
 * The extension's host for the engine.
 *
 * This file used to BE the engine - 875 lines of pipeline welded to `chrome.*`,
 * which meant the engine could only ever run where `chrome.*` exists. It is now
 * three things and nothing else: open a capture, make a canvas, carry messages.
 * The pipeline lives in `lib/engine/runtime.ts` and the panel page runs the
 * very same one.
 *
 * What is still special about this host, and why it remains the right one on a
 * Chromium desktop: an offscreen document is NEVER RENDERED, so it is never
 * hidden and never throttled. A page host is throttled the moment its tab goes
 * to the background, which is exactly when someone playing a game in full
 * screen needs the strip to keep up.
 */

const clock = (): number => performance.now()

let selfTestTimer: ReturnType<typeof setInterval> | null = null

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
 */
async function openSource (config: EngineConfig): Promise<FrameSource> {
  const stream = await openConfiguredStream(config, {
    getDisplayMedia: (c) => navigator.mediaDevices.getDisplayMedia(c as DisplayMediaStreamOptions),
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c as MediaStreamConstraints)
  })
  const track = stream.getVideoTracks()[0]
  if (track === undefined) throw new Error('yakalama video izi vermedi')
  return createStreamSource({ track, clock })
}

/**
 * Runs the whole engine on a generated picture instead of the screen.
 *
 * It earns its place three times over: it proves the pipeline end to end with
 * no screen, no picker and no board; it is the only way to tell "the engine is
 * broken" apart from "the capture never started", which are the same symptom
 * from outside; and it is what a customer can run when their strip stays dark.
 *
 * Drawing happens on a plain interval, never `requestAnimationFrame` - in a
 * document that is never rendered rAF does not fire, which is the same reason
 * the engine is here at all.
 */
async function openSelfTest (): Promise<FrameSource> {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 360
  const paint = canvas.getContext('2d')
  if (paint === null) throw new Error('2d context yok')
  let frame = 0
  if (selfTestTimer !== null) clearInterval(selfTestTimer)
  selfTestTimer = setInterval(() => {
    // A hue travelling around the border, so every LED lights in turn and the
    // wire order is visible on the strip as a moving comet.
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

  const track = canvas.captureStream(120).getVideoTracks()[0]
  if (track === undefined) throw new Error('captureStream video vermedi')
  return createStreamSource({ track, clock })
}

/**
 * Every strip this installation drives.
 *
 * A pool rather than one engine, and the capture is why: two engines each
 * calling `getDisplayMedia` would open two pickers, so the pool reads the
 * screen once and hands the frame to each strip (lib/engine/pool.ts).
 *
 * Which strip the panel is LOOKING at is not this document's business. The
 * flat `stats`/`state` it reports are the first enabled strip's, so every card
 * that was written before instances keeps working unchanged, and `pool` beside
 * them carries the rest.
 */
const pool = createEnginePool(
  {
    clock,
    createCanvas: (width, height) => new OffscreenCanvas(width, height) as unknown as CanvasLike,
    openSource,
    openSelfTest
  },
  defaultInstances(),
  {
    onReport: (stats: PoolStats) => {
      const first = stats.instances.find((instance) => instance.enabled) ?? stats.instances[0]
      void chrome.runtime.sendMessage({
        type: 'ambiflux/stats', target: 'sw', stats: first?.stats ?? null, pool: stats
      } satisfies Message).catch(() => { /* worker asleep */ })
      void chrome.runtime.sendMessage({
        type: 'ambiflux/state', target: 'sw', state: first?.state ?? 'idle'
      } satisfies Message).catch(() => { /* worker asleep */ })
    }
  }
)

/**
 * The strip a message is addressed to.
 *
 * An absent `instance` means the first enabled one, which is what a panel that
 * has only ever had one strip sends - so every older caller keeps working and
 * lands somewhere sensible rather than nowhere.
 */
function addressed (id?: string): Engine | null {
  if (id !== undefined) return pool.engine(id)
  const first = pool.instances().find((instance) => instance.enabled) ?? pool.instances()[0]
  return first === undefined ? null : pool.engine(first.id)
}

/** The self-test's painter outlives the source, so stopping has to reach it. */
function stopPool (): void {
  if (selfTestTimer !== null) {
    clearInterval(selfTestTimer)
    selfTestTimer = null
  }
  pool.stop()
}

function describe (error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.name === '' || error.name === 'Error' ? error.message : `${error.name}: ${error.message}`
}

/** What a per-strip command answers with when the strip it named is gone. */
function noSuchInstance (id?: string): { state: 'idle', error: string } {
  return { state: 'idle', error: `şerit bulunamadı: ${id ?? '?'}` }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isMessage(message) || !('target' in message) || message.target !== 'offscreen') return false

  switch (message.type) {
    // Starting and stopping are POOL-wide. "Start the capture" means all of
    // them: one picker, every strip following the screen it shows. A per-strip
    // start would ask for the screen again for the second strip, which is the
    // one thing the pool exists to avoid.
    case 'ambiflux/start':
      pool.start().then(
        () => sendResponse({ state: firstState(), error: firstError() }),
        (error: unknown) => sendResponse({ state: firstState(), error: describe(error) })
      )
      return true
    case 'ambiflux/selftest':
      pool.selfTest().then(
        () => sendResponse({ state: firstState(), error: firstError() }),
        (error: unknown) => sendResponse({ state: firstState(), error: describe(error) })
      )
      return true
    case 'ambiflux/stop':
      stopPool()
      sendResponse({ state: firstState() })
      return false

    case 'ambiflux/instances':
      try {
        sendResponse({ type: 'ambiflux/instances-reply', instances: pool.setInstances(message.instances) } satisfies Message)
      } catch (error) {
        // The strips that were running keep running: a bad edit to one of them
        // must not black out the others.
        sendResponse({
          type: 'ambiflux/instances-reply', instances: pool.instances(), error: describe(error)
        } satisfies Message)
      }
      return false
    case 'ambiflux/instances-get':
      sendResponse({ type: 'ambiflux/instances-reply', instances: pool.instances() } satisfies Message)
      return false

    default:
      break
  }

  // Everything below drives ONE strip.
  const engine = addressed('instance' in message ? message.instance : undefined)
  if (engine === null) {
    sendResponse(noSuchInstance('instance' in message ? message.instance : undefined))
    return false
  }

  switch (message.type) {
    case 'ambiflux/pattern':
      try {
        engine.runPattern(message.spec)
        sendResponse({ state: engine.state(), pattern: engine.stats().pattern })
      } catch (error) {
        // A bad spec leaves whatever was running alone: a typo in a wizard must
        // not black out a strip that is happily following the screen.
        sendResponse({ state: engine.state(), error: describe(error) })
      }
      return false
    case 'ambiflux/effect':
      try {
        engine.runEffect(message.spec)
        sendResponse({ state: engine.state(), effect: engine.stats().effect })
      } catch (error) {
        sendResponse({ state: engine.state(), error: describe(error) })
      }
      return false
    case 'ambiflux/audio':
      engine.runAudio(message.spec, message.input).then(
        () => sendResponse({ state: engine.state(), error: engine.error() }),
        (error: unknown) => sendResponse({ state: engine.state(), error: describe(error) })
      )
      return true
    case 'ambiflux/color':
      engine.setColor(message.color, message.durationMs)
      sendResponse({ state: engine.state() })
      return false
    case 'ambiflux/clear-layer':
      engine.clearLayer(message.priority)
      sendResponse({ state: engine.state() })
      return false

    // The rules reach every strip, because an action that only some of them
    // obeyed would need a rule to say which - and until a rule can, applying
    // one to half a room is worse than applying it to all of it.
    case 'ambiflux/schedule':
      try {
        const rules = engine.setSchedule(message.rules)
        for (const other of pool.engines()) if (other !== engine) other.setSchedule(rules)
        sendResponse({ type: 'ambiflux/schedule-reply', rules } satisfies Message)
      } catch (error) {
        sendResponse({
          type: 'ambiflux/schedule-reply', rules: engine.schedule(), error: describe(error)
        } satisfies Message)
      }
      return false
    case 'ambiflux/schedule-get':
      sendResponse({ type: 'ambiflux/schedule-reply', rules: engine.schedule() } satisfies Message)
      return false

    case 'ambiflux/serial': {
      const link = engine.link()
      engine.relink().then(() => sendResponse({
        link: engine.link().mode, port: engine.link().label ?? link.label, error: engine.error()
      }))
      return true
    }
    case 'ambiflux/config':
      try {
        engine.applyConfig(message.config)
        sendResponse({ type: 'ambiflux/config-reply', config: engine.config() } satisfies Message)
      } catch (error) {
        // The engine keeps the configuration it had: a bad edit must not stop
        // the strip mid-film.
        sendResponse({
          type: 'ambiflux/config-reply',
          config: engine.config(),
          error: describe(error)
        } satisfies Message)
      }
      return false
    case 'ambiflux/control':
      engine.sendControl(message.control).then(
        () => sendResponse({ type: 'ambiflux/control-reply', sent: true } satisfies Message),
        (error: unknown) => sendResponse({
          type: 'ambiflux/control-reply', sent: false, error: describe(error)
        } satisfies Message)
      )
      return true
    case 'ambiflux/config-get':
      sendResponse({ type: 'ambiflux/config-reply', config: engine.config() } satisfies Message)
      return false
    case 'ambiflux/ping':
      sendResponse({ type: 'ambiflux/pong', version: 'offscreen', engine: engine.state() } satisfies Message)
      return false
    default:
      return false
  }
})

const firstState = (): string => addressed()?.state() ?? 'idle'
const firstError = (): string | undefined => addressed()?.error()

/**
 * The worker holds the stored strips, so ask for them as soon as this document
 * exists rather than waiting for the first edit. Until it answers, one strip on
 * the reference rig is in force - which is also what a fresh install has.
 *
 * This replaces the single `config-get` this file used to do. A worker from an
 * older build answers `instances-reply` with nothing, and the fallback below
 * asks for the single configuration instead, so an extension whose two halves
 * are briefly out of step still lights a strip.
 */
void chrome.runtime.sendMessage({ type: 'ambiflux/instances-get', target: 'sw' } satisfies Message)
  .then(async (reply: unknown) => {
    const instances = reading(reply, 'ambiflux/instances-reply', 'instances')
    if (Array.isArray(instances) && instances.length > 0) {
      pool.setInstances(instances)
      return
    }
    const older = await chrome.runtime.sendMessage({ type: 'ambiflux/config-get', target: 'sw' } satisfies Message)
    const config = reading(older, 'ambiflux/config-reply', 'config')
    if (config !== null && config !== undefined) addressed()?.applyConfig(config)
  })
  .catch(() => { /* nothing stored yet; the reference rig stands */ })

/**
 * And the rules, for the same reason and from the same owner.
 *
 * This document is destroyed when Chrome closes, so the schedulers in it start
 * empty every time. The worker's stored copy is what makes "warm white at
 * sunset" survive a restart; without this pull the rules would apply only until
 * the browser was next shut down, which is the one time a user would not be
 * watching.
 */
void chrome.runtime.sendMessage({ type: 'ambiflux/schedule-get', target: 'sw' } satisfies Message)
  .then((reply: unknown) => {
    const rules = reading(reply, 'ambiflux/schedule-reply', 'rules')
    if (Array.isArray(rules) && rules.length > 0) for (const engine of pool.engines()) engine.setSchedule(rules)
  })
  .catch(() => { /* no stored rules yet; an empty schedule stands */ })

/** Pulls one field out of a reply, or undefined if it is not the reply we asked for. */
function reading (reply: unknown, type: string, field: string): unknown {
  if (typeof reply !== 'object' || reply === null) return undefined
  if ((reply as { type?: string }).type !== type) return undefined
  return (reply as Record<string, unknown>)[field]
}
