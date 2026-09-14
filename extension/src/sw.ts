import { APP_VERSION } from '#data/version'

import { DEFAULT_ENGINE_CONFIG, parseEngineConfig, type EngineConfig } from '#lib/engine/config'
import { isMessage, type Message } from '#lib/extension/messages'

/**
 * The service worker. It owns exactly one thing: the offscreen document's
 * lifecycle. No capture, no sampling, no serial here - MV3 service workers have
 * no DOM, no media APIs, and are killed after ~30 s of idleness, so anything
 * with state lives in the offscreen document and this file stays a relay.
 *
 * Why an offscreen document at all is measured, not assumed: on Chromium 141
 * MediaStreamTrackProcessor exists in `window` and NOT in a DedicatedWorker, so
 * the engine needs a document; the offscreen document is the only document an
 * extension has that is never rendered, hence never occluded, hence never
 * throttled the way a background tab is. See docs/hyperion-port-plan.md §2.
 */

const OFFSCREEN_URL = 'offscreen.html'
/** Where the configuration lives across a worker that Chrome keeps killing. */
const CONFIG_KEY = 'ambiflux/config'

let creating: Promise<void> | null = null

async function ensureOffscreen (): Promise<void> {
  // chrome.runtime.getContexts is the supported way to ask whether the
  // document already exists (Chrome 116+). Creating a second one throws.
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  })
  if (contexts.length > 0) return

  // Two callers racing here would both try to create; hold one promise.
  if (creating === null) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      // DISPLAY_MEDIA is the documented reason for exactly this use, and unlike
      // AUDIO_PLAYBACK it carries no lifetime limit: the document lives until
      // we close it or Chrome exits.
      reasons: [chrome.offscreen.Reason.DISPLAY_MEDIA],
      justification: 'Ekran yakalama ve LED şeridine seri port çıkışı, hiçbir sekme açık olmadan.'
    }).finally(() => { creating = null })
  }
  await creating
}

let lastState: Message & { type: 'ambiflux/state' } | null = null
let lastStats: Message & { type: 'ambiflux/stats' } | null = null

/**
 * The configuration in force, and the worker is its owner: the offscreen
 * document is destroyed whenever capture stops and this worker itself is killed
 * after ~30 s idle, so neither can hold it. chrome.storage.local survives both.
 *
 * Read through `loadConfig`, which parses what storage returns rather than
 * trusting it: the stored value was written by an older version of this
 * extension, which is a trust boundary like any other.
 */
let config: EngineConfig | null = null

async function loadConfig (): Promise<EngineConfig> {
  if (config !== null) return config
  try {
    const stored = await chrome.storage.local.get(CONFIG_KEY)
    const raw = stored[CONFIG_KEY]
    config = raw === undefined ? DEFAULT_ENGINE_CONFIG : parseEngineConfig(raw)
  } catch {
    // A config this version cannot read is not a reason to light nothing; the
    // reference rig stands until the panel sends a good one.
    config = DEFAULT_ENGINE_CONFIG
  }
  return config
}

/**
 * Validates, stores and forwards a new configuration. Validation happens here
 * as well as in the engine because this is the boundary the panel talks to: a
 * config that cannot be built must never reach storage, or the next start
 * would load it and fail with no one listening.
 */
async function setConfig (value: unknown): Promise<{ config: EngineConfig, error?: string }> {
  let parsed: EngineConfig
  try {
    parsed = parseEngineConfig(value)
  } catch (error) {
    return { config: await loadConfig(), error: error instanceof Error ? error.message : String(error) }
  }
  config = parsed
  await chrome.storage.local.set({ [CONFIG_KEY]: parsed })
  // Only if the engine is up: creating the document just to configure it would
  // start a capture nobody asked for.
  if (await offscreenExists()) {
    try {
      await chrome.runtime.sendMessage({ type: 'ambiflux/config', target: 'offscreen', config: parsed } satisfies Message)
    } catch {
      // The document went away between the check and the send; it will ask for
      // the configuration itself when it next loads.
    }
  }
  return { config: parsed }
}

async function relayToOffscreen (message: Message): Promise<unknown> {
  await ensureOffscreen()
  return chrome.runtime.sendMessage(message)
}

async function offscreenExists (): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  })
  return contexts.length > 0
}

