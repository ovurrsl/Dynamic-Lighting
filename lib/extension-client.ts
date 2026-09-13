import { EXTENSION_ID } from '#data/extension'
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

export async function stopEngine (): Promise<boolean> {
  try {
    await send({ type: 'ambiflux/stop', target: 'sw' })
    return true
  } catch {
    return false
  }
}
