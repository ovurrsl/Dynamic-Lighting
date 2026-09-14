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
  fetchSchedule,
  runAudio as runAudioInExtension,
  runEffect as runEffectInExtension,
  runPattern as runPatternInExtension,
  saveConfig as saveConfigInExtension,
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
import type { ScheduleRule } from '#lib/engine/schedule'
import { loadStoredSchedule, storeSchedule } from '#lib/config-store'
import { createPageEngine, pageHostAvailable, type PageEngine } from '#lib/page-host'

/**
 * One connection to the engine, shared by everything that shows it - and now
 * the one place that knows WHICH HOST the engine is running in.
 *
 * There are two, and the difference is not cosmetic:
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
  state: EngineState
  stats: EngineStats | null
  version: string
  /** True between pressing start and the engine answering. */
  busy: boolean
  reprobe: () => void
  start: () => Promise<StartOutcome>
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
  saveSchedule: (rules: ScheduleRule[]) => Promise<ScheduleSave>
  /** Applies a configuration to whichever host is live. Null on success. */
  saveConfig: (config: EngineConfig) => Promise<string | null>
  /** One AxC control frame to the board. Null on success. */
  sendControl: (request: ControlRequest) => Promise<string | null>
}

/**
 * Two different things can go wrong when saving a schedule, and telling a user
 * "it failed" for the second one would be a lie.
 */
export interface ScheduleSave {
  /** The rules did not apply at all: a bad rule, or the engine refused them. */
  error?: string
  /**
   * They applied and are running, but this browser would not keep them across
   * a reload. Worth saying: the whole point of a rule is that it fires when
   * nobody is looking, and one that dies with the tab does not.
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

  /**
   * The page engine is built once, lazily, and only when it is actually used.
   * Building it eagerly would append a hidden `<video>` to every visitor's
   * page for a host most of them will never switch to.
   */
  const pageRef = useRef<PageEngine | null>(null)
  const pageEngine = useCallback((): PageEngine => {
    if (pageRef.current === null) {
      const built = createPageEngine((next, nextState) => {
        setStats(next)
        setState(nextState)
      })
      // The page's engine is memory, and a reload empties it. The rules come
      // back from storage as it is BUILT rather than when the schedule card
      // happens to be open, because a rule that only fires while you are
      // watching it is not a schedule.
      const stored = loadStoredSchedule()
      if (stored.rules.length > 0) {
        try {
          built.engine.setSchedule(stored.rules)
        } catch {
          // Written by an older version and no longer valid. The engine runs
          // without them; the card shows what it actually has.
        }
      }
      pageRef.current = built
    }
    return pageRef.current
  }, [])

  useEffect(() => () => { pageRef.current?.dispose() }, [])

  // Asked of the browser, not read from a table - the tables have been wrong
  // about this project three times.
  useEffect(() => { setPageCapable(pageHostAvailable()) }, [])

