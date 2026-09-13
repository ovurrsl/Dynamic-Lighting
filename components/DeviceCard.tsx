'use client'

import { Button, Card, Surface } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useTranslate } from '#components/Preferences'
import type { MessageKey } from '#lib/i18n/strings'
import type { EngineState } from '#lib/extension/messages'

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
 * The diagnostics page: the four counters, apart, because the stages fail apart.
 *
 * It no longer polls. The connection to the engine is shared (components/Engine)
 * because the sidebar badge and the overview want the same numbers at the same
 * moment - three pollers would triple the traffic and disagree with each other
 * by up to a second.
 */
export function DeviceCard () {
  const t = useTranslate()
  const { probe, state, stats, version, reprobe, stop } = useEngine()

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
                <Button size="sm" variant="secondary" onPress={() => { void stop() }}>
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

            {/*
              The stage breakdown, kept in its own box rather than mixed into
              the counters above: those say whether the engine is healthy, this
              says which line of it to go and fix. Absent from an older
              extension, which is why it is guarded rather than assumed.
            */}
            {stats?.stageMs !== undefined && (
              <Surface className="rounded-xl p-3 font-mono text-xs" variant="secondary">
                <Stat
                  label={t('device.stat.stages')}
                  value={`${fmt(stats.stageMs.downscale, 2)} / ${fmt(stats.stageMs.readback, 2)} / ${fmt(stats.stageMs.decode, 2)} / ${fmt(stats.stageMs.sample, 2)} ms`}
                />
                <p className="mt-2 font-sans text-muted">{t('device.stat.stagesNote')}</p>
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
