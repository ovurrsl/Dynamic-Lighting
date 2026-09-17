import type { EngineConfig } from '#lib/engine/config'
import { createFanout, type Fanout } from '#lib/engine/fanout'
import {
  defaultInstances,
  parseInstances,
  type Instance
} from '#lib/engine/instances'
import { createEngine, type Engine, type EngineHost, type StopReason } from '#lib/engine/runtime'
import { parseRules, rulesFor, type ScheduleRule } from '#lib/engine/schedule'
import type { EngineState, EngineStats } from '#lib/extension/messages'

/**
 * Several strips, one screen.
 *
 * The engine was always a factory with no module state, so running two of them
 * was never the hard part. The hard part is the capture, and this file is
 * almost entirely about that one problem:
 *
 * **Instances that read the same source share one capture.** Not as an
 * optimisation - although reading a 1440p desktop twice per frame is not
 * cheap - but because a `getDisplayMedia` grant belongs to the call that made
 * it. Two engines each opening their own means two pickers, and the user who
 * picks a different window in the second one gets two strips following two
 * different things with nothing on screen explaining why.
 *
 * Instances that read DIFFERENT sources get different captures, and that is a
 * feature rather than a concession: a desk strip following the screen and a TV
 * strip following an HDMI capture card is the one arrangement that defeats DRM
 * blanking on the TV while leaving the desk on the cheap path. The grouping key
 * is exactly the settings that decide which stream opens - source, device,
 * frame rate. Everything else in the capture configuration (the crop, the
 * analysis grid) is applied per instance to the shared frame, so two strips
 * looking at different halves of the same screen still cost one capture.
 *
 * What the pool deliberately does NOT do is proxy the engine. `engine(id)`
 * hands back the real thing and the caller drives it. A pool that wrapped all
 * seventeen methods would be seventeen places for the two to drift, and the
 * panel already has to know which strip it is talking to.
 */

export interface InstanceReport {
  id: string
  name: string
  enabled: boolean
  state: EngineState
  stats: EngineStats | null
  error?: string
}

export interface PoolStats {
  instances: InstanceReport[]
  /**
   * How many separate captures are open.
   *
   * Worth showing: it is the number of pickers the user was asked to answer,
   * and if it is not the number they expected then two instances disagree
   * about their source and the panel can say which.
   */
  captures: number
}

export interface EnginePool {
  instances: () => Instance[]
  /** Validates and reconciles: engines are added, removed and reconfigured to match. */
  setInstances: (value: unknown) => Instance[]
  /** The engine driving one instance, or null if there is no such instance. */
  engine: (id: string) => Engine | null
  /** Every engine, in instance order. */
  engines: () => Engine[]
  /**
   * Replaces the time-of-day rules for every strip at once.
   *
   * The pool owns the MASTER list and each engine holds only its own slice, so
   * this is where a rule that names a strip is routed and where a strip added
   * later picks up the rules that were waiting for it.
   */
  setSchedule: (rules: unknown) => ScheduleRule[]
  /** The master list, which is what a panel edits. */
  schedule: () => ScheduleRule[]
  /** Starts the capture on every enabled instance. One picker per distinct source. */
  start: () => Promise<void>
  /** Runs the generated self-test picture on every enabled instance. */
  selfTest: () => Promise<void>
  stop: (reason?: StopReason) => void
  stats: () => PoolStats
  /** Stops everything and lets go of every capture. */
  dispose: () => Promise<void>
}

export interface PoolOptions {
  /** Called whenever any instance reports. */
  onReport?: (stats: PoolStats) => void
}

/**
 * What decides which stream opens.
 *
 * Crop and grid are absent on purpose: both are applied to the frame after it
 * arrives, so two strips looking at different rectangles of one screen are one
 * capture and not two.
 */
export function sourceKey (config: EngineConfig): string {
  const capture = config.capture
  const source = capture.source ?? 'screen'
  return source === 'device'
    ? `device:${capture.deviceId ?? ''}:${capture.fps}`
    : `screen:${capture.fps}`
}

interface Slot {
  instance: Instance
  engine: Engine
  state: EngineState
  stats: EngineStats | null
}