/**
 * Status is answered from what the offscreen document last pushed, not by
 * waking it: a page polling once a second must never be the reason the engine
 * document exists. If the document is gone, so is the engine, whatever the
 * cache says.
 */
async function status (): Promise<Message> {
  const alive = await offscreenExists()
  return {
    type: 'ambiflux/status-reply',
    version: APP_VERSION,
    state: alive ? lastState?.state ?? 'idle' : 'idle',
    stats: alive ? lastStats?.stats ?? null : null
  }
}

function handle (message: unknown, sendResponse: (r: unknown) => void): boolean {
  if (!isMessage(message)) return false
  if ('target' in message && message.target !== 'sw') return false

  switch (message.type) {
    case 'ambiflux/ping':
      sendResponse({
        type: 'ambiflux/pong',
        version: APP_VERSION,
        engine: lastState?.state ?? 'idle'
      } satisfies Message)
      return false

    case 'ambiflux/status':
      status().then(sendResponse, (error: unknown) => sendResponse({ error: String(error) }))
      return true

    case 'ambiflux/config':
      setConfig(message.config).then(
        (result) => sendResponse({
          type: 'ambiflux/config-reply',
          config: result.config,
          ...(result.error === undefined ? {} : { error: result.error })
        } satisfies Message),
        (error: unknown) => sendResponse({ type: 'ambiflux/config-reply', config: null, error: String(error) } satisfies Message)
      )
      return true

    case 'ambiflux/config-get':
      loadConfig().then(
        (current) => sendResponse({ type: 'ambiflux/config-reply', config: current } satisfies Message),
        (error: unknown) => sendResponse({ type: 'ambiflux/config-reply', config: null, error: String(error) } satisfies Message)
      )
      return true

    case 'ambiflux/prepare':
      ensureOffscreen().then(
        () => sendResponse({ ready: true }),
        (error: unknown) => sendResponse({ ready: false, error: String(error) })
      )
      return true

    case 'ambiflux/start':
    case 'ambiflux/selftest':
    case 'ambiflux/pattern':
    case 'ambiflux/effect':
    case 'ambiflux/serial':
    case 'ambiflux/control':
      relayToOffscreen({ ...message, target: 'offscreen' })
        .then(sendResponse, (error: unknown) => sendResponse({ error: String(error) }))
      return true // async response

    case 'ambiflux/stop':
      // Nothing to stop if the document does not exist; do not create one to
      // tell it so.
      offscreenExists()
        .then((alive) => alive ? chrome.runtime.sendMessage({ ...message, target: 'offscreen' }) : { state: 'idle' })
        .then(sendResponse, (error: unknown) => sendResponse({ error: String(error) }))
      return true

    // The offscreen document reports upward; the worker keeps the latest so a
    // popup or page that opens later can read it without waiting for the next
    // tick. It does not forward on its own - the page asks.
    case 'ambiflux/stats':
      lastStats = message
      sendResponse(undefined)
      return false
    case 'ambiflux/state':
      lastState = message
      sendResponse(undefined)
      return false

    default:
      return false
  }
}

/**
 * Build the engine document when Chrome starts, before anyone asks.
 *
 * The screen choice cannot be persisted - a `getDisplayMedia` grant lives and
 * dies with the browser session, and no amount of engineering changes that - so
 * "starts with the OS and never asks" is not on offer in a browser. What IS on
 * offer is that the first click after opening Chrome shows the picker
 * immediately instead of after a document boot, and that is what this buys.
 *
 * The document is blank until something starts a capture: no stream, no timers,
 * no port. It costs one empty page and saves the wait on every single start.
 */
chrome.runtime.onStartup.addListener(() => {
  void ensureOffscreen().catch(() => { /* built on demand instead */ })
})

chrome.runtime.onInstalled.addListener(() => {
  void ensureOffscreen().catch(() => { /* built on demand instead */ })
})

// Internal traffic: popup and offscreen document.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => handle(message, sendResponse))

// External traffic: the hosted panel, admitted by externally_connectable. The
// browser rejects any origin not in that list before this listener ever runs,
// so there is no origin check to get wrong here.
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => handle(message, sendResponse))

export function currentStats (): Message | null {
  return lastStats
}
