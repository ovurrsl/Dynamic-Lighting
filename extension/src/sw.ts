import { APP_VERSION } from '#data/version'

import { isMessage, type Message } from './messages'

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

async function relayToOffscreen (message: Message): Promise<unknown> {
  await ensureOffscreen()
  return chrome.runtime.sendMessage(message)
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

    case 'ambiflux/start':
      relayToOffscreen({ ...message, target: 'offscreen' })
        .then(sendResponse, (error: unknown) => sendResponse({ error: String(error) }))
      return true // async response

    case 'ambiflux/stop':
      relayToOffscreen({ ...message, target: 'offscreen' })
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

// Internal traffic: popup and offscreen document.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => handle(message, sendResponse))

// External traffic: the hosted panel, admitted by externally_connectable. The
// browser rejects any origin not in that list before this listener ever runs,
// so there is no origin check to get wrong here.
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => handle(message, sendResponse))

export function currentStats (): Message | null {
  return lastStats
}
