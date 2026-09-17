import { parseEffectSpec, type EffectSpec } from '#lib/engine/effects'

/**
 * Time of day, and what the strip should be doing at it.
 *
 * Hyperion's eighth roadmap item, and the half of it that is actually a
 * feature: "warm white at sunset, off at midnight, screen capture when I sit
 * down" is the thing people set up once and then never touch. The other half -
 * suspend, resume, screen lock - is already handled, because the capture track
 * dies with the session and the engine reports that as a lost source.
 *
 * Everything here is pure and the clock is injected. A scheduler that consulted
 * `Date.now()` could only be tested by waiting, which for a rule that fires at
 * 22:00 means never testing it.
 *
 * Two decisions, both of which only show up on a real desk:
 *
 * - **A rule fires when the clock CROSSES it, not while it matches.** Matching
 *   would re-apply the same rule every second for a minute, which on a strip
 *   means an effect restarting sixty times.
 * - **A machine that was asleep across a rule still gets it**, and gets only
 *   the LAST one it missed. Waking at nine in the evening to a strip still in
 *   its eight-in-the-morning state is wrong; replaying five hours of rules in
 *   half a second is sillier.
 */

export const MINUTES_IN_DAY = 1440

export type ScheduleAction =
  | { kind: 'stop' }
  | { kind: 'capture' }
  | { kind: 'effect', spec: EffectSpec }
  | { kind: 'color', color: { r: number, g: number, b: number } }

export const ACTION_KINDS = ['stop', 'capture', 'effect', 'color'] as const

export interface ScheduleRule {
  id: string
  enabled: boolean
  /**
   * Which strip this applies to. Absent means all of them.
   *
   * Absent is the default and stays the default: one strip is what almost
   * every installation has, and a rule that had to name it would be a field
   * nobody could leave blank. It also makes every rule written before there
   * were strips mean exactly what it meant then.
   *
   * The strip is named rather than indexed, because a rule must survive
   * someone reordering their strips - and a rule that quietly moved from the
   * TV to the desk would be found at eight in the morning, by the desk.
   */
  instanceId?: string
  /** Minutes since local midnight, 0..1439. Local, because a user thinks local. */
  atMinute: number
  /**
   * Weekdays this applies on, 0 = Sunday .. 6 = Saturday.
   *
   * Empty means every day. A rule with an empty list is the common case and
   * writing out all seven for it would be a list nobody reads.
   */
  days: number[]
  action: ScheduleAction
}

/** What the caller has to tell the scheduler about the current moment. */
export interface Moment {
  /** Minutes since local midnight. */
  minute: number
  /** 0 = Sunday .. 6 = Saturday, local. */
  weekday: number
  /** A monotonic reading, only used to notice a gap. */
  atMs: number
}

export interface Scheduler {
  /**
   * Advances to `now` and returns the actions to run, in order.
   *
   * Empty on almost every call: rules are edges, and between two edges there is
   * nothing to do.
   */
  tick: (now: Moment) => ScheduleAction[]
  /** Replaces the rules. A rule whose time has already passed today does not fire. */
  setRules: (rules: readonly ScheduleRule[]) => void
  rules: () => ScheduleRule[]
  /** The last moment seen, for a panel that wants to show it. */
  lastMinute: () => number | null
}

export interface SchedulerOptions {
  /**
   * A gap longer than this means the machine was asleep or the tab was frozen,
   * rather than the scheduler simply not having been called for a while.
   *
   * Ten minutes: long enough that a throttled background tab (which fires at
   * worst once a minute) is not mistaken for a suspend, short enough that a
   * real lunch break is.
   */
  gapMs?: number
}

const DEFAULT_GAP_MS = 10 * 60 * 1000

/** Local time as the scheduler wants it. The only place a real clock is read. */
export function momentFrom (date: Date, atMs: number): Moment {
  return { minute: date.getHours() * 60 + date.getMinutes(), weekday: date.getDay(), atMs }
}

function appliesOn (rule: ScheduleRule, weekday: number): boolean {
  return rule.days.length === 0 || rule.days.includes(weekday)
}

/**
 * Whether `minute` lies in the half-open window that just elapsed.
 *
 * Half-open, and exclusive at the START: a rule at 22:00 fires once as the
 * clock reaches 22:00 and not again when the next tick reports 22:00 too.
 * Wrapping is handled because midnight is inside somebody's evening.
 */
function crossed (minute: number, from: number, to: number): boolean {
  if (from === to) return false
  return from < to
    ? minute > from && minute <= to
    : minute > from || minute <= to
}

export function createScheduler (
  initial: readonly ScheduleRule[] = [],
  options: SchedulerOptions = {}
): Scheduler {
  const gapMs = options.gapMs ?? DEFAULT_GAP_MS
  let rules: ScheduleRule[] = [...initial]
  let previous: Moment | null = null

  return {
    rules: () => rules.map((rule) => ({ ...rule, days: [...rule.days] })),
    lastMinute: () => previous?.minute ?? null,

    setRules (next: readonly ScheduleRule[]): void {
      rules = [...next]
      // `previous` deliberately survives. Resetting it would make every rule
      // earlier today fire the moment a user edits an unrelated one.
    },

    tick (now: Moment): ScheduleAction[] {
      const before = previous
      previous = now
      // The first call establishes where we are; it never fires anything, or
      // opening the panel at 22:01 would apply the 22:00 rule again.
      if (before === null) return []

      const elapsed = now.atMs - before.atMs
      const due = rules
        .filter((rule) => rule.enabled && appliesOn(rule, now.weekday))
        .filter((rule) => crossed(rule.atMinute, before.minute, now.minute))

      if (due.length === 0) return []

      if (elapsed > gapMs) {
        // The machine was asleep. Apply only the last rule that should have
        // taken effect: the others have all been superseded by it, and running
        // five hours of them in half a second would be a light show nobody
        // asked for.
        const last = due.reduce((best, rule) => (
          distanceBack(rule.atMinute, now.minute) < distanceBack(best.atMinute, now.minute) ? rule : best
        ))
        return [last.action]
      }

      // Within a normal tick, in the order they occur - two rules a minute
      // apart are two deliberate steps.
      return due
        .slice()
        .sort((a, b) => distanceBack(b.atMinute, now.minute) - distanceBack(a.atMinute, now.minute))
        .map((rule) => rule.action)
    }
  }
}

