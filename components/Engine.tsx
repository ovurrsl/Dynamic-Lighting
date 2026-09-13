'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import {
  fetchStatus,
  probeExtension,
  selfTestEngine,
  startEngine,
  stopEngine,
  type ExtensionProbe,
  type StartOutcome
} from '#lib/extension-client'
import type { EngineState, EngineStats } from '#lib/extension/messages'

/**
 * One connection to the engine, shared by everything that shows it.
 *
 * Before the panel was split into sections there was one card reading the
 * extension, so it polled for itself. Now the sidebar badge, the overview and
 * the device page all want the same numbers at the same moment - and three
 * independent one-second pollers would triple the traffic, disagree with each
 * other by up to a second, and make the badge flicker against the page beside
 * it. So the poll lives here and there is exactly one.
 */

export interface Engine {
  /** Null while the first probe is in flight; the UI shows that as "looking". */
  probe: ExtensionProbe | null
  state: EngineState
  stats: EngineStats | null
  version: string
  /** True between pressing start and the engine answering. */
  busy: boolean
  reprobe: () => void
  start: () => Promise<StartOutcome>
  selfTest: () => Promise<StartOutcome>
  stop: () => Promise<void>
}

const EngineContext = createContext<Engine | null>(null)

const POLL_MS = 1000

export function EngineProvider ({ children }: { children: React.ReactNode }) {
  const [probe, setProbe] = useState<ExtensionProbe | null>(null)
  const [stats, setStats] = useState<EngineStats | null>(null)
  const [state, setState] = useState<EngineState>('idle')
  const [version, setVersion] = useState('')
  const [busy, setBusy] = useState(false)

  const reprobe = useCallback(() => {
    setProbe(null)
    void probeExtension().then(setProbe)
  }, [])

  useEffect(() => { reprobe() }, [reprobe])

  /**
   * Polls only while the extension answers. A missing extension polled once a
   * second is a second of console noise per second, forever, on a page that
   * already knows the answer.
   */
  const available = probe?.available === true
  useEffect(() => {
    if (!available) return
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
  }, [available])

  /**
   * Held in a ref so the callbacks below never change identity: they are passed
   * to buttons in several sections, and a new function on every poll would
   * re-render all of them once a second.
   */
  const busyRef = useRef(false)

  const run = useCallback(async (call: () => Promise<StartOutcome>): Promise<StartOutcome> => {
    if (busyRef.current) return { state: 'starting' }
    busyRef.current = true
    setBusy(true)
    try {
      const result = await call()
      setState(result.state)
      return result
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  const start = useCallback(() => run(startEngine), [run])
  const selfTest = useCallback(() => run(selfTestEngine), [run])

  const stop = useCallback(async () => {
    await stopEngine()
    setState('idle')
  }, [])

  const value = useMemo<Engine>(
    () => ({ probe, state, stats, version, busy, reprobe, start, selfTest, stop }),
    [probe, state, stats, version, busy, reprobe, start, selfTest, stop]
  )

  return <EngineContext value={value}>{children}</EngineContext>
}

export function useEngine (): Engine {
  const value = useContext(EngineContext)
  if (value === null) throw new Error('useEngine used outside EngineProvider')
  return value
}
