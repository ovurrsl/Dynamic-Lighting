import { APP_VERSION } from '#data/version'

import { parseEngineConfig, type EngineConfig } from '#lib/engine/config'
import { defaultInstances, findInstance, parseInstances, updateInstance, type Instance } from '#lib/engine/instances'
import { isMessage, type Message } from '#lib/extension/messages'
import { parseRules, type ScheduleRule } from '#lib/engine/schedule'

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
/**
 * Where the strips live across a worker that Chrome keeps killing.
 *
 * `CONFIG_KEY` is the key from before there were strips. It is still read, once,
 * and never written: an installation that has been configured already has a
 * layout under it, and a release that silently reset that would lose the single
 * most expensive thing in the application to type back in.
 */
const INSTANCES_KEY = 'ambiflux/instances'
const CONFIG_KEY = 'ambiflux/config'
/** And the time-of-day rules, beside it and for the same reason. */
const SCHEDULE_KEY = 'ambiflux/schedule'

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
      // USER_MEDIA alongside DISPLAY_MEDIA: the audio visualiser opens a
      // microphone, and an offscreen document may only do that if it says so
      // here. It is a REASON, not a permission - the manifest deliberately does
      // NOT ask for `audioCapture`, because a permanent microphone grant on an
      // ambilight extension is exactly the kind of thing that should make a
      // user suspicious. The prompt happens, or the visualiser reports why not.
      reasons: [chrome.offscreen.Reason.DISPLAY_MEDIA, chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Ekran yakalama, ses görselleştirme ve LED şeridine çıkış, hiçbir sekme açık olmadan.'
    }).finally(() => { creating = null })
  }
  await creating
}

let lastState: Message & { type: 'ambiflux/state' } | null = null
let lastStats: Message & { type: 'ambiflux/stats' } | null = null

/**
 * The strips in force, and the worker is their owner: the offscreen document is
 * memory that Chrome drops when the browser closes, and this worker itself is
 * killed after ~30 s idle, so neither can hold them. chrome.storage.local
 * survives both.
 *
 * Read through `loadInstances`, which parses what storage returns rather than
 * trusting it: the stored value was written by an older version of this
 * extension, which is a trust boundary like any other.
 */
let instances: Instance[] | null = null
/**
 * Why the stored list could not be read, when it could not. Reported with the
 * list rather than swallowed: the reference rig standing in for somebody's
 * layout is the right fallback, but a panel that was not told would show the
 * wrong rig with no explanation and its next Save would overwrite the stored
 * one for good.
 */
let instancesProblem: string | undefined

async function loadInstances (): Promise<Instance[]> {
  if (instances !== null) return instances
  try {
    const stored = await chrome.storage.local.get([INSTANCES_KEY, CONFIG_KEY])
    const raw = stored[INSTANCES_KEY]
    if (raw !== undefined) {
      instances = parseInstances(raw)
      return instances
    }
    // Nothing under the new key: there may be a single configuration from
    // before there were strips, and it is somebody's layout. It becomes the
    // first strip, and the old key is left where it is so a rollback still
    // finds it.
    instances = defaultInstances()
    const single = stored[CONFIG_KEY]
    if (single !== undefined) {
      instances = updateInstance(instances, (instances[0] as Instance).id, { config: parseEngineConfig(single) })
    }
  } catch (error) {
    // A stored list this version cannot read is not a reason to light nothing;
    // one strip on the reference rig stands until the panel sends a good one -
    // and the panel is told why.
    instancesProblem = error instanceof Error ? error.message : String(error)
    instances = defaultInstances()
  }
  return instances
}

/** The strip a message with no `instance` means: the first enabled one, as the offscreen document reads it. */
function firstId (list: Instance[]): string {
  return (list.find((instance) => instance.enabled) ?? list[0] as Instance).id
}

/**
 * Validates, stores and forwards a new strip list. Validation happens here as
 * well as in the pool because this is the boundary the panel talks to: a list
 * that cannot be built must never reach storage, or the next start would load
 * it and fail with no one listening.
 */
