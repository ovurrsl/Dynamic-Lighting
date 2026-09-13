'use client'

import { Toast } from '@heroui/react'

import { ControlPanel } from '#components/ControlPanel'

/**
 * The panel shell.
 *
 * There is no session and no gate: AmbiFlux is open source and the panel is the
 * whole application. Nothing here holds state, which is why it is this short.
 */
export default function Page () {
  return (
    <>
      {/* Mounted once. HeroUI v3 has no provider, but toasts need this. */}
      <Toast.Provider />
      <ControlPanel />
    </>
  )
}
