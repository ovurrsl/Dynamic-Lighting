'use client'

import { useMemo, useState } from 'react'
import { Button, Card, Surface } from '@heroui/react'

import { linkLabel } from '#components/DeviceCard'
import { useEngine } from '#components/Engine'
import { useEngineConfig } from '#components/EngineConfig'
import { LedFrame } from '#components/LedFrame'
import { useEngineText, useTranslate } from '#components/Preferences'
import { resolveLayout } from '#lib/engine/config'
import { frameAspect, wireOrderColor } from '#lib/preview'
import { hashForSection } from '#lib/sections'

const fmt = (n: number, digits = 1): string => (Number.isFinite(n) ? n.toFixed(digits) : '–')

/**
 * The landing page: what the engine is doing, and the button that starts it.
 *
 * The start button is here rather than only in the extension's popup, and that
 * is the point of the page. Until now the only way to start a capture was the
 * toolbar menu - a product whose main control lives in a browser menu is a
 * product people cannot find.
 *
 * Where the picker opens depends on the host, and the button does not care: in
 * the extension it opens in the engine's own document, because that is the only
 * place it works there; in the page host it opens here. Which host is running -
 * and the fact that only one of them survives a hidden tab - is the Device
 * page's business, not this one's.
 */
export function OverviewCard () {
  const t = useTranslate()
  const tx = useEngineText()
  const { probe, host, pageCapable, state, stats, busy, start, selfTest, stop } = useEngine()
  const { config } = useEngineConfig()
  const [notice, setNotice] = useState<string | null>(null)

  const rects = useMemo(() => resolveLayout(config), [config])
  const running = state === 'running'
  const installed = probe?.available === true
  // The extension is no longer the only host, so "not installed" is no longer
  // "nothing can run": a browser that can capture a screen can run the engine
  // in this page, and on iOS that is the only route there has ever been.
  const hosted = host === 'page' ? pageCapable : installed
  const capturing = stats?.layers?.some((layer) => layer.component === 'capture') ?? false

  const act = (call: () => Promise<{ state: string, error?: string }>, pending: string) => {
    setNotice(pending)
    void call().then((result) => {
      setNotice(result.state === 'running' ? null : result.error === undefined ? null : tx(result.error))
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <Card variant="default">
        <Card.Header>
          <Card.Title>{t('overview.title')}</Card.Title>
          <Card.Description>{t('nav.overview.description')}</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          {probe === null && <p className="text-sm text-muted">{t('device.searching')}</p>}

          {probe !== null && !hosted && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-muted">
                {t(pageCapable ? 'overview.needExtension' : 'host.page.unavailable')}
              </span>
              <Button
                size="sm"
                variant="secondary"
                onPress={() => { window.location.hash = hashForSection('guide') }}
              >
                {t('overview.openGuide')}
              </Button>
            </div>
          )}

          {hosted && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  isDisabled={busy}
                  onPress={() => act(start, t('overview.picker'))}
                >
                  {t(busy ? 'overview.starting' : 'overview.start')}
                </Button>
                <Button
                  isDisabled={!running}
                  variant="secondary"
                  onPress={() => { setNotice(null); void stop() }}
                >
                  {t('overview.stop')}
                </Button>
                <Button
                  isDisabled={busy}
                  variant="secondary"
                  onPress={() => act(selfTest, t('overview.starting'))}
                >
                  {t('overview.selftest')}
                </Button>
              </div>

              {/*
                The capture ending on its own is not a failure and must not read
                like one: a resolution change, HDR toggle or the monitor
                sleeping all end the stream, and they happen on real desks every
                day. What the user needs is the sentence telling them so and the
                button to pick the screen again - both already above.
              */}
              {stats?.lost === true && state !== 'running' && (
                <Surface className="rounded-xl p-3 text-sm" variant="secondary">
                  {t('overview.lost')}
                </Surface>
              )}

              {notice !== null && (
                <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
              )}

              {/*
                Only while running. The engine keeps the last run's counters
                after a stop, and this card's own description says it shows
                what the engine is doing NOW - so an idle strip under a line
                reading "output 106.9 fps" was contradicting itself. The
                Device page is where the last run's numbers belong.
              */}
              {running && stats !== null && (
                <Surface className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl p-3 font-mono text-xs sm:grid-cols-4" variant="secondary">
                  {/*
                    Only while something is actually being captured.
                    `deliveredFps` counts CAPTURE arrivals, so beside a running
                    effect it reads a perfectly correct 0.0 - which looks like a
                    fault next to a strip that is visibly animating.
                  */}
                  {capturing && (
                    <Stat label={t('device.stat.delivered')} value={`${fmt(stats.deliveredFps)} fps`} />
                  )}
                  <Stat label={t('device.stat.output')} value={`${fmt(stats.outputFps)} fps`} />
                  <Stat label={t('layout.leds', { count: stats.leds })} value="" />
                  {/* The device page's wording, so a WiFi link is not "not connected" here. */}
                  <Stat label={t('device.stat.link')} value={linkLabel(t, stats.link)} />
                </Surface>
              )}
            </>
          )}
        </Card.Content>
      </Card>

      <Card variant="default">
        <Card.Header>
          <Card.Title>{t('overview.strip')}</Card.Title>
          <Card.Description>{t('overview.stripNote')}</Card.Description>
        </Card.Header>
        <Card.Content>
          <LedFrame
            aspectRatio={frameAspect(config.layout)}
            colorAt={wireOrderColor}
            glow
            label={t('layout.regions', { count: rects.length })}
            outlineFirst
            rects={rects}
          />
        </Card.Content>
      </Card>
    </div>
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
