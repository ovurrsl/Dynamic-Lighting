'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Surface } from '@heroui/react'

import { useTranslate } from '#components/Preferences'
import { fetchStatus, probeExtension, stopEngine, type ExtensionProbe } from '#lib/extension-client'
import type { MessageKey } from '#lib/i18n/strings'
import type { EngineState, EngineStats } from '#lib/extension/messages'

/**
 * The state and link names are keys, not text: the engine reports an enum and
 * the panel has to be able to say it in whatever language is chosen. Mapping to
 * keys here rather than to strings keeps the compiler checking that every enum
 * member has one.
 */
const STATE_KEY: Record<EngineState, MessageKey> = {
  idle: 'device.state.idle',
  starting: 'device.state.starting',
  running: 'device.state.running',
  error: 'device.state.error'
}

const LINK_KEY = {
  none: 'device.link.none',
  loopback: 'device.link.loopback',
  port: 'device.link.port'
} as const satisfies Record<string, MessageKey>

const fmt = (n: number, digits = 1): string => (Number.isFinite(n) ? n.toFixed(digits) : '–')

/**
 * The live view of the engine. Polls the extension once a second while it
 * answers; the numbers are the four counters the plan asks for, shown apart
 * because they fail apart. A missing extension is shown as missing.
 */
export function DeviceCard () {
  const t = useTranslate()
  const [probe, setProbe] = useState<ExtensionProbe | null>(null)
  const [stats, setStats] = useState<EngineStats | null>(null)
  const [state, setState] = useState<EngineState>('idle')
  const [version, setVersion] = useState<string>('')

  const reprobe = useCallback(() => {
    setProbe(null)
    void probeExtension().then(setProbe)
  }, [])

  useEffect(() => { reprobe() }, [reprobe])

  useEffect(() => {
    if (probe?.available !== true) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      const status = await fetchStatus()
      if (cancelled) return
      if (status === null) {
        setProbe({ available: false, reason: 'not-installed', detail: 'yanıt yok' })
        return
      }
      setStats(status.stats)
      setState(status.state)
      setVersion(status.version)
    }
    void tick()
    const id = setInterval(() => { void tick() }, 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [probe])

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('device.title')}</Card.Title>
        <Card.Description>{t('device.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        {probe === null && <p className="text-sm text-muted">{t('device.searching')}</p>}

        {probe?.available === false && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted">
              {t(probe.reason === 'no-runtime' ? 'device.noRuntime' : 'device.notFound')}
            </span>
            <Button size="sm" variant="secondary" onPress={reprobe}>{t('device.retry')}</Button>
          </div>
        )}

        {probe?.available === true && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-background/60 px-3 py-1 text-sm">
                {t(STATE_KEY[state])}
              </span>
              <span className="text-xs text-muted">{t('device.version', { version })}</span>
              {state === 'running' && (
                <Button size="sm" variant="secondary" onPress={() => { void stopEngine() }}>
                  {t('device.stop')}
                </Button>
              )}
            </div>

            {stats !== null && (
              <Surface className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl p-3 font-mono text-xs sm:grid-cols-3" variant="secondary">
                <Stat label={t('device.stat.delivered')} value={`${fmt(stats.deliveredFps)} fps`} />
                <Stat label={t('device.stat.arrival')} value={`${fmt(stats.interArrivalMs.p50)} / ${fmt(stats.interArrivalMs.p99)} ms`} />
                <Stat label={t('device.stat.output')} value={`${fmt(stats.outputFps)} fps`} />
                <Stat label={t('device.stat.captureGaps')} value={String(stats.captureGaps)} />
                <Stat label={t('device.stat.pipelineDrops')} value={String(stats.pipelineDrops)} />
                <Stat label={t('device.stat.serialDrops')} value={String(stats.link.dropped)} />
                <Stat label={t('device.stat.process')} value={`${fmt(stats.processMs.p50, 2)} / ${fmt(stats.processMs.p99, 2)} ms`} />
                <Stat
                  label={t('device.stat.link')}
                  value={t(LINK_KEY[stats.link.mode]) + (stats.link.port !== undefined ? ` ${stats.link.port}` : '')}
                />
                <Stat
                  label={t('device.stat.border')}
                  value={stats.border.unknown ? t('layout.borderUnknown') : `${stats.border.topBottom} / ${stats.border.leftRight} px`}
                />
                {stats.link.mode === 'loopback' && (
                  <Stat label={t('device.stat.loopback')} value={`${stats.link.accepted} / ${stats.link.rejected}`} />
                )}
                {stats.source !== undefined && (
                  <Stat label={t('device.stat.source')} value={`${stats.source.width}×${stats.source.height}`} />
                )}
                {stats.error !== undefined && <Stat label={t('device.stat.error')} value={stats.error} />}
              </Surface>
            )}

            <p className="text-xs text-muted">{t('device.note')}</p>
          </>
        )}
      </Card.Content>
    </Card>
  )
}

function Stat ({ label, value }: { label: string, value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}
