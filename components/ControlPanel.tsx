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
import { LayoutCard } from '#components/LayoutCard'
import { LedFrame } from '#components/LedFrame'
import { toHex, toLinear16, toRgb8 } from '#lib/colour'
import type { LicenceGrant } from '#lib/client-api'
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
      label={`${rects.length} LED önizlemesi`}
      rects={rects}
    />
  )
}

/**
 * The panel opens without a licence.
 *
 * Be clear about what this does: the wall is gone for EVERYONE, not just for the
 * owner. On a public page there is no way to recognise one person without a
 * credential, and the credential would be the licence key - which is the thing
 * we are trying not to ask for. So the licence stops guarding the door and
 * guards entitlements instead, which is how it was designed: `features` lives
 * inside the signed token and the client reads its rights from verified data.
 *
 * Nothing is weakened by this. No feature is gated in the UI today, and when one
 * is, it will read grant.features - which is null here and therefore grants
 * nothing.
 */
export function ControlPanel ({
  grant,
  onActivate
}: {
  grant: LicenceGrant | null
  onActivate?: () => void
}) {
  const [color, setColor] = useState<Color>(parseColor('#3b82f6'))
  const [brightness, setBrightness] = useState(70)
  const [isEnabled, setIsEnabled] = useState(true)
  /**
   * The layout in force, as the layout card reports it: from the extension if it
   * is installed, else this browser's stored copy, else the reference rig. Held
   * here because two cards draw it and they must not disagree.
   */
  const [config, setConfig] = useState<EngineConfig>(DEFAULT_ENGINE_CONFIG as EngineConfig)

  // What would go on the wire. Shown because it is the fastest way to see that
  // the linear decode is doing something: a mid sRGB value lands far lower in
  // linear, and that is correct, not a bug.
  const wire = useMemo(() => toLinear16(color), [color])
  const srgb = useMemo(() => toRgb8(color), [color])

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">AmbiFlux</h1>
          {grant === null
            ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <span>Lisanssız</span>
                {onActivate !== undefined && (
                  <Button size="sm" variant="secondary" onPress={onActivate}>
                    Lisans ekle
                  </Button>
                )}
              </p>
              )
            : (
              <p className="text-sm text-muted">
                {grant.tier} · {grant.seats.used}/{grant.seats.max} cihaz
              </p>
              )}
        </div>
        <Switch isSelected={isEnabled} size="md" onChange={setIsEnabled}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            Aydınlatma
          </Switch.Content>
        </Switch>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card variant="default">
          <Card.Header>
            <Card.Title>Renk</Card.Title>
            <Card.Description>
              Sürüklerken canlı önizlenir, bıraktığında cihaza yazılır.
            </Card.Description>
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
                <Label>Renk seç</Label>
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
                  aria-label="Doygunluk ve parlaklık"
                  className="max-w-full"
                  colorSpace="hsb"
                  xChannel="saturation"
                  yChannel="brightness"
                >
                  <ColorArea.Thumb />
                </ColorArea>
                <ColorSlider aria-label="Renk tonu" channel="hue" colorSpace="hsb">
                  <ColorSlider.Track>
                    <ColorSlider.Thumb />
                  </ColorSlider.Track>
                </ColorSlider>
                <ColorField aria-label="Onaltılık renk kodu">
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
              <Label>Parlaklık</Label>
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
            <Card.Title>Önizleme</Card.Title>
            <Card.Description>
              Şeridin fiziksel sırası. Masadakiyle eşleşmiyorsa yerleşim ayarı yanlış.
            </Card.Description>
          </Card.Header>
          <Card.Content className="flex flex-col gap-4">
            <StripPreview brightness={isEnabled ? brightness : 0} color={color} config={config} />
            <Surface className="rounded-xl p-3 font-mono text-xs" variant="secondary">
              <div className="flex justify-between">
                <span className="text-muted">seçilen</span>
                <span>{toHex(color)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">sRGB 8-bit</span>
                <span>{srgb.r}, {srgb.g}, {srgb.b}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">tele giden (doğrusal 16-bit)</span>
                <span>{wire.r}, {wire.g}, {wire.b}</span>
              </div>
            </Surface>
            <p className="text-xs text-muted">
              Doğrusal değerlerin sRGB'den belirgin düşük olması beklenir: firmware
              hiçbir transfer fonksiyonu uygulamıyor, o yüzden kodlama burada çözülüyor.
            </p>
          </Card.Content>
        </Card>
      </div>

      <LayoutCard onConfig={setConfig} />

      <DeviceCard />
    </div>
  )
}
