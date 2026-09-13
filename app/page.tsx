'use client'

import { Toast } from '@heroui/react'

import { ControlPanel } from '#components/ControlPanel'
import { PreferencesProvider } from '#components/Preferences'

/**
 * The panel shell.
 *
 * There is no session and no gate: AmbiFlux is open source and the panel is the
 * whole application. Nothing here holds state except the language and theme,
 * which every card below reads.
 */
export default function Page () {
  return (
    <PreferencesProvider>
      {/* Mounted once. HeroUI v3 has no provider, but toasts need this. */}
      <Toast.Provider />
      <ControlPanel />
    </PreferencesProvider>
  )
}