/** How many minutes ago `minute` was, relative to `now`, wrapping at midnight. */
function distanceBack (minute: number, now: number): number {
  const delta = now - minute
  return delta < 0 ? delta + MINUTES_IN_DAY : delta
}

// ---------------------------------------------------------------------------
// The wire.
// ---------------------------------------------------------------------------

/**
 * Validates a rule list off the wire or out of storage.
 *
 * Storage is a trust boundary like any other: these rules were written by some
 * earlier version of the panel and a rule at minute 9999 would simply never
 * fire, with nothing saying why.
 */
export function parseRules (value: unknown): ScheduleRule[] {
  if (!Array.isArray(value)) throw new TypeError('schedule: rules must be an array')
  const rules = value.map((entry, index) => parseRule(entry, index))
  // Ids are what the panel edits and removes rows by, so two rules sharing one
  // are edited and removed together. Repaired rather than refused: a list with
  // duplicates was written by an earlier panel whose id counter restarted on
  // every reload, and refusing it would lose every rule in it to fix one.
  const taken = new Set(rules.map((rule) => rule.id))
  const seen = new Set<string>()
  return rules.map((rule, index) => {
    let id = rule.id
    if (seen.has(id)) {
      // Free of every id in the list, later rules included, not just the ones
      // already passed.
      let n = index
      do { id = `rule-${n++}` } while (taken.has(id) || seen.has(id))
      taken.add(id)
    }
    seen.add(id)
    return id === rule.id ? rule : { ...rule, id }
  })
}

export function parseRule (value: unknown, index = 0): ScheduleRule {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`schedule: rule ${index} must be an object`)
  }
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `rule-${index}`
  if (typeof raw.atMinute !== 'number' || !Number.isInteger(raw.atMinute) ||
      raw.atMinute < 0 || raw.atMinute >= MINUTES_IN_DAY) {
    throw new RangeError(`schedule: rule ${index} atMinute must be an integer 0..1439, got ${String(raw.atMinute)}`)
  }
  const days = raw.days === undefined ? [] : parseDays(raw.days, index)
  const instanceId = typeof raw.instanceId === 'string' && raw.instanceId.trim() !== ''
    ? raw.instanceId.trim()
    : undefined
  return {
    id,
    enabled: raw.enabled !== false,
    atMinute: raw.atMinute,
    days,
    action: parseAction(raw.action, index),
    ...(instanceId === undefined ? {} : { instanceId })
  }
}

function parseDays (value: unknown, index: number): number[] {
  if (!Array.isArray(value)) throw new TypeError(`schedule: rule ${index} days must be an array`)
  const days = value.map((day) => {
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) {
      throw new RangeError(`schedule: rule ${index} day must be an integer 0..6, got ${String(day)}`)
    }
    return day
  })
  // Sorted and deduplicated so two rules that mean the same thing compare equal.
  return [...new Set(days)].sort((a, b) => a - b)
}

function parseAction (value: unknown, index: number): ScheduleAction {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`schedule: rule ${index} action must be an object`)
  }
  const raw = value as Record<string, unknown>
  switch (raw.kind) {
    case 'stop': return { kind: 'stop' }
    case 'capture': return { kind: 'capture' }
    case 'effect': return { kind: 'effect', spec: parseEffectSpec(raw.spec) }
    case 'color': {
      const color = raw.color as Record<string, unknown>
      if (typeof color !== 'object' || color === null) {
        throw new TypeError(`schedule: rule ${index} colour must be an object`)
      }
      return { kind: 'color', color: { r: channel(color.r, index), g: channel(color.g, index), b: channel(color.b, index) } }
    }
    default:
      throw new RangeError(`schedule: rule ${index} kind must be one of ${ACTION_KINDS.join(', ')}, got ${String(raw.kind)}`)
  }
}

function channel (value: unknown, index: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`schedule: rule ${index} colour channel must be an integer 0..255, got ${String(value)}`)
  }
  return value
}

/**
 * The rules one strip should actually run.
 *
 * A strip is given only its own rules rather than all of them plus a test,
 * because the scheduler's job is to fire what it holds: a filter inside it
 * would be a second place for "does this apply" to be decided, and the two
 * would disagree the first time a rule named a strip that had been deleted.
 */
export function rulesFor (rules: readonly ScheduleRule[], instanceId: string): ScheduleRule[] {
  return rules
    .filter((rule) => rule.instanceId === undefined || rule.instanceId === instanceId)
    .map((rule) => ({ ...rule, days: [...rule.days] }))
}

/** `22:05` from 1325, for a panel that shows what it stored. */
export function formatMinute (minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 1325 from `22:05`. Refuses anything else rather than guessing. */
export function parseMinute (text: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (match === null) throw new RangeError(`schedule: "${text}" is not a time of day`)
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) throw new RangeError(`schedule: "${text}" is not a time of day`)
  return h * 60 + m
}
