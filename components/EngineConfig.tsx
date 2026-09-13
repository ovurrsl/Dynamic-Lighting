'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'

import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from '#lib/engine/config'

/**
 * The rig's configuration, shared across sections.
 *
 * This state used to live in the one page component that rendered every card,
 * which worked precisely because there was one. With the panel split into
 * sections the layout editor, the profile list and the strip preview are on
 * three different pages and must not disagree about what the strip is running -
 * and a section that unmounts must not lose the draft someone was editing.
 *
 * Three values, and the distinction between them is the whole design:
 *
 * - `config` is what the engine is actually running.
 * - `draft` is what the layout editor currently shows. Saving a profile saves
 *   THIS: someone who tweaks the band depth and presses Save means the layout
 *   in front of them, not the one the strip happens to be on.
 * - `loaded` is a profile handed to the editor as a draft. It is never applied
 *   here, so the rule holds everywhere: the strip changes on Apply, not while
 *   somebody browses.
 */

export interface EngineConfigStore {
  config: EngineConfig
  setConfig: (config: EngineConfig) => void
  draft: EngineConfig
  setDraft: (config: EngineConfig) => void
  /** Keyed by `at` so loading the same profile twice still takes effect. */
  loaded: { config: EngineConfig, at: number } | undefined
  load: (config: EngineConfig) => void
}

const Context = createContext<EngineConfigStore | null>(null)

export function EngineConfigProvider ({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<EngineConfig>(DEFAULT_ENGINE_CONFIG as EngineConfig)
  const [draft, setDraft] = useState<EngineConfig>(DEFAULT_ENGINE_CONFIG as EngineConfig)
  const [loaded, setLoaded] = useState<{ config: EngineConfig, at: number } | undefined>(undefined)

  const load = useCallback((next: EngineConfig) => {
    setLoaded({ config: next, at: Date.now() })
  }, [])

  const value = useMemo<EngineConfigStore>(
    () => ({ config, setConfig, draft, setDraft, loaded, load }),
    [config, draft, loaded, load]
  )

  return <Context value={value}>{children}</Context>
}

export function useEngineConfig (): EngineConfigStore {
  const value = useContext(Context)
  if (value === null) throw new Error('useEngineConfig used outside EngineConfigProvider')
  return value
}
