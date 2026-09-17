'use client'

import { useEffect, useState } from 'react'
import { Button, Card, Surface } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { audioInputLabel, audioKindLabel, effectLabel, patternLabel } from '#components/labels'
import { useEngineText, useTranslate } from '#components/Preferences'
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
  port: 'device.link.port',
  websocket: 'device.link.websocket',
  wled: 'device.link.wled'
} as const satisfies Record<EngineStats['link']['mode'], MessageKey>

/**
 * What a network link is doing. Shown only for the two socket transports: a
 * serial port and the loopback are open the moment they exist, and saying so
 * would be noise beside the one link that genuinely spends time dialling.
 */
const LINK_STATE_KEY = {
  idle: 'device.link.state.idle',
  connecting: 'device.link.state.connecting',
  open: 'device.link.state.open',
  error: 'device.link.state.error'
} as const satisfies Record<NonNullable<EngineStats['link']['state']>, MessageKey>

/** One wording for the link, shared with the overview so the two never disagree. */
export function linkLabel (t: (key: MessageKey) => string, link: EngineStats['link']): string {
  const base = t(LINK_KEY[link.mode]) + (link.port !== undefined ? ` ${link.port}` : '')
  const dialling = (link.mode === 'websocket' || link.mode === 'wled') && link.state !== undefined
  return dialling ? `${base} — ${t(LINK_STATE_KEY[link.state as keyof typeof LINK_STATE_KEY])}` : base
}

/**
 * The three frame routes, named rather than shown as a slug: 'video-timer' says
 * nothing to a user, and the difference between them is the difference between
 * a frame per screen change and a frame per tick.
 */
