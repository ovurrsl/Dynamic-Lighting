import { EXTENSION_ID } from '#data/extension'
import { parseEngineConfig, type EngineConfig } from '#lib/engine/config'
import type { EngineStats, EngineState, Message } from '#lib/extension/messages'

/**
 * The panel's side of the extension conversation.
 *
 * A hosted page may talk to an extension only because the extension's
 * manifest names the page's origin under `externally_connectable`; the browser
 * rejects every other caller before the extension's listener runs. From the
 * page the API is `chrome.runtime.sendMessage(EXTENSION_ID, message, cb)` and
 * nothing else - no ports, no tabs, no storage - which is exactly the surface
 * this file wraps.
 *
 * The panel never sees a fake state: when the extension is missing, that is
 * reported as missing, not as "disconnected".
 */

export type ExtensionProbe =
  /** Not a Chromium browser, or the origin is not in the manifest. */
  | { available: false; reason: 'no-runtime' }
  /** Chromium, but the extension is not installed or refused the message. */
  | { available: false; reason: 'not-installed'; detail?: string }
  | { available: true; version: string; state: EngineState }

export interface ExtensionStatus {
  version: string
  state: EngineState
  stats: EngineStats | null
}

interface ExternalRuntime {
  sendMessage (extensionId: string, message: unknown, callback: (response: unknown) => void): void
  lastError?: { message?: string }
}

function runtime (): ExternalRuntime | null {
  const chrome = (globalThis as { chrome?: { runtime?: Partial<ExternalRuntime> } }).chrome
  const rt = chrome?.runtime
  return rt !== undefined && typeof rt.sendMessage === 'function' ? rt as ExternalRuntime : null
}

/** Sends one message and resolves with the reply, or rejects with the runtime's error. */
function send (message: Message): Promise<unknown> {
  const rt = runtime()
  if (rt === null) return Promise.reject(new Error('no-runtime'))
  return new Promise((resolve, reject) => {
    try {
      rt.sendMessage(EXTENSION_ID, message, (response) => {
        const error = rt.lastError
        if (error !== undefined && error !== null) reject(new Error(error.message ?? 'extension unreachable'))
        else resolve(response)
      })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function isPong (value: unknown): value is Extract<Message, { type: 'ambiflux/pong' }> {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'ambiflux/pong'
}

function isStatusReply (value: unknown): value is Extract<Message, { type: 'ambiflux/status-reply' }> {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'ambiflux/status-reply'
}

export async function probeExtension (): Promise<ExtensionProbe> {
  if (runtime() === null) return { available: false, reason: 'no-runtime' }
  try {
    const reply = await send({ type: 'ambiflux/ping', target: 'sw' })
    if (!isPong(reply)) return { available: false, reason: 'not-installed', detail: 'unexpected reply' }
    return { available: true, version: reply.version, state: reply.engine }
  } catch (error) {
    return { available: false, reason: 'not-installed', detail: error instanceof Error ? error.message : String(error) }
  }
}

/** Null when the extension did not answer. */
export async function fetchStatus (): Promise<ExtensionStatus | null> {
  try {
    const reply = await send({ type: 'ambiflux/status', target: 'sw' })
    if (!isStatusReply(reply)) return null
    return { version: reply.version, state: reply.state, stats: reply.stats }
  } catch {
    return null
  }
}

/**
 * The engine's answer to a start request.
 *
 * `state` rather than a boolean because "did not start" has two very different
 * meanings: the user closed the screen picker, which is a decision, and the
 * capture failed, which is a fault. The panel says different things about them.
 */
export interface StartOutcome {
  state: EngineState
  error?: string
}

function outcome (reply: unknown): StartOutcome {
  const body = reply as { state?: unknown, error?: unknown } | undefined
  const state = typeof body?.state === 'string' ? body.state as EngineState : 'error'
  const error = typeof body?.error === 'string' ? body.error : undefined
  return error === undefined ? { state } : { state, error }
}

/**
 * Starts a screen capture from the panel.
 *
 * The screen picker still opens in the extension's own engine document - that
 * is the only place it works (see extension/src/offscreen.ts openCapture) - so
 * this call travels panel -> service worker -> engine and the user sees the
 * picker without ever opening the extension's popup. That is the whole point:
 * the popup was the only way to start the engine, and a product whose main
 * control lives in a toolbar menu is a product people cannot find.
 */
export async function startEngine (): Promise<StartOutcome> {
  try {
    return outcome(await send({ type: 'ambiflux/start', target: 'sw' }))
  } catch (error) {
    return { state: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Runs the engine on a generated picture: no screen, no picker, no board.
 *
 * The one thing that separates "the engine is broken" from "the capture never
 * started" - which look identical from outside, and are the two things a user
 * with a dark strip is actually choosing between.
 */
export async function selfTestEngine (): Promise<StartOutcome> {
  try {
    return outcome(await send({ type: 'ambiflux/selftest', target: 'sw' }))
  } catch (error) {
    return { state: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function stopEngine (): Promise<boolean> {
  try {
    await send({ type: 'ambiflux/stop', target: 'sw' })
    return true
  } catch {
    return false
  }
}

function isConfigReply (value: unknown): value is Extract<Message, { type: 'ambiflux/config-reply' }> {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'ambiflux/config-reply'
}

/**
 * The configuration the engine is actually running, or null when the extension
 * is not there or answered with something else.
 *
 * Parsed rather than trusted even though it came from our own extension: an
 * older extension is a different program, and the panel's editor would show
 * nonsense rather than say it could not read it.
 */
export async function fetchConfig (): Promise<EngineConfig | null> {
  try {
    const reply = await send({ type: 'ambiflux/config-get', target: 'sw' })
    if (!isConfigReply(reply) || reply.config === null) return null
    return parseEngineConfig(reply.config)
  } catch {
    return null
  }
}

/**
 * Sends a configuration to the engine. Returns null when the engine took it,
 * or the reason it did not - the extension validates independently and its
 * message names the field, so that message is what the panel shows rather than
 * a generic failure.
 */
export async function saveConfig (config: EngineConfig): Promise<string | null> {
  let reply: unknown
  try {
    reply = await send({ type: 'ambiflux/config', target: 'sw', config })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  if (!isConfigReply(reply)) return 'eklenti beklenmeyen bir yanıt verdi'
  if (reply.error !== undefined) return reply.error
  return reply.config === null ? 'eklenti yapılandırmayı kabul etmedi' : null
}
