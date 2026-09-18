'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Label, Slider, Surface, Switch } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useEngineConfig } from '#components/EngineConfig'
import { useTranslate } from '#components/Preferences'
import { DEFAULT_COLOR, SATURATION_MAX, TAPER_MAX, type ColorConfig } from '#lib/engine/config'
import { kelvinToSrgb } from '#lib/engine/adjust'

/**
 * Colour correction.
 *
 * The chain behind this has been written and tested since the adjustment module
 * landed, with every knob pinned to its identity value because nothing could
 * set them. What is here is the set a person actually reaches for; the
 * eight-corner colour cube and per-LED profiles stay in the engine for the
 * calibration wizard rather than becoming eight more sliders nobody can read.
 *
 * Two of these exist because of what a strip IS rather than as taste, and both
 * say so on the page:
 *
 * - **White balance**, because WS2812B reels are green-weighted and two reels
 *   from different batches are not the same white. The swatch beside it is the
 *   engine's own `kelvinToSrgb`, not a gradient picked to look right - so what
 *   is shown is what will be applied.
 * - **The floor**, because a strip that goes completely dark in a dark scene
 *   reads as "it broke" rather than as "the scene is dark".
 *
 * The taper is capped at 1.6 and the page says why. Hyperion's 2.2 is a
 * transfer function, and this pipeline has already averaged in linear light -
 * applying it again roughly squares the output. If 1.0 looks wrong the answer
 * is the brightness ceiling, not a gamma curve masking it.
 */

/** Slider positions, so a fractional knob can move in hundredths. */
const HUNDREDTHS = 100

/**
 * What the temperature SLIDER covers, which is not what the engine accepts.
 *
 * The engine clamps to 1000..40000 K because that is the range Helland's fit is
 * defined over. Nobody balances a strip at 40000 K: on a track that wide the
 * identity at 6600 sits at a seventh of the way along and the entire useful
 * span - candlelight to overcast daylight - is squeezed into the first fifth.
 * The slider covers the band a person works in; a stored configuration outside
 * it is still accepted and still shown correctly, the thumb just sits at an end.
 */
const KELVIN_SLIDER_MIN = 2000
const KELVIN_SLIDER_MAX = 10000

