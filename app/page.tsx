'use client'

import { useCallback, useEffect, useState } from 'react'
import { Toast } from '@heroui/react'

import { Activation } from '#components/Activation'
import { ControlPanel } from '#components/ControlPanel'
import { readStoredToken, refresh, storeToken, type LicenceGrant } from '#lib/client-api'

/**
 * The panel shell. Was App.tsx + main.tsx under Vite; the StrictMode wrapper and
 * the createRoot call are gone because Next owns mounting now.
 *
 * A client component on purpose: it reads localStorage and holds session state,
 * neither of which exists during a server render. Marking it any other way would
 * fail at build time during prerendering rather than at runtime, which is the
 * better of the two failures but still a failure.
 */
export default function Page () {
  const [grant, setGrant] = useState<LicenceGrant | null>(null)
  const [isRestoring, setIsRestoring] = useState(true)

  const accept = useCallback((next: LicenceGrant) => {
    storeToken(next.token)
    setGrant(next)
  }, [])

  /**
   * Restores the stored session on load.
   *
   * The refresh is opportunistic and its failure is not fatal by design: the
   * server accepts expired tokens, and the host it runs on sleeps when idle, so
   * a slow or unreachable licence call must never be the reason a customer
   * cannot open their own control panel. That is the same fail-open posture the
   * engine takes.
   */
  useEffect(() => {
    const stored = readStoredToken()
    if (stored === null) {
      setIsRestoring(false)
      return
    }

    let cancelled = false
    refresh(stored)
      .then((next) => { if (!cancelled) accept(next) })
      .catch(() => {
        // A rejected refresh means the licence is genuinely gone (revoked, or
        // the signing key rotated), so drop the token and ask again.
        if (!cancelled) storeToken(null)
      })
      .finally(() => { if (!cancelled) setIsRestoring(false) })

    return () => { cancelled = true }
  }, [accept])

  return (
    <>
      {/* Mounted once. HeroUI v3 has no provider, but toasts need this. */}
      <Toast.Provider />
      {isRestoring
        ? <div className="flex min-h-dvh items-center justify-center text-sm text-muted">Yükleniyor…</div>
        : grant === null
          ? <Activation onActivated={accept} />
          : <ControlPanel grant={grant} />}
    </>
  )
}
