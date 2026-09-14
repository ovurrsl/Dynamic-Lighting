'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { EngineConfig } from '#lib/engine/config'
import type { AudioSpec } from '#lib/engine/audio'
import type { AudioInputKind } from '#lib/engine/audio-input'
import type { EffectSpec } from '#lib/engine/effects'
import type { PatternSpec } from '#lib/engine/patterns'
import {
  fetchStatus,
  probeExtension,
  clearLayer as clearLayerInExtension,
  fetchInstances,
  fetchSchedule,
  runAudio as runAudioInExtension,
  runEffect as runEffectInExtension,
  runPattern as runPatternInExtension,
  saveConfig as saveConfigInExtension,
  saveInstances as saveInstancesInExtension,
  saveSchedule,
  selfTestEngine,
  setStripColor,
  sendControl as sendControlToExtension,
  startEngine,
  stopEngine,
  type ExtensionProbe,
  type StartOutcome
} from '#lib/extension-client'
import type { ControlRequest, EngineState, EngineStats } from '#lib/extension/messages'
import { defaultInstances, updateInstance, type Instance } from '#lib/engine/instances'
import type { PoolStats } from '#lib/engine/pool'
import type { ScheduleRule } from '#lib/engine/schedule'
import { loadStoredInstances, loadStoredSchedule, storeInstances, storeSchedule } from '#lib/config-store'
import { createPageEngine, pageHostAvailable, type PageEngine } from '#lib/page-host'

/**
 * One connection to the engine, shared by everything that shows it - and now
 * the one place that knows WHICH HOST the engine is running in, and WHICH STRIP
 * the panel is talking to.
 *
 * There are two hosts, and the difference is not cosmetic:
 *
 * - **'extension'** is the Chrome extension's offscreen document. It is never
 *   rendered, so it is never hidden and never throttled. That is the whole
 *   reason it exists and it remains the right answer on a Chromium desktop -
 *   it is the only host that keeps up while someone plays a full-screen game.
 * - **'page'** is this page. It works in every browser that can capture a
 *   screen, which since the network drivers means an iPhone can run the whole
 *   application - but it is throttled the moment the tab is hidden, and the
 *   panel says so rather than letting the counters say it an hour later.
 *
 * Since multiple strips, each host drives a POOL rather than one engine. The
 * split that keeps every card working unchanged:
 *
 * - **Starting and stopping are pool-wide.** "Start the capture" means every
 *   strip, because they share one capture and one picker; asking per strip
 *   would ask for the screen again for the second one.
 * - **Everything else addresses the ACTIVE strip** - colour, effects, audio,
 *   configuration, the board's own settings. `stats` and `state` are that
 *   strip's too, so a card written before instances neither knows nor needs to.
 *
 * Everything above this file calls `useEngine()` and never asks which host it
 * got. That is deliberate: the moment a card branches on the host, the two
 * paths drift and one of them stops being tested.
 */

export type EngineHostKind = 'extension' | 'page'

export interface Engine {
  /** Null while the first probe is in flight; the UI shows that as "looking". */
  probe: ExtensionProbe | null
  /** Which host is driving. */
  host: EngineHostKind
  /** Whether this browser could run the engine in the page at all. */
  pageCapable: boolean
  setHost: (host: EngineHostKind) => void
  /** The active strip's state. */
  state: EngineState
  /** The active strip's statistics. */
  stats: EngineStats | null
  version: string
  /** True between pressing start and the engine answering. */
  busy: boolean
  reprobe: () => void
  /** Starts the capture on EVERY enabled strip: one picker, one stream. */
  start: () => Promise<StartOutcome>
  /** The generated picture, on every enabled strip at once. */
  selfTest: () => Promise<StartOutcome>
  stop: () => Promise<void>
  runPattern: (spec: PatternSpec) => Promise<StartOutcome>
  /** Starts an effect. Unlike a pattern this is content and is smoothed. */
  runEffect: (spec: EffectSpec) => Promise<StartOutcome>
  /** Starts an audio visualiser on the microphone or on tab audio. */
  runAudio: (spec: AudioSpec, input: AudioInputKind) => Promise<StartOutcome>
  /**
   * Drives the strip with one colour. With a duration it interrupts whatever
   * is showing and expires on its own; without, it is a base underneath it.
   */
  setColor: (color: { r: number, g: number, b: number }, durationMs?: number) => Promise<StartOutcome>
  /** Drops one priority layer, revealing whatever was under it. */
  clearLayer: (priority: number) => Promise<StartOutcome>
  /** The time-of-day rules in force, or null while they are being fetched. */
  schedule: ScheduleRule[] | null
  /** Replaces them. */
  saveSchedule: (rules: ScheduleRule[]) => Promise<SaveResult>
  /** Applies a configuration to the ACTIVE strip. */
  saveConfig: (config: EngineConfig) => Promise<SaveResult>
  /** One AxC control frame to the active strip's board. Null on success. */
  sendControl: (request: ControlRequest) => Promise<string | null>

