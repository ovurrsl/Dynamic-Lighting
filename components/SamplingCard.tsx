'use client'

import { useCallback, useState } from 'react'
import { Button, Card, Label, ListBox, Select, Slider, Surface } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useEngineConfig } from '#components/EngineConfig'
import { useTranslate } from '#components/Preferences'
import {
  DEFAULT_SAMPLING,
  MAX_PIXEL_SET_FACTOR,
  type SamplingConfig
} from '#lib/engine/config'
import { MAX_ACCURACY_LEVEL, SAMPLE_MODES, type SampleMode } from '#lib/engine/sample'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * How a region of the picture becomes one LED colour.
 *
 * `lib/engine/sample.ts` is a full port of Hyperion's seven reductions, its
 * pixel decimation and its k-means accuracy level - complete, tested, and
 * reached by an engine that called it with a hardcoded `'mean'` and no options.
 * Six of the seven had never run outside a test. That is the sixth time
 * something in this repository has been finished and left unreachable, and the
 * reason this page exists.
 *
 * **The page takes a position rather than presenting seven equal choices.**
 * `mean` is the right answer on linear input and says so; `meanSquared` exists
 * for configuration parity and is marked as doing nothing useful here, because
 * a list of seven names with no guidance is how a user ends up on the wrong one
 * and blames the product. The dominant modes are the real alternative and get a
 * real reason: they follow the brightest object in a dark frame instead of
 * averaging it away to grey.
 *
 * What the sampler is SAYING is shown at the bottom. Hyperion writes the
 * large-region guard to a log line that a user of its web UI never sees
 * (docs/hyperion-port-plan.md, defect #10) - so a strip that looks soft because
 * every second pixel is being skipped gives its owner nothing to go on. Here it
 * is on the page that caused it.
 */

const MODE_KEY: Record<SampleMode, MessageKey> = {
  mean: 'sampling.mode.mean',
  meanSquared: 'sampling.mode.meanSquared',
  unicolorMean: 'sampling.mode.unicolorMean',
  dominant: 'sampling.mode.dominant',
  unicolorDominant: 'sampling.mode.unicolorDominant',
  dominantAdvanced: 'sampling.mode.dominantAdvanced',
  unicolorDominantAdvanced: 'sampling.mode.unicolorDominantAdvanced'
}

const MODE_NOTE: Record<SampleMode, MessageKey> = {
  mean: 'sampling.mode.mean.note',
  meanSquared: 'sampling.mode.meanSquared.note',
  unicolorMean: 'sampling.mode.unicolorMean.note',
  dominant: 'sampling.mode.dominant.note',
  unicolorDominant: 'sampling.mode.unicolorDominant.note',
  dominantAdvanced: 'sampling.mode.dominantAdvanced.note',
  unicolorDominantAdvanced: 'sampling.mode.unicolorDominantAdvanced.note'
}

/** Hyperion's disabled / low / medium / high, said as what it actually does. */
const FACTOR_KEY: MessageKey[] = [
  'sampling.factor.0',
  'sampling.factor.1',
  'sampling.factor.2',
  'sampling.factor.3'
]

/** The two modes that cluster, and so the only two the accuracy level reaches. */
const CLUSTERING: readonly SampleMode[] = ['dominantAdvanced', 'unicolorDominantAdvanced']

export function SamplingCard () {
  const t = useTranslate()
  const { probe, host, pageCapable, saveConfig, stats } = useEngine()
  const { config, setConfig } = useEngineConfig()
  const [draft, setDraft] = useState<SamplingConfig | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const current = draft ?? config.sampling

  const patch = useCallback((over: Partial<SamplingConfig>) => {
    setNotice(null)
    setDraft((value) => ({ ...(value ?? config.sampling), ...over }))
  }, [config.sampling])

  const apply = useCallback(() => {
    setSaving(true)
    const next = { ...config, sampling: current }
    void saveConfig(next).then((result) => {
      setSaving(false)
      if (result.error !== undefined) { setNotice(t('sampling.failed', { reason: result.error })); return }
      setConfig(next)
      setDraft(null)
      setNotice(result.notStored === undefined
        ? t('sampling.applied')
        : t('layout.appliedNotStored', { reason: result.notStored }))
    })
  }, [config, current, saveConfig, setConfig, t])

  const hosted = host === 'page' ? pageCapable : probe === null || probe.available === true
  if (!hosted) return null

  const clusters = CLUSTERING.includes(current.mode)
  const warnings = stats?.sampling?.warnings ?? []

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('sampling.title')}</Card.Title>
        <Card.Description>{t('sampling.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-5">
        <Select
          className="w-full max-w-sm"
          value={current.mode}
          onChange={(value) => { patch({ mode: value as SampleMode }) }}
        >
          <Label>{t('sampling.mode')}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {SAMPLE_MODES.map((mode) => (
                <ListBox.Item id={mode} key={mode} textValue={t(MODE_KEY[mode])}>
                  {t(MODE_KEY[mode])}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <p className="-mt-3 text-xs text-muted">{t(MODE_NOTE[current.mode])}</p>

        <Select
          className="w-full max-w-sm"
          value={String(current.reducedPixelSetFactor)}
          onChange={(value) => { patch({ reducedPixelSetFactor: Number(value) }) }}
        >
          <Label>{t('sampling.factor')}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {Array.from({ length: MAX_PIXEL_SET_FACTOR + 1 }, (_, i) => (
                <ListBox.Item id={String(i)} key={i} textValue={t(FACTOR_KEY[i] as MessageKey)}>
                  {t(FACTOR_KEY[i] as MessageKey)}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <p className="-mt-3 text-xs text-muted">{t('sampling.factor.note')}</p>

        {/*
          Shown only while a clustering mode is selected, but NOT dropped when
          one is not: the value is a preference the user comes back to, unlike
          the calibration bytes or the host dither, which are refused outright
          because the chosen wire format has nowhere to put them.
        */}
        {clusters && (
          <>
            <Slider
              maxValue={MAX_ACCURACY_LEVEL}
              minValue={0}
              step={1}
              value={current.accuracyLevel}
              onChange={(value) => { patch({ accuracyLevel: Number(value) }) }}
            >
              <Label>{t('sampling.accuracy')}</Label>
              <Slider.Output>{t('sampling.accuracy.clusters', { clusters: current.accuracyLevel + 1 })}</Slider.Output>
              <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
            </Slider>
            <p className="-mt-4 text-xs text-muted">{t('sampling.accuracy.note')}</p>
          </>
        )}

        {/*
          The sampler's own words. Hyperion logs these where nobody looks, so a
          strip that went soft because the regions are being subsampled gives
          its owner nothing to act on.
        */}
        {warnings.length > 0 && (
          <Surface className="flex flex-col gap-1 rounded-xl p-3 text-sm" variant="secondary">
            <span className="text-xs text-muted">{t('sampling.warnings')}</span>
            {warnings.map((warning) => (
              <span key={warning} className="text-warning">{warning}</span>
            ))}
            <span className="text-xs text-muted">{t('sampling.warnings.note')}</span>
          </Surface>
        )}

        <div className="flex flex-wrap gap-2">
          <Button isDisabled={saving} onPress={apply}>
            {t(saving ? 'sampling.applying' : 'sampling.apply')}
          </Button>
          <Button variant="secondary" onPress={() => { patch({ ...DEFAULT_SAMPLING }) }}>
            {t('sampling.reset')}
          </Button>
        </div>

        {notice !== null && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
        )}
      </Card.Content>
    </Card>
  )
}