async function setInstances (value: unknown): Promise<{ instances: Instance[], error?: string }> {
  let parsed: Instance[]
  try {
    parsed = parseInstances(value)
  } catch (error) {
    return { instances: await loadInstances(), error: describe(error) }
  }
  // Stored first, then taken: a write that fails must not leave memory, the
  // storage and the engine document disagreeing while the panel is told it
  // failed.
  await chrome.storage.local.set({ [INSTANCES_KEY]: parsed })
  instances = parsed
  instancesProblem = undefined
  // Only if the engine is up: creating the document just to configure it would
  // start a capture nobody asked for.
  if (await offscreenExists()) {
    try {
      await chrome.runtime.sendMessage({ type: 'ambiflux/instances', target: 'offscreen', instances: parsed } satisfies Message)
    } catch {
      // The document went away between the check and the send; it asks for the
      // strips itself when it next loads.
    }
  }
  return { instances: parsed }
}

/**
 * The configuration of one strip - the first enabled one when the caller did
 * not say, which is how the offscreen document reads an absent id too. A named
 * strip that does not exist is an error, not another strip's configuration: a
 * panel that asked for a deleted strip and got its neighbour's layout back
 * would show it under the wrong name.
 */
async function loadConfig (id?: string): Promise<EngineConfig> {
  const list = await loadInstances()
  if (id === undefined) return (findInstance(list, firstId(list)) as Instance).config
  const found = findInstance(list, id)
  if (found === undefined || found === null) throw new Error(`şerit bulunamadı: ${id}`)
  return found.config
}

/**
 * Replaces one strip's configuration.
 *
 * Still its own message rather than folded into `instances`, because it is what
 * every editor in the panel sends and none of them should have to resend the
 * whole list - a layout editor that had to would be overwriting the OTHER
 * strips with whatever copy of them it happened to be holding.
 */
async function setConfig (value: unknown, id?: string): Promise<{ config: EngineConfig, error?: string }> {
  const list = await loadInstances()
  const target = id ?? firstId(list)
  let parsed: EngineConfig
  try {
    parsed = parseEngineConfig(value)
  } catch (error) {
    return { config: await loadConfig(target), error: error instanceof Error ? error.message : String(error) }
  }
  try {
    const result = await setInstances(updateInstance(list, target, { config: parsed }))
    if (result.error !== undefined) return { config: await loadConfig(target), error: result.error }
  } catch (error) {
    return { config: await loadConfig(target), error: error instanceof Error ? error.message : String(error) }
  }
  return { config: parsed }
}

/**
 * The schedule, owned here rather than by the engine that runs it.
 *
 * The offscreen document holds the live scheduler, but that document is memory:
 * Chrome destroys it when the browser closes. A schedule that forgets itself
 * overnight is not a schedule, so the worker keeps the stored copy and the
 * document asks for it as it loads - exactly as it does for the configuration.
 *
 * The rules can only FIRE while that document exists, which is why the worker
 * builds it on `onStartup`, and why saving a rule builds it too.
 */
let schedule: ScheduleRule[] | null = null
/** Why the stored rules could not be read, when they could not - reported with the (empty) list. */
let scheduleProblem: string | undefined

async function loadSchedule (): Promise<ScheduleRule[]> {
  if (schedule !== null) return schedule
  try {
    const stored = await chrome.storage.local.get(SCHEDULE_KEY)
    const raw = stored[SCHEDULE_KEY]
    schedule = raw === undefined ? [] : parseRules(raw)
  } catch (error) {
    // Rules this version cannot read are rules that would never fire anyway;
    // an empty schedule is at least an honest one - once the panel is told.
    scheduleProblem = describe(error)
    schedule = []
  }
  return schedule
}

