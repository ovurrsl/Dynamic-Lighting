'use client'

import { useCallback, useMemo, useState } from 'react'
import { Button, Card, Label, NumberField, Slider, Surface } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useEngineConfig } from '#components/EngineConfig'
import { useTranslate } from '#components/Preferences'
import {
  CROP_MAX,
  FPS_MAX,
  FPS_MIN,
  GRID_MAX,
  GRID_MIN,
  parseEngineConfig,
  type CaptureConfig,
  type EngineConfig
} from '#lib/engine/config'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * The capture settings, which used to be three constants inside the engine.
 *
 * Hyperion makes every one of these a setting (schema-framegrabber.json:
 * width, height, fps, pixelDecimation, cropLeft/Right/Top/Bottom) and is right
 * to. The grid size is the first thing to reach for when the engine is behind -
 * the downscale is the measured bottleneck, at p50 9.00 ms against an 8.33 ms
 * budget - and the crop is what saves anyone whose capture includes a taskbar
 * or a second monitor.
 *
 * It applies its own section and nothing else. The layout editor owns a draft
 * of the whole configuration; if this page did too, whichever was pressed
 * second would quietly undo the first.
 */

const CROP_SIDES: Array<{ key: keyof CaptureConfig['crop'], label: MessageKey }> = [
  { key: 'left', label: 'capture.crop.left' },
  { key: 'right', label: 'capture.crop.right' },
  { key: 'top', label: 'capture.crop.top' },
  { key: 'bottom', label: 'capture.crop.bottom' }
]

/** Horizontal grid cells per LED on the longest edge, which is what "enough resolution" means here. */
function cellsPerLed (config: EngineConfig, gridWidth: number): number {
  const layout = config.layout
  const longest = layout.kind === 'matrix'
    ? Math.max(layout.columns, 1)
    : Math.max(layout.top, layout.bottom, 1)
  return gridWidth / longest
}

export function CaptureCard () {
  const t = useTranslate()
  const { probe, host, pageCapable, saveConfig } = useEngine()
  const { config, setConfig } = useEngineConfig()
  const [draft, setDraft] = useState<CaptureConfig | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // The draft starts from whatever the engine reported and is only replaced by
  // edits, so opening this page while a capture runs never disturbs it.
  const current = draft ?? config.capture
  const patch = useCallback((over: Partial<CaptureConfig>) => {
    setNotice(null)
    setDraft((value) => ({ ...(value ?? config.capture), ...over }))
  }, [config.capture])

  const problem = useMemo(() => {
    try {
      parseEngineConfig({ ...config, capture: current })
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }, [config, current])

  const cells = cellsPerLed(config, current.gridWidth)
  const remaining = Math.round(
    (1 - current.crop.left - current.crop.right) * (1 - current.crop.top - current.crop.bottom) * 100
  )

  const apply = useCallback(() => {
    if (problem !== null) return
    setSaving(true)
    const next = { ...config, capture: current }
    void saveConfig(next).then((failure) => {
      setSaving(false)
      if (failure !== null) { setNotice(t('capture.failed', { reason: failure })); return }
      setConfig(next)
      setDraft(null)
      setNotice(t('capture.applied'))
    })
  }, [config, current, problem, saveConfig, setConfig, t])

  // These are engine settings, so they need an engine - but since the page
  // host exists that no longer means an extension. The gate asks whether
  // anything can run, not whether one particular host is installed.
  const hosted = host === 'page' ? pageCapable : probe === null || probe.available === true
  if (!hosted) {
    return (
      <Card variant="default">
        <Card.Header><Card.Title>{t('nav.capture')}</Card.Title></Card.Header>
        <Card.Content><p className="text-sm text-muted">{t('capture.needEngine')}</p></Card.Content>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Card variant="default">
        <Card.Header>
          <Card.Title>{t('capture.grid.title')}</Card.Title>
          <Card.Description>{t('capture.grid.description')}</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <GridField
              label={t('capture.gridWidth')}
              value={current.gridWidth}
              onChange={(gridWidth) => patch({ gridWidth })}
            />
            <GridField
              label={t('capture.gridHeight')}
              value={current.gridHeight}
              onChange={(gridHeight) => patch({ gridHeight })}
            />
          </div>
          <p className="text-xs text-muted">
            {t('capture.cells', { cells: cells.toFixed(1) })}
            {cells < 2 && ` · ${t('capture.cellsTight')}`}
          </p>

          <Slider
            maxValue={FPS_MAX}
            minValue={FPS_MIN}
            step={1}
            value={current.fps}
            onChange={(value) => patch({ fps: value as number })}
          >
            <Label>{t('capture.fps')}</Label>
            <Slider.Output />
            <Slider.Track>
              <Slider.Fill />
              <Slider.Thumb />
            </Slider.Track>
          </Slider>
          <p className="text-xs text-muted">{t('capture.fps.note')}</p>
        </Card.Content>
      </Card>

      <Card variant="default">
        <Card.Header>
          <Card.Title>{t('capture.crop.title')}</Card.Title>
          <Card.Description>{t('capture.crop.description')}</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {CROP_SIDES.map((side) => (
              <Slider
                key={side.key}
                maxValue={CROP_MAX}
                minValue={0}
                step={0.01}
                value={current.crop[side.key]}
                onChange={(value) => patch({ crop: { ...current.crop, [side.key]: value as number } })}
              >
                <Label>{t(side.label)}</Label>
                <Slider.Output>{`${Math.round(current.crop[side.key] * 100)}%`}</Slider.Output>
                <Slider.Track>
                  <Slider.Fill />
                  <Slider.Thumb />
                </Slider.Track>
              </Slider>
            ))}
          </div>
          <p className="text-xs text-muted">{t('capture.remaining', { percent: remaining })}</p>
        </Card.Content>
      </Card>

      {problem !== null && (
        <Surface className="rounded-xl p-3 text-sm text-danger" variant="secondary">{problem}</Surface>
      )}
      {notice !== null && (
        <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button isDisabled={problem !== null || saving || draft === null} onPress={apply}>
          {t('capture.apply')}
        </Button>
        <span className="text-xs text-muted">{t('capture.restart')}</span>
      </div>
    </div>
  )
}

function GridField ({ label, value, onChange }: { label: string, value: number, onChange: (value: number) => void }) {
  return (
    <NumberField
      maxValue={GRID_MAX}
      minValue={GRID_MIN}
      step={8}
      value={value}
      variant="secondary"
      onChange={(next) => { if (Number.isFinite(next)) onChange(next) }}
    >
      <Label>{label}</Label>
      <NumberField.Group>
        <NumberField.DecrementButton />
        <NumberField.Input className="w-16" />
        <NumberField.IncrementButton />
      </NumberField.Group>
    </NumberField>
  )
}
