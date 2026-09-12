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

import { toHex, toLinear16, toRgb8 } from '#lib/colour'
import type { LicenceGrant } from '#lib/client-api'

/** Edge layout of the reference rig. Becomes per-user configuration later. */
const EDGES = { top: 35, right: 19, bottom: 35, left: 19 } as const
const LED_COUNT = EDGES.top + EDGES.right + EDGES.bottom + EDGES.left

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'
]

/**
 * Renders the strip as it is physically wired, so the preview doubles as a
 * wiring check: if the on-screen ring does not match the desk, the layout
 * configuration is wrong.
 */
function StripPreview ({ color, brightness }: { color: Color, brightness: number }) {
  const css = useMemo(() => {
    const { r, g, b } = toRgb8(color)
    const scale = brightness / 100
    return `rgb(${Math.round(r * scale)} ${Math.round(g * scale)} ${Math.round(b * scale)})`
  }, [color, brightness])

  const dot = (key: string) => (
    <span
      key={key}
      className="size-1.5 rounded-full"
      style={{ backgroundColor: css, boxShadow: `0 0 6px ${css}` }}
    />
  )

  return (
    <div className="flex flex-col gap-2" aria-label={`${LED_COUNT} LED önizlemesi`}>
      <div className="flex justify-between gap-px">
        {Array.from({ length: EDGES.top }, (_, i) => dot(`t${i}`))}
      </div>
      <div className="flex items-stretch justify-between gap-4">
        <div className="flex flex-col justify-between gap-px">
          {Array.from({ length: EDGES.left }, (_, i) => dot(`l${i}`))}
        </div>
        <div className="flex-1 rounded-lg bg-background/60 p-4 text-center text-xs text-muted">
          {LED_COUNT} LED
        </div>
        <div className="flex flex-col justify-between gap-px">
          {Array.from({ length: EDGES.right }, (_, i) => dot(`r${i}`))}
        </div>
      </div>
      <div className="flex justify-between gap-px">
        {Array.from({ length: EDGES.bottom }, (_, i) => dot(`b${i}`))}
      </div>
    </div>
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
            <StripPreview brightness={isEnabled ? brightness : 0} color={color} />
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

      <Card variant="default">
        <Card.Header>
          <Card.Title>Cihaz</Card.Title>
          <Card.Description>
            Yakalama ve seri port tarayıcı eklentisinde çalışıyor.
          </Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-wrap items-center gap-3">
          {/*
            Not wired yet on purpose. The extension owns capture and the serial
            port; showing a fake "connected" state here would be worse than
            showing none.
          */}
          <Button isDisabled variant="secondary">
            Eklentiye bağlan
          </Button>
          <span className="text-sm text-muted">Eklenti henüz yayınlanmadı.</span>
        </Card.Content>
      </Card>
    </div>
  )
}
