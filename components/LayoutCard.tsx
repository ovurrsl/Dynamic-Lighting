'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Card,
  Label,
  ListBox,
  NumberField,
  Select,
  Slider,
  Surface,
  Switch
} from '@heroui/react'

import { LedFrame } from '#components/LedFrame'
import { clearStoredConfig, loadStoredConfig, storeConfig } from '#lib/config-store'
import {
  DEFAULT_ENGINE_CONFIG,
  MATRIX_ENGINE_CONFIG,
  parseEngineConfig,
  resolveLayout,
  type EngineConfig,
  type LayoutConfig
} from '#lib/engine/config'
import { CORNERS, LAYOUT_DEFAULTS, type Corner } from '#lib/engine/layout'
import { COLOR_ORDERS, type ColorOrder } from '#lib/engine/order'
import { frameAspect, wireOrderColor } from '#lib/preview'
import type { LedRect } from '#lib/engine/types'
import { fetchConfig, saveConfig } from '#lib/extension-client'

/**
 * The layout editor: which LED looks where.
 *
 * The picture comes from `resolveLayout`, the same function the capture engine
 * calls to decide what each LED samples. That is the whole point of this card
 * and the reason the layout generators live under lib/engine/ rather than in
 * the extension: a preview drawn by its own code is a preview that can be
 * right while the engine is wrong, which is worse than no preview.
 *
 * Nothing here is applied as you drag. The engine is running on a strip on
 * someone's desk; a half-typed edge count must not reach it. Edits build a
 * candidate, the candidate is validated by `parseEngineConfig`, and only
 * "Uygula" sends it.
 */

const CORNER_LABEL: Record<Corner, string> = {
  'top-left': 'sol üst',
  'top-right': 'sağ üst',
  'bottom-right': 'sağ alt',
  'bottom-left': 'sol alt'
}

/** Hyperion's names read as the ORDER OF THE WIRE, which is the output spelling. */
const ORDER_LABEL: Record<ColorOrder, string> = {
  rgb: 'RGB (standart WS2812B)',
  rbg: 'RBG',
  grb: 'GRB',
  gbr: 'GBR',
  brg: 'BRG',
  bgr: 'BGR'
}

interface Resolved {
  config: EngineConfig
  rects: LedRect[]
}

function EdgeCount ({
  label,
  value,
  onChange
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <NumberField
      maxValue={512}
      minValue={0}
      value={value}
      variant="secondary"
      // A cleared input reports NaN; that is a keystroke, not a layout.
      onChange={(next) => { if (Number.isFinite(next)) onChange(next) }}
    >
      <Label>{label}</Label>
      <NumberField.Group>
        <NumberField.DecrementButton />
        <NumberField.Input className="w-14" />
        <NumberField.IncrementButton />
      </NumberField.Group>
    </NumberField>
  )
}

function Fraction ({
  label,
  value,
  maxValue,
  step = 0.005,
  onChange
}: {
  label: string
  value: number
  maxValue: number
  step?: number
  onChange: (value: number) => void
}) {
  return (
    <Slider
      maxValue={maxValue}
      minValue={0}
      step={step}
      value={value}
      onChange={(next) => onChange(next as number)}
    >
      <Label>{label}</Label>
      <Slider.Output>{`${(value * 100).toFixed(1)}%`}</Slider.Output>
      <Slider.Track>
        <Slider.Fill />
        <Slider.Thumb />
      </Slider.Track>
    </Slider>
  )
}

