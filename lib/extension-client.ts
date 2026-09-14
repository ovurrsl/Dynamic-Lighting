import { EXTENSION_ID } from '#data/extension'
import { parseEngineConfig, type EngineConfig } from '#lib/engine/config'
import type { AudioSpec } from '#lib/engine/audio'
import type { AudioInputKind } from '#lib/engine/audio-input'
import type { EffectSpec } from '#lib/engine/effects'
import { parseInstances, type Instance } from '#lib/engine/instances'
import { parseRules, type ScheduleRule } from '#lib/engine/schedule'
import type { PatternSpec } from '#lib/engine/patterns'
import type { ControlRequest, EngineStats, EngineState, Message } from '#lib/extension/messages'
import type { PoolStats } from '#lib/engine/pool'

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
  /**
   * Every strip, when the extension is new enough to send it.
   *
   * Optional rather than required because the panel and the extension are
   * updated separately: a page that demanded this would show nothing at all
   * against an extension one version behind, which is the common case for a
   * few hours after every release.
   */
  pool?: PoolStats
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
    return {
      version: reply.version,
      state: reply.state,
      stats: reply.stats,
      ...(reply.pool === undefined ? {} : { pool: reply.pool })
    }
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

/**
 * Lights the strip from a generated pattern instead of the screen.
 *
 * The calibration wizards are built on this: the walk lights one LED at a known
 * index so the user can click the corners, and a pure channel is what the
 * channel-order wizard asks them to name. It bypasses smoothing, sampling and
 * the channel-order stage inside the engine - see extension/src/offscreen.ts
 * startPattern for why the last of those is not optional.
 */
export async function saveSchedule (rules: ScheduleRule[]): Promise<{ rules: ScheduleRule[], error?: string }> {
  try {
    const reply = await send({ type: 'ambiflux/schedule', target: 'sw', rules })
    return readSchedule(reply)
  } catch (error) {
    return { rules: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export async function fetchSchedule (): Promise<ScheduleRule[]> {
  try {
    return readSchedule(await send({ type: 'ambiflux/schedule-get', target: 'sw' })).rules
  } catch {
    return []
  }
}

function readSchedule (reply: unknown): { rules: ScheduleRule[], error?: string } {
  if (typeof reply !== 'object' || reply === null || !('rules' in reply)) {
    return { rules: [], error: 'eklenti beklenmeyen bir yanıt verdi' }
  }
  const answer = reply as { rules: unknown, error?: string }
  try {
    return { rules: parseRules(answer.rules), ...(answer.error !== undefined ? { error: answer.error } : {}) }
  } catch (error) {
    return { rules: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export async function setStripColor (
  color: { r: number, g: number, b: number },
  durationMs?: number,
  instance?: string
): Promise<StartOutcome> {
  try {
    return outcome(await send({ type: 'ambiflux/color', target: 'sw', color, durationMs, instance }))
  } catch (error) {
    return { state: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function clearLayer (priority: number, instance?: string): Promise<StartOutcome> {
  try {
    return outcome(await send({ type: 'ambiflux/clear-layer', target: 'sw', priority, instance }))
  } catch (error) {
    return { state: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function runAudio (spec: AudioSpec, input: AudioInputKind, instance?: string): Promise<StartOutcome> {
  try {
    return outcome(await send({ type: 'ambiflux/audio', target: 'sw', spec, input, instance }))
  } catch (error) {
    return { state: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function runEffect (spec: EffectSpec, instance?: string): Promise<StartOutcome> {
  try {
    return outcome(await send({ type: 'ambiflux/effect', target: 'sw', spec, instance }))
  } catch (error) {
    return { state: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function runPattern (spec: PatternSpec, instance?: string): Promise<StartOutcome> {
  try {
    return outcome(await send({ type: 'ambiflux/pattern', target: 'sw', spec, instance }))
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
export async function fetchConfig (instance?: string): Promise<EngineConfig | null> {
  try {
    const reply = await send({ type: 'ambiflux/config-get', target: 'sw', instance })
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
export async function saveConfig (config: EngineConfig, instance?: string): Promise<string | null> {
  let reply: unknown
  try {
    reply = await send({ type: 'ambiflux/config', target: 'sw', config, instance })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  if (!isConfigReply(reply)) return 'eklenti beklenmeyen bir yanıt verdi'
  if (reply.error !== undefined) return reply.error
  return reply.config === null ? 'eklenti yapılandırmayı kabul etmedi' : null
}

/**
 * Sends one control request to the BOARD, through the engine.
 *
 * Returns null when the board took it, or the reason it did not. The request is
 * an intent, not bytes: the frame is built in the engine by `lib/engine/control`
 * so the validation that decides what the firmware will accept lives in exactly
 * one place, and a passphrase never becomes a byte array on the message bus.
 */
export async function sendControl (control: ControlRequest, instance?: string): Promise<string | null> {
  let reply: unknown
  try {
    reply = await send({ type: 'ambiflux/control', target: 'sw', control, instance })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  if (typeof reply !== 'object' || reply === null || !('sent' in reply)) {
    return 'eklenti beklenmeyen bir yanıt verdi'
  }
  const answer = reply as { sent: boolean, error?: string }
  if (answer.sent) return null
  return answer.error ?? 'kart isteği kabul etmedi'
}

/**
 * The strips the extension is driving.
 *
 * Parsed rather than trusted for the same reason the configuration is: an older
 * extension is a different program, and a panel that showed whatever it sent
 * would show nonsense instead of saying it could not read it.
 */
export async function fetchInstances (): Promise<Instance[] | null> {
  try {
    const reply = await send({ type: 'ambiflux/instances-get', target: 'sw' })
    return readInstances(reply).instances
  } catch {
    return null
  }
}

export async function saveInstances (instances: readonly Instance[]): Promise<{ instances: Instance[] | null, error?: string }> {
  try {
    return readInstances(await send({ type: 'ambiflux/instances', target: 'sw', instances }))
  } catch (error) {
    return { instances: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function readInstances (reply: unknown): { instances: Instance[] | null, error?: string } {
  if (typeof reply !== 'object' || reply === null || !('instances' in reply)) {
    return { instances: null, error: 'eklenti beklenmeyen bir yanıt verdi' }
  }
  const answer = reply as { instances: unknown, error?: string }
  if (answer.instances === null) {
    return { instances: null, error: answer.error ?? 'eklenti şeritleri kabul etmedi' }
  }
  try {
    return {
      instances: parseInstances(answer.instances),
      ...(answer.error !== undefined ? { error: answer.error } : {})
    }
  } catch (error) {
    return { instances: null, error: error instanceof Error ? error.message : String(error) }
  }
}
