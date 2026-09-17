'use client'

import { useCallback, useState } from 'react'
import { Button, Card, ColorArea, ColorPicker, ColorSlider, ColorSwatch, Label, Slider, Surface } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useTranslate } from '#components/Preferences'
import {
  COLOURED_EFFECTS,
  DEFAULT_BRIGHTNESS,
  DEFAULT_SPEED,
  EFFECT_KINDS,
  SPEED_MAX,
  SPEED_MIN,
  type EffectKind,
  type EffectSpec
} from '#lib/engine/effects'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * Effects: what the strip does when nothing is being captured.
 *
 * Presented as a gallery rather than a dropdown because these are chosen by
 * eye, not by name - "mood blobs" means nothing until you have seen it. Each
 * card carries the one sentence that says what makes it different, since
 * "rainbow" and "plasma" are otherwise indistinguishable in a list.
 *
 * The colour control appears only for the three effects that take one. Showing
 * it for the rainbow would be offering a setting that does nothing, which is
 * worse than not offering it.
 */

// From the engine, not a local copy: the copy here listed three effects while
// six read the colour, so twinkle, scan and chase ran in the default orange
// with no way to change it.
const COLOURED: ReadonlySet<EffectKind> = new Set<EffectKind>(COLOURED_EFFECTS)

const DEFAULT_COLOR = { r: 255, g: 160, b: 60 }

export function EffectsCard () {
  const t = useTranslate()
  const { probe, host, pageCapable, stats, state, runEffect, stop } = useEngine()
  const [kind, setKind] = useState<EffectKind | null>(null)
  const [speed, setSpeed] = useState(DEFAULT_SPEED)
  const [brightness, setBrightness] = useState(DEFAULT_BRIGHTNESS)
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [notice, setNotice] = useState<string | null>(null)

  const hosted = host === 'page' ? pageCapable : probe === null || probe.available === true
  const running = stats?.effect

  const run = useCallback(async (next: EffectKind) => {
    setKind(next)
    setNotice(null)
    const spec: EffectSpec = {
      kind: next,
      speed,
      brightness,
      ...(COLOURED.has(next) ? { color } : {})
    }
    const result = await runEffect(spec)
    setNotice(result.error ?? null)
  }, [brightness, color, runEffect, speed])

  /**
   * A running effect is rebuilt when a slider moves, rather than waiting for
   * the user to press Run again. The engine takes a whole spec, so this is the
   * same call - and an effects page where the sliders do nothing until you
   * press a button is a page nobody can tune by eye.
   */
  const retune = useCallback((patch: Partial<EffectSpec>) => {
    if (patch.speed !== undefined) setSpeed(patch.speed)
    if (patch.brightness !== undefined) setBrightness(patch.brightness)
    if (patch.color !== undefined) setColor(patch.color)
    if (kind === null || running === undefined) return
    void runEffect({
      kind,
      speed: patch.speed ?? speed,
      brightness: patch.brightness ?? brightness,
      ...(COLOURED.has(kind) ? { color: patch.color ?? color } : {})
    })
  }, [brightness, color, kind, running, runEffect, speed])

  if (!hosted) {
    return (
      <Card variant="default">
        <Card.Header><Card.Title>{t('effects.title')}</Card.Title></Card.Header>
        <Card.Content><p className="text-sm text-muted">{t('effects.needEngine')}</p></Card.Content>
      </Card>
    )
  }

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('effects.title')}</Card.Title>
        <Card.Description>{t('effects.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {EFFECT_KINDS.map((each) => {
            const active = running === each
            return (
              <button
                className={`rounded-xl border p-3 text-left transition ${
                  active
                    ? 'border-primary bg-primary/15 ring-1 ring-primary'
                    : 'border-default/40 hover:border-default'
                }`}
                key={each}
                type="button"
                onClick={() => { void run(each) }}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {t(`effects.kind.${each}` as MessageKey)}
                  {active && <span aria-hidden className="size-2 rounded-full bg-primary" />}
                </span>
                <span className="mt-1 block text-xs text-muted">
                  {t(`effects.kind.${each}.note` as MessageKey)}
                </span>
              </button>
            )
          })}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Slider
            maxValue={SPEED_MAX}
            minValue={SPEED_MIN}
            step={0.05}
            value={speed}
            onChange={(value) => { retune({ speed: value as number }) }}
          >
            <div className="flex items-baseline justify-between">
              <Label>{t('effects.speed')}</Label>
              <span className="font-mono text-xs text-muted">{speed.toFixed(2)}×</span>
            </div>
            <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
          </Slider>

          <Slider
            maxValue={1}
            minValue={0.02}
            step={0.01}
            value={brightness}
            onChange={(value) => { retune({ brightness: value as number }) }}
          >
            <div className="flex items-baseline justify-between">
              <Label>{t('effects.brightness')}</Label>
              <span className="font-mono text-xs text-muted">{Math.round(brightness * 100)}%</span>
            </div>
            <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
          </Slider>
        </div>

        {/* Only for the effects that take one: a colour picker that does
            nothing is worse than no colour picker. */}
        {(kind === null || COLOURED.has(kind)) && (
          <div className="flex flex-col gap-2">
            {/*
              The same compound shape the colour page uses: ColorArea and
              ColorSlider read the shared colour from ColorPicker's context, so
              neither needs its own value.
            */}
            <ColorPicker
              value={`rgb(${color.r}, ${color.g}, ${color.b})`}
              onChange={(value) => {
                const rgb = value.toFormat('rgb')
                retune({
                  color: {
                    r: Math.round(rgb.getChannelValue('red')),
                    g: Math.round(rgb.getChannelValue('green')),
                    b: Math.round(rgb.getChannelValue('blue'))
                  }
                })
              }}
            >
              <ColorPicker.Trigger>
                <ColorSwatch size="lg" />
                <Label>{t('effects.color')}</Label>
              </ColorPicker.Trigger>
              <ColorPicker.Popover className="gap-2">
                <ColorArea
                  aria-label={t('effects.color')}
                  className="max-w-full"
                  colorSpace="hsb"
                  xChannel="saturation"
                  yChannel="brightness"
                >
                  <ColorArea.Thumb />
                </ColorArea>
                <ColorSlider aria-label={t('effects.color')} channel="hue" colorSpace="hsb">
                  <ColorSlider.Track>
                    <ColorSlider.Thumb />
                  </ColorSlider.Track>
                </ColorSlider>
              </ColorPicker.Popover>
            </ColorPicker>
            <p className="text-xs text-muted">{t('effects.colorNote')}</p>
          </div>
        )}

        {running !== undefined && (
          <Surface className="flex flex-wrap items-center gap-3 rounded-xl p-3 text-sm" variant="secondary">
            <span>{t('effects.running', { effect: t(`effects.kind.${running}` as MessageKey) })}</span>
            <Button size="sm" variant="secondary" onPress={() => { void stop() }}>{t('effects.stop')}</Button>
          </Surface>
        )}
        {notice !== null && (
          <Surface className="rounded-xl p-3 text-sm text-danger" variant="secondary">
            {t('effects.failed', { reason: notice })}
          </Surface>
        )}

        <p className="text-xs text-muted">{t('effects.replaces')}</p>
        {state === 'error' && stats?.error !== undefined && (
          <p className="text-xs text-danger">{stats.error}</p>
        )}
      </Card.Content>
    </Card>
  )
}
