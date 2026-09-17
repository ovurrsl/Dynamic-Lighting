'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Label, ListBox, Select, Slider, Surface, Switch } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useEngineConfig } from '#components/EngineConfig'
import { HexColorField, hexOf } from '#components/HexColorField'
import { useTranslate } from '#components/Preferences'
import {
  STARTUP_MS_MAX,
  STARTUP_MS_MIN,
  type LayerConfig,
  type StartupConfig
} from '#lib/engine/config'
import { EFFECT_KINDS, type EffectKind } from '#lib/engine/effects'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * The two layers nobody starts by hand.
 *
 * The muxer has reserved a background slot since the day it was written -
 * spared by `clearAll()`, ignored by the idle check - and nothing had ever
 * registered a source there. The mechanism was complete and unreachable, which
 * is the fourth time that has happened in this engine and the reason this page
 * exists.
 *
 * What the background is FOR is one sentence, and it is a thing people ask for:
 * **leave warm white behind it when the screen goes dark.** Without it a
 * capture that ends leaves the strip black, which reads as a fault.
 *
 * The startup layer is the other half. Hyperion calls it `foregroundEffect`,
 * which is a confusing name for a boot animation; it runs above everything for
 * a few seconds and lets go on its own, so the strip says "this is on" before
 * anybody has picked a screen.
 *
 * Both are off by default and the page says so: turning one on changes what an
 * existing rig does, and nobody asked for that on an update.
 */

const KIND_KEY: Record<LayerConfig['kind'], MessageKey> = {
  color: 'auto.kind.color',
  effect: 'auto.kind.effect'
}

export function AutoLayersCard () {
  const t = useTranslate()
  const { probe, host, pageCapable, saveConfig, activeId } = useEngine()
  const { config, setConfig, draft: shared, setDraft: setShared } = useEngineConfig()
  const [draft, setDraft] = useState<{ background: LayerConfig, startup: StartupConfig } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // A half-finished edit belongs to the strip it was started on.
  useEffect(() => { setDraft(null); setNotice(null) }, [activeId])

  const current = draft ?? { background: config.background, startup: config.startup }

  const patch = useCallback((over: Partial<{ background: LayerConfig, startup: StartupConfig }>) => {
    setNotice(null)
    setDraft((value) => ({ ...(value ?? { background: config.background, startup: config.startup }), ...over }))
  }, [config.background, config.startup])

  const apply = useCallback(() => {
    setSaving(true)
    const next = { ...config, background: current.background, startup: current.startup }
    void saveConfig(next).then((result) => {
      setSaving(false)
      if (result.error !== undefined) { setNotice(t('auto.failed', { reason: result.error })); return }
      setConfig(next)
      setShared({ ...shared, background: current.background, startup: current.startup })
      setDraft(null)
      setNotice(result.notStored === undefined
        ? t('auto.applied')
        : t('layout.appliedNotStored', { reason: result.notStored }))
    })
  }, [config, current, saveConfig, setConfig, setShared, shared, t])

  const hosted = host === 'page' ? pageCapable : probe === null || probe.available === true
  if (!hosted) return null

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('auto.title')}</Card.Title>
        <Card.Description>{t('auto.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-6">
        <Layer
          layer={current.background}
          note={t('auto.background.note')}
          title={t('auto.background')}
          onChange={(background) => { patch({ background }) }}
        />

        <Layer
          layer={current.startup}
          note={t('auto.startup.note')}
          title={t('auto.startup')}
          onChange={(startup) => { patch({ startup: { ...current.startup, ...startup } }) }}
        >
          <Slider
            isDisabled={!current.startup.enabled}
            maxValue={STARTUP_MS_MAX}
            minValue={STARTUP_MS_MIN}
            step={100}
            value={current.startup.durationMs}
            onChange={(value) => { patch({ startup: { ...current.startup, durationMs: Number(value) } }) }}
          >
            <Label>{t('auto.startup.duration')}</Label>
            <Slider.Output>{`${(current.startup.durationMs / 1000).toFixed(1)} s`}</Slider.Output>
            <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
          </Slider>
        </Layer>

        <div className="flex flex-wrap gap-2">
          <Button aria-label={`${t('auto.apply')} — ${t('auto.title')}`} isDisabled={saving} onPress={apply}>
            {t(saving ? 'auto.applying' : 'auto.apply')}
          </Button>
        </div>

        {notice !== null && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
        )}
      </Card.Content>
    </Card>
  )
}

/**
 * One layer's controls.
 *
 * Both arms stay on screen whichever kind is selected, and both are kept when
 * saving: switching from a colour to an effect and back must not lose the
 * colour that was picked.
 */
function Layer ({ title, note, layer, onChange, children }: {
  title: string
  note: string
  layer: LayerConfig
  onChange: (layer: LayerConfig) => void
  children?: React.ReactNode
}) {
  const t = useTranslate()
  return (
    <Surface className="flex flex-col gap-3 rounded-xl p-3" variant="secondary">
      <Switch
        isSelected={layer.enabled}
        onChange={(enabled) => { onChange({ ...layer, enabled }) }}
      >
        <Switch.Content>
          <Switch.Control><Switch.Thumb /></Switch.Control>
          {title}
        </Switch.Content>
      </Switch>
      <p className="text-xs text-muted">{note}</p>

      <div className="flex flex-wrap items-end gap-3">
        <Select
          className="w-40"
          isDisabled={!layer.enabled}
          value={layer.kind}
          onChange={(value) => { onChange({ ...layer, kind: value as LayerConfig['kind'] }) }}
        >
          <Label>{t('auto.kind')}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {(['color', 'effect'] as const).map((kind) => (
                <ListBox.Item id={kind} key={kind} textValue={t(KIND_KEY[kind])}>
                  {t(KIND_KEY[kind])}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>

        {layer.kind === 'color'
          ? (
            <HexColorField
              className="w-32"
              isDisabled={!layer.enabled}
              label={t('auto.colour')}
              placeholder="#ffaa64"
              value={layer.color}
              onChange={(color) => { onChange({ ...layer, color }) }}
            />
            )
          : (
            <Select
              className="w-44"
              isDisabled={!layer.enabled}
              value={layer.effect}
              onChange={(value) => { onChange({ ...layer, effect: value as EffectKind }) }}
            >
              <Label>{t('auto.effect')}</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {EFFECT_KINDS.map((kind) => (
                    <ListBox.Item id={kind} key={kind} textValue={t(`effects.kind.${kind}` as MessageKey)}>
                      {t(`effects.kind.${kind}` as MessageKey)}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            )}

        {layer.kind === 'color' && (
          <span
            aria-hidden
            className="mb-1 size-6 rounded-full border border-default/40"
            style={{ background: hexOf(layer.color) }}
          />
        )}
      </div>

      {children}
    </Surface>
  )
}