/** An error as one sentence, without the "Error: " a String() would prefix. */
function describe (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Validates, stores and forwards a new rule list. Validation happens here as
 * well as in the engine because this is the boundary the panel talks to: a rule
 * that cannot be built must never reach storage, or the next load would throw
 * the whole schedule away with nobody listening.
 */
async function setSchedule (value: unknown): Promise<{ rules: ScheduleRule[], error?: string }> {
  let parsed: ScheduleRule[]
  try {
    parsed = parseRules(value)
  } catch (error) {
    return { rules: await loadSchedule(), error: error instanceof Error ? error.message : String(error) }
  }
  await chrome.storage.local.set({ [SCHEDULE_KEY]: parsed })
  schedule = parsed
  scheduleProblem = undefined

  // Unlike a configuration change, a rule has to reach a LIVE engine or it
  // cannot fire, so saving one builds the document rather than waiting for the
  // next time Chrome starts. It costs a blank page - there is no stream, no
  // timer and no port until something starts a capture.
  if (parsed.length > 0) await ensureOffscreen()
  if (await offscreenExists()) {
    try {
      await chrome.runtime.sendMessage({ type: 'ambiflux/schedule', target: 'offscreen', rules: parsed } satisfies Message)
    } catch {
      // The document went away between the check and the send; it asks for the
      // rules itself when it next loads.
    }
  }
  return { rules: parsed }
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
  const pool = alive ? lastStats?.pool : undefined
  return {
    type: 'ambiflux/status-reply',
    version: APP_VERSION,
    state: alive ? lastState?.state ?? 'idle' : 'idle',
    stats: alive ? lastStats?.stats ?? null : null,
    ...(pool === undefined ? {} : { pool })
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
      status().then(sendResponse, (error: unknown) => sendResponse({ error: describe(error) }))
      return true

    case 'ambiflux/config':
      setConfig(message.config, message.instance).then(
        (result) => sendResponse({
          type: 'ambiflux/config-reply',
          config: result.config,
          ...(result.error === undefined ? {} : { error: result.error })
        } satisfies Message),
        (error: unknown) => sendResponse({ type: 'ambiflux/config-reply', config: null, error: describe(error) } satisfies Message)
      )
      return true

    case 'ambiflux/config-get':
      loadConfig(message.instance).then(
        (current) => sendResponse({ type: 'ambiflux/config-reply', config: current } satisfies Message),
        (error: unknown) => sendResponse({ type: 'ambiflux/config-reply', config: null, error: describe(error) } satisfies Message)
      )
      return true

    case 'ambiflux/instances':
      setInstances(message.instances).then(
        (result) => sendResponse({
          type: 'ambiflux/instances-reply',
          instances: result.instances,
          ...(result.error === undefined ? {} : { error: result.error })
        } satisfies Message),
        (error: unknown) => sendResponse({ type: 'ambiflux/instances-reply', instances: null, error: describe(error) } satisfies Message)
      )
      return true

    // Answered from storage like the schedule, and for the same reason: a panel
    // that opens the strips page must not be the reason the engine exists.
    case 'ambiflux/instances-get':
      loadInstances().then(
        (list) => sendResponse({
          type: 'ambiflux/instances-reply',
          instances: list,
          ...(instancesProblem === undefined ? {} : { error: instancesProblem })
        } satisfies Message),
        (error: unknown) => sendResponse({ type: 'ambiflux/instances-reply', instances: null, error: describe(error) } satisfies Message)
      )
      return true

    case 'ambiflux/schedule':
      setSchedule(message.rules).then(
        (result) => sendResponse({
          type: 'ambiflux/schedule-reply',
          rules: result.rules,
          ...(result.error === undefined ? {} : { error: result.error })
        } satisfies Message),
        (error: unknown) => sendResponse({ type: 'ambiflux/schedule-reply', rules: [], error: describe(error) } satisfies Message)
      )
      return true

    // Answered from storage, never by waking the engine document: a panel that
    // opens the schedule page must not be the reason the document exists.
    case 'ambiflux/schedule-get':
      loadSchedule().then(
        (rules) => sendResponse({
          type: 'ambiflux/schedule-reply',
          rules,
          ...(scheduleProblem === undefined ? {} : { error: scheduleProblem })
        } satisfies Message),
        (error: unknown) => sendResponse({ type: 'ambiflux/schedule-reply', rules: [], error: describe(error) } satisfies Message)
      )
      return true

    case 'ambiflux/prepare':
      ensureOffscreen().then(
        () => sendResponse({ ready: true }),
        (error: unknown) => sendResponse({ ready: false, error: describe(error) })
      )
      return true

    case 'ambiflux/start':
    case 'ambiflux/selftest':
    case 'ambiflux/pattern':
    case 'ambiflux/effect':
    case 'ambiflux/audio':
    case 'ambiflux/color':
    case 'ambiflux/clear-layer':
    case 'ambiflux/serial':
    case 'ambiflux/control':
      relayToOffscreen({ ...message, target: 'offscreen' })
        .then(sendResponse, (error: unknown) => sendResponse({ error: describe(error) }))
      return true // async response

    case 'ambiflux/stop':
      // Nothing to stop if the document does not exist; do not create one to
      // tell it so.
      offscreenExists()
        .then((alive) => alive ? chrome.runtime.sendMessage({ ...message, target: 'offscreen' }) : { state: 'idle' })
        .then(sendResponse, (error: unknown) => sendResponse({ error: describe(error) }))
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
