'use client'

import { useMemo, useState } from 'react'
import {
  Button,
  Card,
  ColorArea,
  ColorField,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  ColorSwatchPicker,
  Label,
  Slider,
  Surface,
  Switch,
  parseColor,
  type Color
} from '@heroui/react'

import { DeviceCard } from '#components/DeviceCard'
import { GuideCard } from '#components/GuideCard'
import { LayoutCard } from '#components/LayoutCard'
import { PreferencesMenu } from '#components/PreferencesMenu'
import { ProfilesCard } from '#components/ProfilesCard'
import { LedFrame } from '#components/LedFrame'
import { useTranslate } from '#components/Preferences'
import { toHex, toLinear16, toRgb8 } from '#lib/colour'
import { DEFAULT_ENGINE_CONFIG, resolveLayout, type EngineConfig } from '#lib/engine/config'
import { frameAspect } from '#lib/preview'

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'
]

/**
 * The strip lit with the chosen colour, in the geometry the CONFIGURED layout
 * describes - so this doubles as a wiring check: if the on-screen frame does not
 * match the desk, the layout is wrong, and the layout card above is where to fix
 * it. The rectangles come from `resolveLayout`, the same call the engine makes.
 */
function StripPreview ({ config, color, brightness }: { config: EngineConfig, color: Color, brightness: number }) {
  const t = useTranslate()
  const css = useMemo(() => {
    const { r, g, b } = toRgb8(color)
    const scale = brightness / 100
    return `rgb(${Math.round(r * scale)} ${Math.round(g * scale)} ${Math.round(b * scale)})`
  }, [color, brightness])
  const rects = useMemo(() => resolveLayout(config), [config])

  return (
    <LedFrame
      aspectRatio={frameAspect(config.layout)}
      colorAt={() => css}
      glow
      label={`${t('preview.title')} — ${t('layout.leds', { count: rects.length })}`}
      rects={rects}
    />
  )
}

export function ControlPanel () {
  const t = useTranslate()
  const [color, setColor] = useState<Color>(parseColor('#3b82f6'))
  const [brightness, setBrightness] = useState(70)
  const [isEnabled, setIsEnabled] = useState(true)
  /**
   * The layout in force, as the layout card reports it: from the extension if it
   * is installed, else this browser's stored copy, else the reference rig. Held
   * here because two cards draw it and they must not disagree.
   */
  const [config, setConfig] = useState<EngineConfig>(DEFAULT_ENGINE_CONFIG as EngineConfig)
  /**
   * A profile the user loaded. It travels to the layout card as a draft rather
   * than being applied here, so the strip still only changes on Apply.
   */
  const [loaded, setLoaded] = useState<{ config: EngineConfig, at: number } | undefined>(undefined)
  /**
   * What the layout editor currently shows. Saving a profile saves THIS, not
   * `config`: someone who tweaks the depth and presses Save means the layout in
   * front of them, not the one the strip happens to be running.
   */
  const [draft, setDraft] = useState<EngineConfig>(DEFAULT_ENGINE_CONFIG as EngineConfig)

  // What would go on the wire. Shown because it is the fastest way to see that
  // the linear decode is doing something: a mid sRGB value lands far lower in
  // linear, and that is correct, not a bug.
  const wire = useMemo(() => toLinear16(color), [color])
  const srgb = useMemo(() => toRgb8(color), [color])

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">AmbiFlux</h1>
          <p className="text-sm text-muted">{t('app.tagline')}</p>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <PreferencesMenu />
          <Switch className="pb-2" isSelected={isEnabled} size="md" onChange={setIsEnabled}>
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              {t('app.lighting')}
            </Switch.Content>
          </Switch>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card variant="default">
          <Card.Header>
            <Card.Title>{t('colour.title')}</Card.Title>
            <Card.Description>{t('colour.description')}</Card.Description>
          </Card.Header>
          <Card.Content className="flex flex-col gap-4">
            {/*
              ColorArea, ColorSlider, ColorField and ColorSwatch read the shared
              colour from ColorPicker's context, so none of them needs its own
              value/onChange. There is no ColorWheel in HeroUI v3 — a saturation
              x brightness area plus a hue slider is the supported shape.
            */}
            <ColorPicker value={color} onChange={setColor}>
              <ColorPicker.Trigger>
                <ColorSwatch size="lg" />
                <Label>{t('colour.pick')}</Label>
              </ColorPicker.Trigger>
              <ColorPicker.Popover className="gap-2">
                <ColorSwatchPicker className="justify-center pt-2" size="xs">
                  {PRESET_COLORS.map((preset) => (
                    <ColorSwatchPicker.Item key={preset} color={preset}>
                      <ColorSwatchPicker.Swatch />
                    </ColorSwatchPicker.Item>
                  ))}
                </ColorSwatchPicker>
                <ColorArea
                  aria-label={t('colour.saturation')}
                  className="max-w-full"
                  colorSpace="hsb"
                  xChannel="saturation"
                  yChannel="brightness"
                >
                  <ColorArea.Thumb />
                </ColorArea>
                <ColorSlider aria-label={t('colour.hue')} channel="hue" colorSpace="hsb">
                  <ColorSlider.Track>
                    <ColorSlider.Thumb />
                  </ColorSlider.Track>
                </ColorSlider>
                <ColorField aria-label={t('colour.hex')}>
                  <ColorField.Group variant="secondary">
                    <ColorField.Prefix>
                      <ColorSwatch size="xs" />
                    </ColorField.Prefix>
                    <ColorField.Input />
                  </ColorField.Group>
                </ColorField>
              </ColorPicker.Popover>
            </ColorPicker>

            <Slider
              maxValue={100}
              minValue={0}
              step={1}
              value={brightness}
              onChange={(value) => setBrightness(value as number)}
            >
              <Label>{t('colour.brightness')}</Label>
              <Slider.Output />
              <Slider.Track>
                <Slider.Fill />
                <Slider.Thumb />
              </Slider.Track>
            </Slider>
          </Card.Content>
        </Card>

        <Card variant="default">
          <Card.Header>
            <Card.Title>{t('preview.title')}</Card.Title>
            <Card.Description>{t('preview.description')}</Card.Description>
          </Card.Header>
          <Card.Content className="flex flex-col gap-4">
            <StripPreview brightness={isEnabled ? brightness : 0} color={color} config={config} />
            <Surface className="rounded-xl p-3 font-mono text-xs" variant="secondary">
              <div className="flex justify-between">
                <span className="text-muted">{t('preview.selected')}</span>
                <span>{toHex(color)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">{t('preview.srgb')}</span>
                <span>{srgb.r}, {srgb.g}, {srgb.b}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">{t('preview.wire')}</span>
                <span>{wire.r}, {wire.g}, {wire.b}</span>
              </div>
            </Surface>
            <p className="text-xs text-muted">{t('preview.note')}</p>
          </Card.Content>
        </Card>
      </div>

      <LayoutCard loaded={loaded} onConfig={setConfig} onDraft={setDraft} />

      <ProfilesCard
        current={draft}
        onLoad={(profile) => setLoaded({ config: profile, at: Date.now() })}
      />

      <DeviceCard />

      <GuideCard />
    </div>
  )
}