export function createEnginePool (
  host: EngineHost,
  initial: readonly Instance[] = defaultInstances(),
  options: PoolOptions = {}
): EnginePool {
  const slots: Slot[] = []
  /** One per distinct source, plus one for the self-test picture. */
  const fanouts = new Map<string, Fanout>()
  /**
   * In-flight opens, keyed the same way.
   *
   * Without this the pool would open one capture per instance whenever they
   * start together, which is exactly when they always start - so the picker
   * race is the normal case, not an edge one.
   */
  const opening = new Map<string, Promise<Fanout>>()

  /**
   * The master rule list.
   *
   * Held here rather than in the engines because each of them holds only the
   * rules that apply to IT, and a panel asking one engine what the schedule is
   * would get a list with the other strips' rules missing.
   */
  let rules: ScheduleRule[] = []

  function report (): void {
    options.onReport?.(stats())
  }

  function stats (): PoolStats {
    return {
      instances: slots.map((slot) => {
        const error = slot.engine.error()
        return {
          id: slot.instance.id,
          name: slot.instance.name,
          enabled: slot.instance.enabled,
          state: slot.state,
          stats: slot.stats,
          ...(error === undefined ? {} : { error })
        }
      }),
      // Only the captures that are actually open: a fanout whose last consumer
      // left is kept in the map until the next `share` discards it.
      captures: [...fanouts.values()].filter((fan) => !fan.ended()).length
    }
  }

  /**
   * Opens, or joins, the capture for one configuration.
   *
   * A fanout whose upstream has finished is discarded rather than reused: the
   * track is gone and attaching to it hands the engine a source that ends the
   * instant it starts, which on a panel reads as a capture that refuses to run
   * for no stated reason.
   */
  async function share (
    key: string,
    open: (config: EngineConfig) => Promise<import('#lib/engine/source').FrameSource>,
    config: EngineConfig
  ): Promise<import('#lib/engine/source').FrameSource> {
    const existing = fanouts.get(key)
    if (existing !== undefined && !existing.ended()) return existing.attach()
    if (existing !== undefined) fanouts.delete(key)

    let pending = opening.get(key)
    if (pending === undefined) {
      pending = open(config)
        .then((source) => {
          const fan = createFanout(source)
          fanouts.set(key, fan)
          return fan
        })
        .finally(() => { opening.delete(key) })
      opening.set(key, pending)
    }
    return (await pending).attach()
  }

  function hostFor (id: string): EngineHost {
    return {
      clock: host.clock,
      createCanvas: host.createCanvas,
      openSource: async (config) => await share(sourceKey(config), host.openSource, config),
      ...(host.openSelfTest === undefined
        ? {}
        : {
            // One generated picture for every strip. It is a test of the whole
            // chain, and running it on one strip at a time would make "do both
            // of my strips work" two separate answers.
            openSelfTest: async (config) => await share('selftest', host.openSelfTest as (c: EngineConfig) => Promise<import('#lib/engine/source').FrameSource>, config)
          }),
      onReport: (engineStats, state) => {
        const slot = slots.find((candidate) => candidate.instance.id === id)
        if (slot === undefined) return
        slot.stats = engineStats
        slot.state = state
        report()
      }
    }
  }

  function build (instance: Instance): Slot {
    const engine = createEngine(hostFor(instance.id))
    engine.applyConfig(instance.config)
    // A strip added while rules are already in force starts with the ones that
    // name it, rather than waiting for the next time somebody opens the
    // schedule page.
    if (rules.length > 0) engine.setSchedule(rulesFor(rules, instance.id))
    return { instance, engine, state: 'idle', stats: null }
  }

  function apply (next: Instance[]): Instance[] {
    // Removed first, so an id being reused by a new instance in the same call
    // gets a fresh engine rather than the departing one's.
    for (let i = slots.length - 1; i >= 0; i--) {
      const slot = slots[i] as Slot
      if (next.some((instance) => instance.id === slot.instance.id)) continue
      slot.engine.stop('user')
      slots.splice(i, 1)
    }

    next.forEach((instance, index) => {
      const found = slots.findIndex((slot) => slot.instance.id === instance.id)
      if (found === -1) {
        slots.splice(index, 0, build(instance))
        return
      }
      const slot = slots[found] as Slot
      const wasEnabled = slot.instance.enabled
      slot.instance = instance
      // Its rules are re-routed too: a rule can name a strip that has just been
      // switched on, or stop naming one that has just been renamed away.
      if (rules.length > 0) slot.engine.setSchedule(rulesFor(rules, instance.id))
      // Applied rather than rebuilt: an engine that is running keeps running,
      // and a layout edit on one strip must not black out the other.
      slot.engine.applyConfig(instance.config)
      if (wasEnabled && !instance.enabled) slot.engine.stop('user')
      // Re-ordering the list is a panel decision, so honour it here too.
      if (found !== index) slots.splice(index, 0, ...slots.splice(found, 1))
    })

    report()
    return next
  }

  apply(parseInstances(structuredCloneOrCopy(initial)))

  async function startEach (run: (engine: Engine) => Promise<void>): Promise<void> {
    const enabled = slots.filter((slot) => slot.instance.enabled)
    // Said rather than silently done: a Start with every strip switched off
    // used to return with the state idle and nothing on the page explaining
    // why the press did nothing.
    if (enabled.length === 0) throw new Error('hiçbir şerit açık değil')
    // Together rather than one at a time: the whole point of `share` is that
    // simultaneous starts collapse onto one picker, and starting them in
    // sequence would open the second capture before the first had a consumer.
    const results = await Promise.allSettled(enabled.map(async (slot) => { await run(slot.engine) }))
    report()
    const failed = results.find((result) => result.status === 'rejected')
    // One instance failing is reported through its own `error()`; the throw is
    // kept so a caller that started exactly one strip still learns why.
    if (failed !== undefined && enabled.length === 1) throw (failed as PromiseRejectedResult).reason
  }

  return {
    instances: () => slots.map((slot) => ({ ...slot.instance })),
    engine: (id) => slots.find((slot) => slot.instance.id === id)?.engine ?? null,
    engines: () => slots.map((slot) => slot.engine),
    stats,

    setInstances (value: unknown): Instance[] {
      return apply(parseInstances(value))
    },

    setSchedule (value: unknown): ScheduleRule[] {
      // Parsed ONCE here rather than once per engine: eight engines each
      // rejecting the same bad rule is eight different error messages for one
      // mistake, and only the first would ever be shown.
      const parsed = parseRules(value)
      rules = parsed
      for (const slot of slots) slot.engine.setSchedule(rulesFor(parsed, slot.instance.id))
      return parsed.map((rule) => ({ ...rule, days: [...rule.days] }))
    },

    schedule: () => rules.map((rule) => ({ ...rule, days: [...rule.days] })),

    async start (): Promise<void> {
      await startEach(async (engine) => { await engine.start() })
    },

    async selfTest (): Promise<void> {
      await startEach(async (engine) => { await engine.selfTest() })
    },

    stop (reason?: StopReason): void {
      for (const slot of slots) slot.engine.stop(reason)
      report()
    },

    async dispose (): Promise<void> {
      // The rules go before the engines do, and this is not tidiness: the
      // scheduler deliberately ticks whether or not anything is showing, so
      // that "start the capture at eight" works on a strip that is idle. That
      // means `stop` does NOT stop it, and a disposed pool would otherwise
      // leave one 1 Hz timer per strip firing rules at engines nobody can see -
      // in the page host, for the rest of the tab's life.
      rules = []
      for (const slot of slots) slot.engine.setSchedule([])
      for (const slot of slots) slot.engine.stop('user')
      const open = [...fanouts.values()]
      fanouts.clear()
      opening.clear()
      await Promise.allSettled(open.map(async (fan) => { await fan.stop() }))
    }
  }
}

/**
 * A copy that does not depend on `structuredClone` being present.
 *
 * The initial list is re-validated on the way in, and validation reads it
 * rather than mutating it - but the caller keeps a reference to what it passed,
 * and a pool that shared objects with its caller would let an edit to a stored
 * list reach a running engine without anything applying it.
 */
function structuredCloneOrCopy (value: readonly Instance[]): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}
