'use client'

import { useMemo, useState } from 'react'
import {
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
  parseColor,
  type Color
} from '@heroui/react'

import { useEngineConfig } from '#components/EngineConfig'
import { LedFrame } from '#components/LedFrame'
import { useTranslate } from '#components/Preferences'
import { toHex, toLinear16, toRgb8 } from '#lib/colour'
import { resolveLayout, type EngineConfig } from '#lib/engine/config'
import { frameAspect } from '#lib/preview'

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'
]

/**
 * The strip lit with the chosen colour, in the geometry the CONFIGURED layout
 * describes - so this doubles as a wiring check: if the on-screen frame does not
 * match the desk, the layout is wrong, and the LED hardware page is where to fix
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

/**
 * A fixed colour, for when nothing is following the screen.
 *
 * Kept as its own section rather than folded into the overview: it is the one
 * page that is useful with no extension, no capture and no board - the strip
 * lit by hand - and burying it under the engine's status would hide it from
 * exactly the person who has nothing else working yet.
 */
export function ColourCard ({ enabled }: { enabled: boolean }) {
  const t = useTranslate()
  const { config } = useEngineConfig()
  const [color, setColor] = useState<Color>(parseColor('#3b82f6'))
  const [brightness, setBrightness] = useState(70)

  // What would go on the wire. Shown because it is the fastest way to see that
  // the linear decode is doing something: a mid sRGB value lands far lower in
  // linear, and that is correct, not a bug.
  const wire = useMemo(() => toLinear16(color), [color])
  const srgb = useMemo(() => toRgb8(color), [color])

  return (
    <div className="grid gap-6 xl:grid-cols-2">
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
          <StripPreview brightness={enabled ? brightness : 0} color={color} config={config} />
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
  )
}
