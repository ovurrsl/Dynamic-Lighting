'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Label, ListBox, Select, Slider, Surface, Switch } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useEngineConfig } from '#components/EngineConfig'
import { useTranslate } from '#components/Preferences'
import {
  BLUR_REMOVE_MAX,
  BORDER_THRESHOLD_MAX,
  DEFAULT_BORDER,
  type BorderConfig
} from '#lib/engine/config'
import { BORDER_MODES, type BorderMode } from '#lib/engine/border'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * Black-border detection.
 *
 * This is the setting that keeps the strip alive during a film. On a 16:9 panel
 * a 2.39:1 film puts pure black under the top and bottom LEDs, so without it
 * the ambilight dies exactly when somebody is watching a film - which is the
 * single most common reason to own one.
 *
 * The four probe patterns are offered rather than one chosen for the user
 * because they fail in DIFFERENT ways, and which failure matters depends on
 * what is being watched. Each one's weakness is written on the page next to it,
 * because "classic" versus "osd" tells a user nothing and "fooled by a dark
 * corner" tells them everything.
 *
 * What the detector is finding RIGHT NOW is shown underneath, from the engine's
 * own statistics. Without it this page is four knobs with no feedback: a user
 * cannot tell a threshold that is too low from a film that has no bars, and
 * those need opposite responses.
 */

const MODE_KEY: Record<BorderMode, MessageKey> = {
  default: 'border.mode.default',
  classic: 'border.mode.classic',
  osd: 'border.mode.osd',
  letterbox: 'border.mode.letterbox'
}

const MODE_NOTE: Record<BorderMode, MessageKey> = {
  default: 'border.mode.default.note',
  classic: 'border.mode.classic.note',
  osd: 'border.mode.osd.note',
  letterbox: 'border.mode.letterbox.note'
}

/** Percent positions, so the threshold slider moves in whole percent. */
const PERCENT = 100

export function BorderCard () {
  const t = useTranslate()
  const { probe, host, pageCapable, saveConfig, stats, activeId } = useEngine()
  const { config, setConfig, draft: shared, setDraft: setShared } = useEngineConfig()
  const [draft, setDraft] = useState<BorderConfig | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // A half-finished edit belongs to the strip it was started on.
  useEffect(() => { setDraft(null); setNotice(null) }, [activeId])

  const current = draft ?? config.border

  const patch = useCallback((over: Partial<BorderConfig>) => {
    setNotice(null)
    setDraft((value) => ({ ...(value ?? config.border), ...over }))
  }, [config.border])

  const apply = useCallback(() => {
    setSaving(true)
    const next = { ...config, border: current }
    void saveConfig(next).then((result) => {
      setSaving(false)
      if (result.error !== undefined) { setNotice(t('border.failed', { reason: result.error })); return }
      setConfig(next)
      setShared({ ...shared, border: current })
      setDraft(null)
      setNotice(result.notStored === undefined
        ? t('border.applied')
        : t('layout.appliedNotStored', { reason: result.notStored }))
    })
  }, [config, current, saveConfig, setConfig, setShared, shared, t])

  const hosted = host === 'page' ? pageCapable : probe === null || probe.available === true
  if (!hosted) return null

  const found = stats?.border

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('border.title')}</Card.Title>
        <Card.Description>{t('border.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-5">
        <Switch
          isSelected={current.enabled}
          onChange={(enabled) => { patch({ enabled }) }}
        >
          <Switch.Content>
            <Switch.Control><Switch.Thumb /></Switch.Control>
            {t('border.enabled')}
          </Switch.Content>
        </Switch>

        <Select
          className="w-full max-w-sm"
          isDisabled={!current.enabled}
          value={current.mode}
          onChange={(value) => { patch({ mode: value as BorderMode }) }}
        >
          <Label>{t('border.mode')}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {BORDER_MODES.map((mode) => (
                <ListBox.Item id={mode} key={mode} textValue={t(MODE_KEY[mode])}>
                  {t(MODE_KEY[mode])}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <p className="-mt-3 text-xs text-muted">{t(MODE_NOTE[current.mode])}</p>

        <Slider
          isDisabled={!current.enabled}
          maxValue={BORDER_THRESHOLD_MAX * PERCENT}
          minValue={0}
          step={1}
          value={Math.round(current.threshold * PERCENT)}
          onChange={(value) => { patch({ threshold: Number(value) / PERCENT }) }}
        >
          <Label>{t('border.threshold')}</Label>
          <Slider.Output>{`${Math.round(current.threshold * PERCENT)}%`}</Slider.Output>
          <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
        </Slider>
        <p className="-mt-4 text-xs text-muted">{t('border.threshold.note')}</p>

        <Slider
          isDisabled={!current.enabled}
          maxValue={BLUR_REMOVE_MAX}
          minValue={0}
          step={1}
          value={current.blurRemovePx}
          onChange={(value) => { patch({ blurRemovePx: Number(value) }) }}
        >
          <Label>{t('border.blur')}</Label>
          <Slider.Output>{`${current.blurRemovePx} px`}</Slider.Output>
          <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
        </Slider>
        <p className="-mt-4 text-xs text-muted">{t('border.blur.note')}</p>

        {/*
          What it is finding right now. Without this the page is four knobs with
          no feedback: a threshold that is too low and a film with no bars look
          identical from here, and they need opposite responses.
        */}
        <Surface className="flex flex-wrap items-center gap-3 rounded-xl p-3 text-sm" variant="secondary">
          <span className="text-xs text-muted">{t('border.found')}</span>
          {found === undefined
            ? <span className="text-muted">{t('border.found.idle')}</span>
            : found.unknown
              ? <span>{t('border.found.unknown')}</span>
              : found.topBottom === 0 && found.leftRight === 0
                ? <span>{t('border.found.none')}</span>
                : <span className="font-mono">{t('border.found.bars', { topBottom: found.topBottom, leftRight: found.leftRight })}</span>}
        </Surface>

        <div className="flex flex-wrap gap-2">
          <Button aria-label={`${t('border.apply')} — ${t('border.title')}`} isDisabled={saving} onPress={apply}>
            {t(saving ? 'border.applying' : 'border.apply')}
          </Button>
          <Button variant="secondary" onPress={() => { patch({ ...DEFAULT_BORDER }) }}>
            {t('border.reset')}
          </Button>
        </div>

        {notice !== null && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
        )}
      </Card.Content>
    </Card>
  )
}