export function LayoutCard ({ onConfig }: { onConfig?: (config: EngineConfig) => void }) {
  /**
   * Held in a ref so the seeding effect below depends on nothing at all. As a
   * dependency it would re-run - and re-query the extension - on every render
   * for any caller that passes an inline function, which is most of them.
   */
  const report = useRef(onConfig)
  report.current = onConfig
  const [draft, setDraft] = useState<EngineConfig>(DEFAULT_ENGINE_CONFIG as EngineConfig)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [advanced, setAdvanced] = useState(false)

  /**
   * Where the starting configuration comes from, in order: the extension, then
   * this browser's stored copy, then the reference rig. The extension first
   * because it is the one that is actually driving LEDs - opening the editor on
   * a stale local copy and pressing Apply would silently undo whatever the
   * strip is running.
   *
   * Read after mount, never during render: the server has no localStorage and
   * no extension, so reading either while rendering would make the server's
   * HTML and the client's first paint disagree.
   */
  useEffect(() => {
    let cancelled = false
    const stored = loadStoredConfig()
    if (stored.source === 'stored') {
      setDraft(stored.config)
      report.current?.(stored.config)
    } else if (stored.problem !== undefined) {
      setNotice(`Kayıtlı yapılandırma okunamadı: ${stored.problem}`)
    }
    void fetchConfig().then((live) => {
      if (cancelled || live === null) return
      setDraft(live)
      report.current?.(live)
    })
    return () => { cancelled = true }
  }, [])

  /**
   * The candidate, validated the same way the extension will validate it. The
   * last drawable layout is kept so that a momentarily impossible edit shows
   * its error without the picture disappearing - a preview that blinks out
   * while you type is a preview you stop trusting.
   */
  const lastGood = useRef<Resolved | null>(null)
  const resolved = useMemo<{ ok: true, value: Resolved } | { ok: false, message: string }>(() => {
    try {
      const config = parseEngineConfig(draft)
      const value = { config, rects: resolveLayout(config) }
      lastGood.current = value
      return { ok: true, value }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }, [draft])

  const shown = resolved.ok ? resolved.value : lastGood.current
  const layout = draft.layout

  const patchLayout = useCallback((partial: Partial<LayoutConfig>) => {
    setNotice(null)
    setDraft((current) => ({ ...current, layout: { ...current.layout, ...partial } as LayoutConfig }))
  }, [])

  const apply = useCallback(() => {
    if (!resolved.ok) return
    const config = resolved.value.config
    setSaving(true)
    const failure = storeConfig(config)
    void saveConfig(config).then((error) => {
      setSaving(false)
      if (error !== null) { setNotice(`Eklenti kabul etmedi: ${error}`); return }
      report.current?.(config)
      setNotice(failure === null
        ? 'Uygulandı ve kaydedildi.'
        : `Motora gönderildi, ama bu tarayıcıya kaydedilemedi: ${failure}`)
    })
  }, [resolved])

  const reset = useCallback((to: EngineConfig) => {
    clearStoredConfig()
    setDraft(to)
    report.current?.(to)
    setNotice('Varsayılana döndü. Motora göndermek için Uygula.')
  }, [])

  const aspectRatio = frameAspect(layout)

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>Monitör yerleşimi</Card.Title>
        <Card.Description>
          Her LED'in ekranın neresine baktığı. Resim, motorun örnekleme yaparken
          çağırdığı fonksiyonun çıktısı — yani gördüğün şey ölçülen şey.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-5">
        {shown !== null && (
          <LedFrame
            aspectRatio={aspectRatio}
            colorAt={wireOrderColor}
            label={`${shown.rects.length} LED'in örnekleme bölgeleri`}
            outlineFirst
            rects={shown.rects}
          />
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-muted">
            {shown === null ? '—' : `${shown.rects.length} LED`}
            {layout.kind === 'classic' && ' · beyaz çerçeveli olan LED 0'}
          </span>
          <Select
            className="w-44"
            value={layout.kind}
            onChange={(value) => {
              setNotice(null)
              setDraft(value === 'matrix' ? MATRIX_ENGINE_CONFIG as EngineConfig : DEFAULT_ENGINE_CONFIG as EngineConfig)
            }}
          >
            <Label>Yerleşim türü</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id="classic" textValue="Kenar çerçevesi">
                  Kenar çerçevesi
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item id="matrix" textValue="Matris">
                  Matris
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        </div>

        {layout.kind === 'classic'
          ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <EdgeCount label="Üst" value={layout.top} onChange={(top) => patchLayout({ top })} />
                <EdgeCount label="Sağ" value={layout.right} onChange={(right) => patchLayout({ right })} />
                <EdgeCount label="Alt" value={layout.bottom} onChange={(bottom) => patchLayout({ bottom })} />
                <EdgeCount label="Sol" value={layout.left} onChange={(left) => patchLayout({ left })} />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Fraction
                  label="Üst/alt bant derinliği (yüksekliğin oranı)"
                  maxValue={0.5}
                  value={layout.depthTopBottom}
                  onChange={(depthTopBottom) => patchLayout({ depthTopBottom })}
                />
                <Fraction
                  label="Yan bant derinliği (genişliğin oranı)"
                  maxValue={0.5}
                  value={layout.depthLeftRight}
                  onChange={(depthLeftRight) => patchLayout({ depthLeftRight })}
                />
              </div>

              <div className="flex flex-wrap items-end gap-4">
                <Select
                  className="w-40"
                  value={layout.start}
                  onChange={(value) => patchLayout({ start: value as Corner })}
                >
                  <Label>Şeridin başladığı köşe</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {CORNERS.map((corner) => (
                        <ListBox.Item id={corner} key={corner} textValue={CORNER_LABEL[corner]}>
                          {CORNER_LABEL[corner]}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>

                <NumberField
                  className="w-36"
                  value={layout.offset ?? LAYOUT_DEFAULTS.offset}
                  variant="secondary"
                  onChange={(offset) => { if (Number.isFinite(offset)) patchLayout({ offset }) }}
                >
                  <Label>Köşeden kaç LED sonra</Label>
                  <NumberField.Group>
                    <NumberField.DecrementButton />
                    <NumberField.Input className="w-12" />
                    <NumberField.IncrementButton />
                  </NumberField.Group>
                </NumberField>

                <Switch
                  isSelected={layout.clockwise}
                  size="md"
                  onChange={(clockwise) => patchLayout({ clockwise })}
                >
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    Saat yönünde
                  </Switch.Content>
                </Switch>
              </div>

              <Switch isSelected={advanced} size="sm" onChange={setAdvanced}>
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  Gelişmiş
                </Switch.Content>
              </Switch>

              {advanced && (
                <div className="flex flex-col gap-4 rounded-xl border border-default/40 p-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Fraction
                      label="Bant örtüşmesi"
                      maxValue={1}
                      step={0.01}
                      value={layout.overlap ?? LAYOUT_DEFAULTS.overlap}
                      onChange={(overlap) => patchLayout({ overlap })}
                    />
                    <Fraction
                      label="Köşe boşluğu (şerit köşeye yetişmiyorsa)"
                      maxValue={0.3}
                      value={layout.edgeGap ?? LAYOUT_DEFAULTS.edgeGap}
                      onChange={(edgeGap) => patchLayout({ edgeGap })}
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <NumberField
                      formatOptions={{ maximumFractionDigits: 3 }}
                      minValue={0.2}
                      step={0.01}
                      value={layout.aspectRatio ?? LAYOUT_DEFAULTS.aspectRatio}
                      variant="secondary"
                      onChange={(aspect) => { if (Number.isFinite(aspect)) patchLayout({ aspectRatio: aspect }) }}
                    >
                      <Label>En/boy oranı</Label>
                      <NumberField.Group>
                        <NumberField.DecrementButton />
                        <NumberField.Input className="w-16" />
                        <NumberField.IncrementButton />
                      </NumberField.Group>
                    </NumberField>
                    <NumberField
                      minValue={0}
                      value={layout.gap?.position ?? 0}
                      variant="secondary"
                      onChange={(position) => {
                        if (!Number.isFinite(position)) return
                        patchLayout({ gap: { position, length: layout.gap?.length ?? 0 } })
                      }}
                    >
                      <Label>Eksik bölüm başlangıcı</Label>
                      <NumberField.Group>
                        <NumberField.DecrementButton />
                        <NumberField.Input className="w-14" />
                        <NumberField.IncrementButton />
                      </NumberField.Group>
                    </NumberField>
                    <NumberField
                      minValue={0}
                      value={layout.gap?.length ?? 0}
                      variant="secondary"
                      onChange={(length) => {
                        if (!Number.isFinite(length)) return
                        patchLayout({ gap: { position: layout.gap?.position ?? 0, length } })
                      }}
                    >
                      <Label>Eksik LED sayısı</Label>
                      <NumberField.Group>
                        <NumberField.DecrementButton />
                        <NumberField.Input className="w-14" />
                        <NumberField.IncrementButton />
                      </NumberField.Group>
                    </NumberField>
                  </div>
                  <p className="text-xs text-muted">
                    Köşe boşluğu yükseklik oranı olarak veriliyor ve yatayda en/boy
                    oranıyla ölçekleniyor, böylece dört kenarda da aynı fiziksel
                    mesafe oluyor. Eksik bölüm, şeridin hiç uğramadığı yeri geometrik
                    sırada anlatır: sonraki LED'ler öne kayar, çünkü kabloda da kayıyorlar.
                  </p>
                </div>
              )}
            </>
            )
          : (
            <div className="grid gap-3 sm:grid-cols-2">
              <EdgeCount label="Kolon" value={layout.columns} onChange={(columns) => patchLayout({ columns })} />
              <EdgeCount label="Satır" value={layout.rows} onChange={(rows) => patchLayout({ rows })} />
              <Select
                value={layout.cabling}
                onChange={(value) => patchLayout({ cabling: value as 'snake' | 'parallel' })}
              >
                <Label>Kablolama</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="snake" textValue="Yılan (sıra sonunda geri döner)">
                      Yılan (sıra sonunda geri döner)
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    <ListBox.Item id="parallel" textValue="Paralel (her sıra aynı yönde)">
                      Paralel (her sıra aynı yönde)
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  </ListBox>
                </Select.Popover>
              </Select>
              <Select
                value={layout.direction}
                onChange={(value) => patchLayout({ direction: value as 'horizontal' | 'vertical' })}
              >
                <Label>Tarama yönü</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="horizontal" textValue="Yatay">
                      Yatay
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    <ListBox.Item id="vertical" textValue="Dikey">
                      Dikey
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
            )}

        <Select
          className="w-64"
          value={draft.colorOrder.order}
          onChange={(value) => {
            setNotice(null)
            setDraft((current) => ({ ...current, colorOrder: { ...current.colorOrder, order: value as ColorOrder } }))
          }}
        >
          <Label>Kanal sırası</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {COLOR_ORDERS.map((order) => (
                <ListBox.Item id={order} key={order} textValue={ORDER_LABEL[order]}>
                  {ORDER_LABEL[order]}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <p className="text-xs text-muted">
          Kırmızı isteyip yeşil yanıyorsa sıra yanlış. İsim, kabloya çıkan
          sıralamayı okur: GRB, kırmızının ikinci kanala gittiği şerittir.
        </p>

        {!resolved.ok && (
          <Surface className="rounded-xl p-3 text-sm text-danger" variant="secondary">
            {resolved.message}
            <span className="block text-xs text-muted">
              Resim, çizilebilen son yerleşimi gösteriyor.
            </span>
          </Surface>
        )}
        {notice !== null && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
        )}

        <div className="flex flex-wrap gap-2">
          <Button isDisabled={!resolved.ok || saving} onPress={apply}>
            {saving ? 'Uygulanıyor…' : 'Uygula'}
          </Button>
          <Button
            variant="secondary"
            onPress={() => reset((layout.kind === 'matrix' ? MATRIX_ENGINE_CONFIG : DEFAULT_ENGINE_CONFIG) as EngineConfig)}
          >
            Varsayılana dön
          </Button>
        </div>
        <p className="text-xs text-muted">
          Uygula basılana kadar hiçbir şey şeride gitmez: yarısı yazılmış bir
          kenar sayısı masadaki motora ulaşmamalı.
        </p>
      </Card.Content>
    </Card>
  )
}