  /** Every strip this installation drives, in the order the panel shows them. */
  instances: Instance[]
  /** Which one every per-strip control above is addressing. */
  activeId: string
  setActiveId: (id: string) => void
  /** Replaces the whole list: add, remove, rename, reorder, enable. */
  saveInstances: (instances: readonly Instance[]) => Promise<SaveResult>
  /** Per-strip state and statistics, when the host reports them. */
  pool: PoolStats | null
}

/**
 * Two different things can go wrong when saving anything the panel keeps - a
 * rule, a strip, a configuration - and telling a user "it failed" for the
 * second one would be a lie.
 */
export interface SaveResult {
  /** It did not apply at all: a bad value, or the engine refused it. */
  error?: string
  /**
   * It applied and is running, but this browser would not keep it across a
   * reload. Worth saying: the whole point of a rule, or of a second strip, is
   * that it is still there tomorrow.
   */
  notStored?: string
}

const EngineContext = createContext<Engine | null>(null)

const POLL_MS = 1000

export function EngineProvider ({ children }: { children: React.ReactNode }) {
  const [probe, setProbe] = useState<ExtensionProbe | null>(null)
  const [stats, setStats] = useState<EngineStats | null>(null)
  const [state, setState] = useState<EngineState>('idle')
  const [version, setVersion] = useState('')
  const [busy, setBusy] = useState(false)
  const [host, setHostState] = useState<EngineHostKind>('extension')
  const [pageCapable, setPageCapable] = useState(false)
  const [schedule, setSchedule] = useState<ScheduleRule[] | null>(null)
  const [instances, setInstances] = useState<Instance[]>(defaultInstances)
  const [activeId, setActiveIdState] = useState<string>(() => (defaultInstances()[0] as Instance).id)
  const [pool, setPool] = useState<PoolStats | null>(null)

  /**
   * The strip every per-strip control addresses.
   *
   * Held in a ref as well as in state because the callbacks below are handed to
   * buttons all over the panel and must not change identity on every poll.
   */
  const activeRef = useRef(activeId)
  activeRef.current = activeId

  /**
   * Takes one pool report and splits it the way the panel reads it: the active
   * strip's numbers flat, everything else under `pool`.
   */
  const absorb = useCallback((next: PoolStats) => {
    setPool(next)
    const mine = next.instances.find((instance) => instance.id === activeRef.current) ?? next.instances[0]
    setStats(mine?.stats ?? null)
    setState(mine?.state ?? 'idle')
  }, [])

  /**
   * The page engine is built once, lazily, and only when it is actually used.
   * Building it eagerly would append a hidden `<video>` to every visitor's
   * page for a host most of them will never switch to.
   */
  const pageRef = useRef<PageEngine | null>(null)
  const pageEngine = useCallback((): PageEngine => {
    if (pageRef.current === null) {
      const stored = loadStoredInstances()
      const built = createPageEngine(absorb, stored.instances)
      // The page's engines are memory, and a reload empties them. The rules
      // come back from storage as they are BUILT rather than when the schedule
      // card happens to be open, because a rule that only fires while you are
      // watching it is not a schedule.
      const rules = loadStoredSchedule().rules
      if (rules.length > 0) {
        for (const engine of built.pool.engines()) {
          try {
            engine.setSchedule(rules)
          } catch {
            // Written by an older version and no longer valid. The engines run
            // without them; the card shows what they actually have.
          }
        }
      }
      pageRef.current = built
    }
    return pageRef.current
  }, [absorb])

  useEffect(() => () => { pageRef.current?.dispose() }, [])

  // Asked of the browser, not read from a table - the tables have been wrong
  // about this project three times.
  useEffect(() => { setPageCapable(pageHostAvailable()) }, [])

  /**
   * The strip list, from whichever side owns it.
   *
   * The extension's service worker owns it there - it outlives both the engine
   * document and this page. In the page host `localStorage` does, and the list
   * is seeded into the pool as it is built.
   */
  useEffect(() => {
    if (host === 'page') {
      setInstances(pageRef.current?.pool.instances() ?? loadStoredInstances().instances)
      return
    }
    if (probe?.available !== true) return
    let cancelled = false
    void fetchInstances().then((list) => {
      if (!cancelled && list !== null) setInstances(list)
    })
    return () => { cancelled = true }
  }, [host, probe])

  /** An active strip that has been deleted would address nothing at all. */
  useEffect(() => {
    if (instances.length === 0) return
    if (instances.some((instance) => instance.id === activeId)) return
    setActiveIdState((instances[0] as Instance).id)
  }, [instances, activeId])

  useEffect(() => {
    if (host === 'page') {
      // Building the engines appends a hidden <video> to the page, so a visitor
      // with no rules does not get one. A visitor WITH rules does, because
      // otherwise they would fire only once something else happened to start
      // the engine - which on a quiet evening is never.
      const wanted = pageRef.current !== null || loadStoredSchedule().rules.length > 0
      setSchedule(wanted ? pageEngine().pool.engines()[0]?.schedule() ?? [] : [])
      return
    }
    if (probe?.available !== true) return
    let cancelled = false
    void fetchSchedule().then((rules) => { if (!cancelled) setSchedule(rules) })
    return () => { cancelled = true }
  }, [host, probe, pageEngine])

  const reprobe = useCallback(() => {
    setProbe(null)
    void probeExtension().then(setProbe)
  }, [])

  useEffect(() => { reprobe() }, [reprobe])

  /**
   * With no extension there is nothing to choose: the page is the only host,
   * so it is selected rather than offered. Someone who installs the extension
   * later gets it back on the next probe.
   */
  const available = probe?.available === true
  useEffect(() => {
    if (probe === null) return
    if (!available && pageCapable) setHostState('page')
    if (available) setHostState((current) => (current === 'page' ? current : 'extension'))
  }, [probe, available, pageCapable])

  /**
   * Polls the extension only while it answers AND is the live host. A missing
   * extension polled once a second is a second of console noise per second,
   * forever, on a page that already knows the answer - and the page host does
   * not poll at all, because it pushes.
   */
  useEffect(() => {
    if (!available || host !== 'extension') return
    let cancelled = false
    const tick = async (): Promise<void> => {
      const status = await fetchStatus()
      if (cancelled) return
      if (status === null) {
        // It answered the probe and then stopped answering: the extension was
        // disabled or removed while the page was open. Say so rather than
        // showing the last numbers forever.
        setProbe({ available: false, reason: 'not-installed', detail: 'yanıt yok' })
        return
      }
      setVersion(status.version)
      if (status.pool !== undefined) {
        absorb(status.pool)
        return
      }
      // An extension one version behind sends no pool. Its numbers are still
      // the numbers, and showing them flat is better than showing nothing.
      setStats(status.stats)
      setState(status.state)
      setPool(null)
    }
    void tick()
    const id = setInterval(() => { void tick() }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [available, host, absorb])

  /**
   * Switching hosts STOPS the one being left.
   *
   * Two engines driving one strip would interleave frames from two capture
   * sessions, and the user would see a strip that flickers between two
   * pictures with nothing in the panel explaining why.
   */
  const setHost = useCallback((next: EngineHostKind) => {
    setHostState((current) => {
      if (current === next) return current
      if (current === 'page') pageRef.current?.pool.stop()
      else void stopEngine()
      setStats(null)
      setState('idle')
      setPool(null)
      return next
    })
  }, [])

  /**
   * Held in a ref so the callbacks below never change identity: they are passed
   * to buttons in several sections, and a new function on every poll would
   * re-render all of them once a second.
   */
  const busyRef = useRef(false)
  const hostRef = useRef<EngineHostKind>('extension')
  hostRef.current = host

  /** The active strip's engine in the page host, built on demand. */
  const activeEngine = useCallback(() => {
    const { pool: pooled } = pageEngine()
    return pooled.engine(activeRef.current) ?? pooled.engines()[0] ?? null
  }, [pageEngine])

  const run = useCallback(async (
    extension: () => Promise<StartOutcome>,
    page: () => Promise<StartOutcome>
  ): Promise<StartOutcome> => {
    if (busyRef.current) return { state: 'starting' }
    busyRef.current = true
    setBusy(true)
    try {
      const result = await (hostRef.current === 'page' ? page() : extension())
      setState(result.state)
      return result
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  const start = useCallback(() => run(startEngine, async () => {
    await pageEngine().pool.start()
    const engine = activeEngine()
    const error = engine?.error()
    return { state: engine?.state() ?? 'idle', ...(error === undefined ? {} : { error }) }
  }), [run, pageEngine, activeEngine])

  const selfTest = useCallback(() => run(selfTestEngine, async () => {
    await pageEngine().pool.selfTest()
    const engine = activeEngine()
    const error = engine?.error()
    return { state: engine?.state() ?? 'idle', ...(error === undefined ? {} : { error }) }
  }), [run, pageEngine, activeEngine])

  const runPattern = useCallback((spec: PatternSpec) => run(
    async () => await runPatternInExtension(spec, activeRef.current),
    async () => {
      const engine = activeEngine()
      if (engine === null) return { state: 'idle' }
      try {
        engine.runPattern(spec)
        return { state: engine.state() }
      } catch (error) {
        // A bad spec leaves whatever was running alone: a typo in a wizard must
        // not black out a strip that is happily following the screen.
        return { state: engine.state(), error: error instanceof Error ? error.message : String(error) }
      }
    }
  ), [run, activeEngine])

  const runEffect = useCallback((spec: EffectSpec) => run(
    async () => await runEffectInExtension(spec, activeRef.current),
    async () => {
      const engine = activeEngine()
      if (engine === null) return { state: 'idle' }
      try {
        engine.runEffect(spec)
        return { state: engine.state() }
      } catch (error) {
        return { state: engine.state(), error: error instanceof Error ? error.message : String(error) }
      }
    }
  ), [run, activeEngine])

  const runAudio = useCallback((spec: AudioSpec, input: AudioInputKind) => run(
    async () => await runAudioInExtension(spec, input, activeRef.current),
    async () => {
      const engine = activeEngine()
      if (engine === null) return { state: 'idle' }
      await engine.runAudio(spec, input)
      const error = engine.error()
      return { state: engine.state(), ...(error === undefined ? {} : { error }) }
    }
  ), [run, activeEngine])

  const setColor = useCallback((color: { r: number, g: number, b: number }, durationMs?: number) => run(
    async () => await setStripColor(color, durationMs, activeRef.current),
    async () => {
      const engine = activeEngine()
      if (engine === null) return { state: 'idle' }
      engine.setColor(color, durationMs)
      return { state: engine.state() }
    }
  ), [run, activeEngine])

  const clearLayer = useCallback((priority: number) => run(
    async () => await clearLayerInExtension(priority, activeRef.current),
    async () => {
      const engine = activeEngine()
      if (engine === null) return { state: 'idle' }
      engine.clearLayer(priority)
      return { state: engine.state() }
    }
  ), [run, activeEngine])

  /**
   * The rules live in the ENGINE, not in the panel.
   *
   * They have to fire with no panel open - that is most of what a schedule is
   * for - so the panel reads them back rather than owning them. They reach
   * every strip: an action only some of them obeyed would need the rule to say
   * which, and until it can, half a room is worse than all of it.
   */
  const saveScheduleRules = useCallback(async (rules: ScheduleRule[]): Promise<SaveResult> => {
    if (hostRef.current !== 'page') {
      // The extension's service worker owns the stored copy there: it outlives
      // both the engine document and this page, and storing a second copy here
      // would give two answers to one question.
      const reply = await saveSchedule(rules)
      setSchedule(reply.rules)
      return reply.error === undefined ? {} : { error: reply.error }
    }
    try {
      let applied: ScheduleRule[] = []
      for (const engine of pageEngine().pool.engines()) applied = engine.setSchedule(rules)
      setSchedule(applied)
      const problem = storeSchedule(applied)
      return problem === null ? {} : { notStored: problem }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [pageEngine])

  /**
   * Replaces the whole strip list.
   *
   * Whole rather than per strip because adding, removing and reordering are all
   * edits to the LIST, and a partial update would need both sides to agree on
   * what a partial update means.
   */
  const saveInstanceList = useCallback(async (next: readonly Instance[]): Promise<SaveResult> => {
    if (hostRef.current !== 'page') {
      const reply = await saveInstancesInExtension(next)
      if (reply.instances !== null) setInstances(reply.instances)
      return reply.error === undefined ? {} : { error: reply.error }
    }
    try {
      const applied = pageEngine().pool.setInstances(next)
      setInstances(applied)
      const problem = storeInstances(applied)
      return problem === null ? {} : { notStored: problem }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [pageEngine])

  const stop = useCallback(async () => {
    if (hostRef.current === 'page') pageRef.current?.pool.stop()
    else await stopEngine()
    setState('idle')
  }, [])

  const saveConfig = useCallback(async (config: EngineConfig): Promise<SaveResult> => {
    if (hostRef.current !== 'page') {
      const error = await saveConfigInExtension(config, activeRef.current)
      if (error === null) setInstances((current) => updateInstance(current, activeRef.current, { config }))
      return error === null ? {} : { error }
    }
    try {
      // Through the pool rather than straight at the engine, so the stored list
      // and the running engine cannot disagree about what this strip is.
      const pooled = pageEngine().pool
      const applied = pooled.setInstances(updateInstance(pooled.instances(), activeRef.current, { config }))
      setInstances(applied)
      const problem = storeInstances(applied)
      return problem === null ? {} : { notStored: problem }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [pageEngine])

  const sendControl = useCallback(async (request: ControlRequest): Promise<string | null> => {
    if (hostRef.current !== 'page') return await sendControlToExtension(request, activeRef.current)
    try {
      const engine = activeEngine()
      if (engine === null) return 'şerit bulunamadı'
      await engine.sendControl(request)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }, [activeEngine])

  const setActiveId = useCallback((id: string) => {
    setActiveIdState(id)
    // The numbers on screen belong to the strip that was selected a moment ago;
    // leaving them up while the new one's first report arrives would show one
    // strip's frame rate under another strip's name.
    setStats(null)
  }, [])

  const value = useMemo<Engine>(
    () => ({
      probe, host, pageCapable, setHost, state, stats, version, busy,
      reprobe, start, selfTest, stop, runPattern, runEffect, runAudio, setColor, clearLayer,
      schedule, saveSchedule: saveScheduleRules, saveConfig, sendControl,
      instances, activeId, setActiveId, saveInstances: saveInstanceList, pool
    }),
    [probe, host, pageCapable, setHost, state, stats, version, busy,
      reprobe, start, selfTest, stop, runPattern, runEffect, runAudio, setColor, clearLayer,
      schedule, saveScheduleRules, saveConfig, sendControl,
      instances, activeId, setActiveId, saveInstanceList, pool]
  )

  return <EngineContext value={value}>{children}</EngineContext>
}

export function useEngine (): Engine {
  const value = useContext(EngineContext)
  if (value === null) throw new Error('useEngine used outside EngineProvider')
  return value
}
