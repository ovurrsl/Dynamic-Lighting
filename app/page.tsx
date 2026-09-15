'use client'

import { Toast } from '@heroui/react'

import { ControlPanel } from '#components/ControlPanel'
import { EngineProvider } from '#components/Engine'
import { PreferencesProvider } from '#components/Preferences'

/**
 * The panel shell.
 *
 * There is no session and no gate: AmbiFlux is open source and the panel is the
 * whole application. The two providers are the state every section shares -
 * language and theme, and the one connection to the engine.
 */
export default function Page () {
  return (
    <PreferencesProvider>
      <EngineProvider>
        {/* Mounted once. HeroUI v3 has no provider, but toasts need this. */}
        <Toast.Provider />
        <ControlPanel />
      </EngineProvider>
    </PreferencesProvider>
  )
}