const SOURCE_KEY: Record<string, MessageKey | undefined> = {
  stream: 'device.source.stream',
  'video-callback': 'device.source.video-callback',
  'video-timer': 'device.source.video-timer'
}

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
  const tx = useEngineText()
  const { probe, host, state, stats, version, reprobe, stop, pairSerial } = useEngine()
  const detail = describeDetail(stats?.link.detail)
  // Asked of the browser after mount, never at render: the server has no
  // navigator and a mismatch here is a hydration error.
  const [canPair, setCanPair] = useState(false)
  const [pairNotice, setPairNotice] = useState<string | null>(null)
  useEffect(() => { setCanPair(typeof navigator !== 'undefined' && 'serial' in navigator) }, [])

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('device.title')}</Card.Title>
        <Card.Description>{t('device.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        {host === 'extension' && probe === null && <p className="text-sm text-muted">{t('device.searching')}</p>}

        {host === 'extension' && probe?.available === false && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted">
              {t(probe.reason === 'no-runtime' ? 'device.noRuntime' : 'device.notFound')}
            </span>
            <Button size="sm" variant="secondary" onPress={reprobe}>{t('device.retry')}</Button>
          </div>
        )}

        {/*
          The counters belong to the ENGINE, not to the extension. Gating them
          on the extension was right while it was the only host; now it would
          hide every number from exactly the platforms that most need them,
          because those are the ones with no extension to find.
        */}
        {(host === 'page' || probe?.available === true) && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-background/60 px-3 py-1 text-sm">
                {t(STATE_KEY[state])}
              </span>
              {host === 'extension' && (
                <span className="text-xs text-muted">{t('device.version', { version })}</span>
              )}
              <span className="text-xs text-muted">{t(host === 'page' ? 'host.page' : 'host.extension')}</span>
              {state === 'running' && (
                <Button size="sm" variant="secondary" onPress={() => { void stop() }}>
                  {t('device.stop')}
                </Button>
              )}
            </div>

            {/*
              Only in the page host, and only where Web Serial exists (Chromium).
              The extension's port is paired from its popup because the grant
              belongs to the extension's origin; this page needs a grant of its
              own, and until this button existed a page-host strip on the USB
              transport could never obtain one - the runtime's comment claimed
              a panel button that was not there.
            */}
            {host === 'page' && canPair && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => {
                    setPairNotice(null)
                    void pairSerial().then((problem) => {
                      setPairNotice(problem === null ? t('device.pair.done') : t('device.pair.failed', { reason: problem }))
                    })
                  }}
                >
                  {t('device.pair')}
                </Button>
                <span className="text-xs text-muted">{t('device.pair.note')}</span>
              </div>
            )}
            {pairNotice !== null && (
              <Surface className="rounded-xl p-3 text-sm" variant="secondary">{pairNotice}</Surface>
            )}

            {stats !== null && (
              <Surface className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl p-3 font-mono text-xs sm:grid-cols-3" variant="secondary">
                <Stat label={t('device.stat.delivered')} value={`${fmt(stats.deliveredFps)} fps`} />
                <Stat label={t('device.stat.arrival')} value={`${fmt(stats.interArrivalMs.p50)} / ${fmt(stats.interArrivalMs.p99)} ms`} />
                <Stat label={t('device.stat.output')} value={`${fmt(stats.outputFps)} fps`} />
                <Stat label={t('device.stat.captureGaps')} value={String(stats.captureGaps)} />
                <Stat label={t('device.stat.pipelineDrops')} value={String(stats.pipelineDrops)} />
                <Stat label={t('device.stat.serialDrops')} value={String(stats.link.dropped)} />
                <Stat label={t('device.stat.process')} value={`${fmt(stats.processMs.p50, 2)} / ${fmt(stats.processMs.p99, 2)} ms`} />
                <Stat label={t('device.stat.link')} value={linkLabel(t, stats.link)} />
                <Stat
                  label={t('device.stat.border')}
                  value={stats.border.unknown ? t('layout.borderUnknown') : `${stats.border.topBottom} / ${stats.border.leftRight} px`}
                />
                {stats.link.mode === 'loopback' && (
                  <Stat label={t('device.stat.loopback')} value={`${stats.link.accepted} / ${stats.link.rejected}`} />
                )}
                {/*
                  Whatever the transport counts for itself. Rendered generically
                  on purpose: a socket's reconnects and drops are the numbers
                  that say "the device is switched off" rather than "the engine
                  is broken", and a new transport should not need a change here
                  to be diagnosable.
                */}
                {detail !== null && <Stat className="col-span-2 sm:col-span-3" label={t('device.stat.detail')} value={detail} />}
                {stats.audio !== undefined && (
                  <Stat
                    label={t('device.stat.audio')}
                    value={`${audioKindLabel(stats.audio.kind, t)} / ${audioInputLabel(stats.audio.input, t)} ${(stats.audio.level * 100).toFixed(0)}%`}
                  />
                )}
                {stats.effect !== undefined && (
                  <Stat label={t('device.stat.effect')} value={effectLabel(stats.effect, t)} />
                )}
                {stats.pattern !== undefined && (
                  <Stat label={t('layers.component.pattern')} value={patternLabel(stats.pattern, t)} />
                )}
                {stats.sourceKind !== undefined && (
                  <Stat
                    className="col-span-2 sm:col-span-3"
                    label={t('device.stat.sourceKind')}
                    value={t(SOURCE_KEY[stats.sourceKind] ?? 'device.stat.sourceKind')}
                  />
                )}
                {stats.source !== undefined && (
                  <Stat label={t('device.stat.source')} value={`${stats.source.width}×${stats.source.height}`} />
                )}
                {stats.error !== undefined && <Stat label={t('device.stat.error')} value={tx(stats.error)} />}
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

            <p className="text-xs text-muted">{t(host === 'page' ? 'device.note.page' : 'device.note')}</p>
          </>
        )}
      </Card.Content>
    </Card>
  )
}

/**
 * The transport's own counters as one line.
 *
 * Booleans are shown as the bare key when true and omitted when false, because
 * every one of them so far reads that way ("inFlight", "open"), and a column of
 * `x=false` says nothing a missing entry does not.
 */
function describeDetail (detail: EngineStats['link']['detail']): string | null {
  if (detail === undefined) return null
  const parts: string[] = []
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === 'boolean') {
      if (value) parts.push(key)
    } else {
      parts.push(`${key}=${typeof value === 'number' ? String(Math.round(value * 100) / 100) : value}`)
    }
  }
  return parts.length === 0 ? null : parts.join(' ')
}

function Stat ({ label, value, className = '' }: { label: string, value: string, className?: string }) {
  return (
    <div className={`flex justify-between gap-3 ${className}`}>
      <span className="text-muted">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}