  useEffect(() => {
    if (host === 'page') {
      // Building the engine appends a hidden <video> to the page, so a visitor
      // with no rules does not get one. A visitor WITH rules does, because
      // otherwise they would fire only once something else happened to start
      // the engine - which on a quiet evening is never.
      const wanted = pageRef.current !== null || loadStoredSchedule().rules.length > 0
      setSchedule(wanted ? pageEngine().engine.schedule() : [])
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
      setStats(status.stats)
      setState(status.state)
      setVersion(status.version)
    }
    void tick()
    const id = setInterval(() => { void tick() }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [available, host])

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
      if (current === 'page') pageRef.current?.engine.stop()
      else void stopEngine()
      setStats(null)
      setState('idle')
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
    const { engine } = pageEngine()
    await engine.start()
    return { state: engine.state(), ...(engine.error() !== undefined ? { error: engine.error() } : {}) }
  }), [run, pageEngine])

  const selfTest = useCallback(() => run(selfTestEngine, async () => {
    const { engine } = pageEngine()
    await engine.selfTest()
    return { state: engine.state(), ...(engine.error() !== undefined ? { error: engine.error() } : {}) }
  }), [run, pageEngine])

  const runPattern = useCallback((spec: PatternSpec) => run(
    async () => await runPatternInExtension(spec),
    async () => {
      const { engine } = pageEngine()
      try {
        engine.runPattern(spec)
        return { state: engine.state() }
      } catch (error) {
        // A bad spec leaves whatever was running alone: a typo in a wizard must
        // not black out a strip that is happily following the screen.
        return { state: engine.state(), error: error instanceof Error ? error.message : String(error) }
      }
    }
  ), [run, pageEngine])

  const runEffect = useCallback((spec: EffectSpec) => run(
    async () => await runEffectInExtension(spec),
    async () => {
      const { engine } = pageEngine()
      try {
        engine.runEffect(spec)
        return { state: engine.state() }
      } catch (error) {
        return { state: engine.state(), error: error instanceof Error ? error.message : String(error) }
      }
    }
  ), [run, pageEngine])

  const runAudio = useCallback((spec: AudioSpec, input: AudioInputKind) => run(
    async () => await runAudioInExtension(spec, input),
    async () => {
      const { engine } = pageEngine()
      await engine.runAudio(spec, input)
      return { state: engine.state(), ...(engine.error() !== undefined ? { error: engine.error() } : {}) }
    }
  ), [run, pageEngine])

  const setColor = useCallback((color: { r: number, g: number, b: number }, durationMs?: number) => run(
    async () => await setStripColor(color, durationMs),
    async () => {
      const { engine } = pageEngine()
      engine.setColor(color, durationMs)
      return { state: engine.state() }
    }
  ), [run, pageEngine])

  const clearLayer = useCallback((priority: number) => run(
    async () => await clearLayerInExtension(priority),
    async () => {
      const { engine } = pageEngine()
      engine.clearLayer(priority)
      return { state: engine.state() }
    }
  ), [run, pageEngine])

  /**
   * The rules live in the ENGINE, not in the panel.
   *
   * They have to fire with no panel open - that is most of what a schedule is
   * for - so the panel reads them back rather than owning them.
   */
  const saveScheduleRules = useCallback(async (rules: ScheduleRule[]): Promise<ScheduleSave> => {
    if (hostRef.current !== 'page') {
      // The extension's service worker owns the stored copy there: it outlives
      // both the engine document and this page, and storing a second copy here
      // would give two answers to one question.
      const reply = await saveSchedule(rules)
      setSchedule(reply.rules)
      return reply.error === undefined ? {} : { error: reply.error }
    }
    try {
      const applied = pageEngine().engine.setSchedule(rules)
      setSchedule(applied)
      const problem = storeSchedule(applied)
      return problem === null ? {} : { notStored: problem }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [pageEngine])

  const stop = useCallback(async () => {
    if (hostRef.current === 'page') pageRef.current?.engine.stop()
    else await stopEngine()
    setState('idle')
  }, [])

  const saveConfig = useCallback(async (config: EngineConfig): Promise<string | null> => {
    if (hostRef.current !== 'page') return await saveConfigInExtension(config)
    try {
      pageEngine().engine.applyConfig(config)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }, [pageEngine])

  const sendControl = useCallback(async (request: ControlRequest): Promise<string | null> => {
    if (hostRef.current !== 'page') return await sendControlToExtension(request)
    try {
      await pageEngine().engine.sendControl(request)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }, [pageEngine])

  const value = useMemo<Engine>(
    () => ({
      probe, host, pageCapable, setHost, state, stats, version, busy,
      reprobe, start, selfTest, stop, runPattern, runEffect, runAudio, setColor, clearLayer,
      schedule, saveSchedule: saveScheduleRules, saveConfig, sendControl
    }),
    [probe, host, pageCapable, setHost, state, stats, version, busy,
      reprobe, start, selfTest, stop, runPattern, runEffect, runAudio, setColor, clearLayer,
      schedule, saveScheduleRules, saveConfig, sendControl]
  )

  return <EngineContext value={value}>{children}</EngineContext>
}

export function useEngine (): Engine {
  const value = useContext(EngineContext)
  if (value === null) throw new Error('useEngine used outside EngineProvider')
  return value
}