export function ColourAdjustCard () {
  const t = useTranslate()
  const { probe, host, pageCapable, saveConfig, activeId } = useEngine()
  const { config, setConfig, draft: shared, setDraft: setShared } = useEngineConfig()
  const [draft, setDraft] = useState<ColorConfig | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // A half-finished edit belongs to the strip it was started on.
  useEffect(() => { setDraft(null); setNotice(null) }, [activeId])

  const current = draft ?? config.color

  const patch = useCallback((over: Partial<ColorConfig>) => {
    setNotice(null)
    setDraft((value) => ({ ...(value ?? config.color), ...over }))
  }, [config.color])

  const apply = useCallback(() => {
    setSaving(true)
    const next = { ...config, color: current }
    void saveConfig(next).then((result) => {
      setSaving(false)
      if (result.error !== undefined) { setNotice(t('adjust.failed', { reason: result.error })); return }
      setConfig(next)
      setShared({ ...shared, color: current })
      setDraft(null)
      setNotice(result.notStored === undefined
        ? t('adjust.applied')
        : t('layout.appliedNotStored', { reason: result.notStored }))
    })
  }, [config, current, saveConfig, setConfig, setShared, shared, t])

  const hosted = host === 'page' ? pageCapable : probe === null || probe.available === true
  if (!hosted) return null

  // 0..1 ENCODED sRGB, not bytes and not light - so it is scaled here rather
  // than handed to `rgb()` as though it were already a byte. Encoded is what a
  // CSS colour wants, which is why this is the right function to show: the
  // swatch is the engine's own answer, not a gradient chosen to look plausible.
  const white = kelvinToSrgb(current.temperature)
  const swatch = `rgb(${[white.r, white.g, white.b].map((c) => Math.round(c * 255)).join(' ')})`

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('adjust.title')}</Card.Title>
        <Card.Description>{t('adjust.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-6">
        <Slider
          maxValue={100}
          minValue={0}
          step={1}
          value={current.brightness}
          onChange={(value) => { patch({ brightness: Number(value) }) }}
        >
          <Label>{t('adjust.brightness')}</Label>
          <Slider.Output>{`${current.brightness}%`}</Slider.Output>
          <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
        </Slider>
        <p className="-mt-4 text-xs text-muted">{t('adjust.brightness.note')}</p>

        <Slider
          maxValue={SATURATION_MAX * HUNDREDTHS}
          minValue={0}
          step={1}
          value={Math.round(current.saturationGain * HUNDREDTHS)}
          onChange={(value) => { patch({ saturationGain: Number(value) / HUNDREDTHS }) }}
        >
          <Label>{t('adjust.saturation')}</Label>
          <Slider.Output>{`×${current.saturationGain.toFixed(2)}`}</Slider.Output>
          <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
        </Slider>
        <p className="-mt-4 text-xs text-muted">{t('adjust.saturation.note')}</p>

        <div className="flex flex-col gap-2">
          <Slider
            maxValue={KELVIN_SLIDER_MAX}
            minValue={KELVIN_SLIDER_MIN}
            step={100}
            value={Math.min(KELVIN_SLIDER_MAX, Math.max(KELVIN_SLIDER_MIN, current.temperature))}
            onChange={(value) => { patch({ temperature: Number(value) }) }}
          >
            <Label>{t('adjust.temperature')}</Label>
            <Slider.Output>{`${current.temperature} K`}</Slider.Output>
            <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
          </Slider>
          <div className="flex items-center gap-2">
            {/*
              The engine's own kelvinToSrgb, not a gradient chosen to look
              right: what is shown here is what will actually be applied.
            */}
            <span
              aria-hidden
              className="size-5 rounded-full border border-default/40"
              style={{ background: swatch }}
            />
            <p className="text-xs text-muted">{t('adjust.temperature.note')}</p>
          </div>
        </div>

        <Slider
          maxValue={TAPER_MAX * HUNDREDTHS}
          minValue={HUNDREDTHS}
          step={1}
          value={Math.round(current.taper * HUNDREDTHS)}
          onChange={(value) => { patch({ taper: Number(value) / HUNDREDTHS }) }}
        >
          <Label>{t('adjust.taper')}</Label>
          <Slider.Output>{current.taper.toFixed(2)}</Slider.Output>
          <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
        </Slider>
        <p className="-mt-4 text-xs text-muted">{t('adjust.taper.note')}</p>

        <div className="flex flex-col gap-3">
          <Slider
            maxValue={100}
            minValue={0}
            step={1}
            value={current.backlightThreshold}
            onChange={(value) => { patch({ backlightThreshold: Number(value) }) }}
          >
            <Label>{t('adjust.backlight')}</Label>
            <Slider.Output>{current.backlightThreshold === 0 ? t('adjust.backlight.off') : `${current.backlightThreshold}%`}</Slider.Output>
            <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
          </Slider>
          <p className="text-xs text-muted">{t('adjust.backlight.note')}</p>
          <Switch
            isDisabled={current.backlightThreshold === 0}
            isSelected={current.backlightColored}
            onChange={(on) => { patch({ backlightColored: on }) }}
          >
            <Switch.Content>
              <Switch.Control><Switch.Thumb /></Switch.Control>
              {t('adjust.backlight.colored')}
            </Switch.Content>
          </Switch>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button aria-label={`${t('adjust.apply')} — ${t('adjust.title')}`} isDisabled={saving} onPress={apply}>
            {t(saving ? 'adjust.applying' : 'adjust.apply')}
          </Button>
          <Button variant="secondary" onPress={() => { patch({ ...DEFAULT_COLOR }) }}>
            {t('adjust.reset')}
          </Button>
        </div>

        {notice !== null && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
        )}
      </Card.Content>
    </Card>
  )
}
