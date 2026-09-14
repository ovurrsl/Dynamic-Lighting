'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Card,
  Input,
  Label,
  ListBox,
  NumberField,
  Select,
  Slider,
  Surface,
  Switch,
  TextField
} from '@heroui/react'

import { LedFrame } from '#components/LedFrame'
import { useTranslate } from '#components/Preferences'
import { clearStoredConfig, loadStoredConfig, storeConfig } from '#lib/config-store'
import {
  DEFAULT_ENGINE_CONFIG,
  OUTPUT_TRANSPORTS,
  WIRE_FORMATS,
  MATRIX_ENGINE_CONFIG,
  parseEngineConfig,
  resolveLayout,
  switchTransport,
  type EngineConfig,
  type LayoutConfig,
  type OutputTransport,
  type WireFormat
} from '#lib/engine/config'
import { CORNERS, LAYOUT_DEFAULTS, NO_KEYSTONE, type Corner, type Keystone } from '#lib/engine/layout'
import { COLOR_ORDERS, type ColorOrder } from '#lib/engine/order'
import { createLiveSampler, PREVIEW_HZ, type LiveFrame, type LiveSampler } from '#lib/live-sampler'
import { CORNER_ORDER, frameAspect, isDefaultKeystone, wireOrderColor } from '#lib/preview'
import type { LedRect } from '#lib/engine/types'
import type { MessageKey } from '#lib/i18n/strings'
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

const CORNER_KEY: Record<Corner, MessageKey> = {
  'top-left': 'layout.corner.topLeft',
  'top-right': 'layout.corner.topRight',
  'bottom-right': 'layout.corner.bottomRight',
  'bottom-left': 'layout.corner.bottomLeft'
}

/**
 * Hyperion's names read as the ORDER OF THE WIRE, which is the output spelling.
 * The three letters are not translated - they name channels, not words - so only
 * the annotation on the common one goes through the table.
 */
function orderLabel (order: ColorOrder, standard: string): string {
  return order === 'rgb' ? `RGB (${standard})` : order.toUpperCase()
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

export function LayoutCard ({
  onConfig,
  onDraft,
  loaded
}: {
  /** The layout in force: reported on load and when Apply succeeds. */
  onConfig?: (config: EngineConfig) => void
  /**
   * The layout being edited, whenever it is valid. Separate from `onConfig`
   * because they answer different questions: what the strip is running, and
   * what you are looking at. Saving a profile wants the second.
   */
  onDraft?: (config: EngineConfig) => void
  /**
   * A configuration handed in from outside - loading a profile. It becomes the
   * DRAFT, not the running layout: the same rule as every other edit here, so
   * loading a profile shows you what it is before it reaches the strip.
   */
  loaded?: { config: EngineConfig, at: number }
}) {
  /**
   * Held in a ref so the seeding effect below depends on nothing at all. As a
   * dependency it would re-run - and re-query the extension - on every render
   * for any caller that passes an inline function, which is most of them.
   */
  const t = useTranslate()
  // Read once per render rather than inside the option loop: the annotation is
  // the same string for all six entries.
  const standard = t('layout.orderStandard')
  const report = useRef(onConfig)
  report.current = onConfig
  const reportDraft = useRef(onDraft)
  reportDraft.current = onDraft
  const [draft, setDraft] = useState<EngineConfig>(DEFAULT_ENGINE_CONFIG as EngineConfig)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [editingCorners, setEditingCorners] = useState(false)
  const [screen, setScreen] = useState<MediaStream | null>(null)
  /**
   * The live sample: one colour per LED, taken from the captured screen by the
   * engine's own modules. Null until a capture is running.
   */
  const [live, setLive] = useState<LiveFrame | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const liveSampler = useRef<LiveSampler | null>(null)

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
      setNotice(t('layout.storeReadFailed', { reason: stored.problem }))
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
  // Keyed by `at` rather than by the config, so loading the same profile twice
  // still applies it after the user has edited something in between.
  const lastLoadedAt = useRef<number | null>(null)
  useEffect(() => {
    if (loaded === undefined || loaded.at === lastLoadedAt.current) return
    lastLoadedAt.current = loaded.at
    setNotice(null)
    setDraft(loaded.config)
  }, [loaded])

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

  useEffect(() => {
    if (resolved.ok) reportDraft.current?.(resolved.value.config)
  }, [resolved])

  const shown = resolved.ok ? resolved.value : lastGood.current
  const layout = draft.layout
  const hostMissing = draft.output.transport !== 'serial' && (draft.output.host ?? '').trim() === ''

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
      if (error !== null) { setNotice(t('layout.extensionRejected', { reason: error })); return }
      report.current?.(config)
      setNotice(failure === null
        ? t('layout.applied')
        : t('layout.appliedNotStored', { reason: failure }))
    })
  }, [resolved, t])

  const reset = useCallback((to: EngineConfig) => {
    clearStoredConfig()
    setDraft(to)
    report.current?.(to)
    setNotice(t('layout.resetDone'))
  }, [t])

  const keystone: Keystone = (layout.kind === 'classic' ? layout.keystone : undefined) ?? NO_KEYSTONE

  const moveCorner = useCallback((corner: (typeof CORNER_ORDER)[number], point: { x: number, y: number }) => {
    setNotice(null)
    setDraft((current) => {
      if (current.layout.kind !== 'classic') return current
      const from = current.layout.keystone ?? NO_KEYSTONE
      return { ...current, layout: { ...current.layout, keystone: { ...from, [corner]: point } } }
    })
  }, [])

  /**
   * The screen behind the frame, so the corners can be dragged onto what is
   * actually on the monitor instead of onto an empty rectangle.
   *
   * This capture is the PANEL's, not the engine's: a visible tab may capture
   * freely, and the throttling that forced the engine into an extension only
   * bites a continuous background capture. It runs while this card is open and
   * stops when it is switched off - and DRM-protected video captures black
   * here for the same reason it does everywhere else.
   */
  const showScreen = useCallback(async () => {
    try {
      const media = navigator.mediaDevices
      if (media?.getDisplayMedia === undefined) {
        setNotice(t('layout.noScreenShare'))
        return
      }
      const stream = await media.getDisplayMedia({ video: { frameRate: 10 }, audio: false })
      // Chrome's own "stop sharing" bar ends the track without telling us
      // otherwise; without this the button would keep claiming it is on.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => { setScreen(null) })
      setScreen(stream)
    } catch (error) {
      // Cancelling the picker is a decision, not a failure.
      const name = error instanceof Error ? error.name : ''
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        setNotice(t('layout.screenFailed', {
          reason: error instanceof Error ? error.message : String(error)
        }))
      }
    }
  }, [t])

  useEffect(() => {
    const element = video.current
    if (element === null) return
    element.srcObject = screen
    if (screen === null) { setLive(null); return }
    void element.play().catch(() => {})

    // A plain interval rather than requestAnimationFrame: the rate is a
    // deliberate 15 Hz, not "as fast as the compositor", and a preview that
    // competes with the engine for the GPU is a preview that costs frames.
    const sampler = createLiveSampler(resolved.ok ? resolved.value.config : DEFAULT_ENGINE_CONFIG as EngineConfig)
    liveSampler.current = sampler
    const id = setInterval(() => {
      try {
        const frame = sampler.sample(element)
        if (frame !== null) setLive(frame)
      } catch {
        // A frame the browser will not draw yet is not worth a notice; the
        // next tick is 66 ms away.
      }
    }, Math.round(1000 / PREVIEW_HZ))

    return () => {
      clearInterval(id)
      liveSampler.current = null
      setLive(null)
      for (const track of screen.getTracks()) track.stop()
    }
    // The sampler is rebuilt from the draft by its own effect below; this one
    // owns the capture's lifetime and must not restart on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen])

  // A layout edit has to reach the running sampler, or the live colours would
  // keep coming from the layout that was showing when capture started.
  useEffect(() => {
    if (resolved.ok) liveSampler.current?.configure(resolved.value.config)
  }, [resolved])

  const aspectRatio = frameAspect(layout)

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('layout.title')}</Card.Title>
        <Card.Description>{t('layout.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-5">
        {shown !== null && (
          <div className="relative overflow-hidden rounded-lg bg-black/80">
            {/*
              Dimmed while sampling. At full brightness the LEDs vanish into
              the picture - they are the same colour as it, which is the point -
              so the screen becomes the context and the LEDs the subject.
            */}
            <video
              className={`absolute inset-0 size-full object-fill transition-opacity ${screen === null ? 'hidden' : live === null ? '' : 'opacity-45'}`}
              muted
              playsInline
              ref={video}
            />
            <LedFrame
              aspectRatio={aspectRatio}
              colorAt={live === null
                ? wireOrderColor
                : (at) => live.colors[at] ?? 'rgb(0 0 0)'}
              keystone={editingCorners ? keystone : undefined}
              label={t('layout.regions', { count: shown.rects.length })}
              onKeystone={editingCorners ? moveCorner : undefined}
              outline={live !== null}
              outlineFirst
              rects={shown.rects}
              transparent
            />
          </div>
        )}

        {live !== null && (
          <Surface className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl p-3 font-mono text-xs" variant="secondary">
            <span className="text-muted">{t('layout.live')}</span>
            <span>{live.source?.width}×{live.source?.height}</span>
            <span className="text-muted">{t('layout.blackBorder')}</span>
            <span>
              {live.border.unknown
                ? t('layout.borderUnknown')
                : t('layout.borderDetail', {
                  topBottom: live.border.topBottom,
                  leftRight: live.border.leftRight
                })}
            </span>
            <span className="text-muted">{t('layout.liveNote')}</span>
          </Surface>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="secondary"
            onPress={() => { screen === null ? void showScreen() : setScreen(null) }}
          >
            {t(screen === null ? 'layout.showScreen' : 'layout.releaseScreen')}
          </Button>
          {layout.kind === 'classic' && (
            <Switch isSelected={editingCorners} size="sm" onChange={setEditingCorners}>
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                {t('layout.editCorners')}
              </Switch.Content>
            </Switch>
          )}
          {layout.kind === 'classic' && !isDefaultKeystone(layout.keystone) && (
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                setNotice(null)
                setDraft((current) => current.layout.kind === 'classic'
                  ? { ...current, layout: { ...current.layout, keystone: NO_KEYSTONE } }
                  : current)
              }}
            >
              {t('layout.resetCorners')}
            </Button>
          )}
        </div>
        {editingCorners && (
          <p className="text-xs text-muted">{t('layout.cornersHelp')}</p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-muted">
            {shown === null ? '—' : t('layout.leds', { count: shown.rects.length })}
            {layout.kind === 'classic' && ` · ${t('layout.led0')}`}
          </span>
          <Select
            className="w-44"
            value={layout.kind}
            onChange={(value) => {
              setNotice(null)
              setDraft(value === 'matrix' ? MATRIX_ENGINE_CONFIG as EngineConfig : DEFAULT_ENGINE_CONFIG as EngineConfig)
            }}
          >
            <Label>{t('layout.kind')}</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id="classic" textValue={t('layout.kind.classic')}>
                  {t('layout.kind.classic')}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item id="matrix" textValue={t('layout.kind.matrix')}>
                  {t('layout.kind.matrix')}
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
                <EdgeCount label={t('layout.top')} value={layout.top} onChange={(top) => patchLayout({ top })} />
                <EdgeCount label={t('layout.right')} value={layout.right} onChange={(right) => patchLayout({ right })} />
                <EdgeCount label={t('layout.bottom')} value={layout.bottom} onChange={(bottom) => patchLayout({ bottom })} />
                <EdgeCount label={t('layout.left')} value={layout.left} onChange={(left) => patchLayout({ left })} />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Fraction
                  label={t('layout.depthTopBottom')}
                  maxValue={0.5}
                  value={layout.depthTopBottom}
                  onChange={(depthTopBottom) => patchLayout({ depthTopBottom })}
                />
                <Fraction
                  label={t('layout.depthLeftRight')}
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
                  <Label>{t('layout.start')}</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {CORNERS.map((corner) => (
                        <ListBox.Item id={corner} key={corner} textValue={t(CORNER_KEY[corner])}>
                          {t(CORNER_KEY[corner])}
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
                  <Label>{t('layout.offset')}</Label>
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
                    {t('layout.clockwise')}
                  </Switch.Content>
                </Switch>
              </div>

              <Switch isSelected={advanced} size="sm" onChange={setAdvanced}>
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  {t('layout.advanced')}
                </Switch.Content>
              </Switch>

              {advanced && (
                <div className="flex flex-col gap-4 rounded-xl border border-default/40 p-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Fraction
                      label={t('layout.overlap')}
                      maxValue={1}
                      step={0.01}
                      value={layout.overlap ?? LAYOUT_DEFAULTS.overlap}
                      onChange={(overlap) => patchLayout({ overlap })}
                    />
                    <Fraction
                      label={t('layout.edgeGap')}
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
                      <Label>{t('layout.aspectRatio')}</Label>
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
                      <Label>{t('layout.gapPosition')}</Label>
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
                      <Label>{t('layout.gapLength')}</Label>
                      <NumberField.Group>
                        <NumberField.DecrementButton />
                        <NumberField.Input className="w-14" />
                        <NumberField.IncrementButton />
                      </NumberField.Group>
                    </NumberField>
                  </div>
                  <p className="text-xs text-muted">{t('layout.advancedNote')}</p>
                </div>
              )}
            </>
            )
          : (
            <div className="grid gap-3 sm:grid-cols-2">
              <EdgeCount label={t('layout.columns')} value={layout.columns} onChange={(columns) => patchLayout({ columns })} />
              <EdgeCount label={t('layout.rows')} value={layout.rows} onChange={(rows) => patchLayout({ rows })} />
              <Select
                value={layout.cabling}
                onChange={(value) => patchLayout({ cabling: value as 'snake' | 'parallel' })}
              >
                <Label>{t('layout.cabling')}</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="snake" textValue={t('layout.scan.snake')}>
                      {t('layout.scan.snake')}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    <ListBox.Item id="parallel" textValue={t('layout.scan.parallel')}>
                      {t('layout.scan.parallel')}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  </ListBox>
                </Select.Popover>
              </Select>
              <Select
                value={layout.direction}
                onChange={(value) => patchLayout({ direction: value as 'horizontal' | 'vertical' })}
              >
                <Label>{t('layout.scanDirection')}</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="horizontal" textValue={t('layout.direction.horizontal')}>
                      {t('layout.direction.horizontal')}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    <ListBox.Item id="vertical" textValue={t('layout.direction.vertical')}>
                      {t('layout.direction.vertical')}
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
          <Label>{t('layout.colorOrder')}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {COLOR_ORDERS.map((order) => (
                <ListBox.Item id={order} key={order} textValue={orderLabel(order, standard)}>
                  {orderLabel(order, standard)}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <p className="text-xs text-muted">{t('layout.orderNote')}</p>

        {/*
          How the device is REACHED, above what is put on the wire, because the
          transport decides whether the format question exists at all: WLED has
          its own protocol and no wire format to choose.

          The two network transports are not a convenience. On iOS there is no
          Web Serial, no WebUSB, no WebHID and no Web Bluetooth - all four are
          Chromium-only and Apple requires WebKit - so a frame captured on an
          iPhone has nowhere else to go.
        */}
        <div className="mt-2">
          <h3 className="text-sm font-medium">{t('output.transport.title')}</h3>
          <p className="mt-1 text-xs text-muted">{t('output.transport.description')}</p>
        </div>
        <Select
          className="w-80"
          value={draft.output.transport}
          onChange={(value) => {
            setNotice(null)
            setDraft((current) => ({ ...current, output: switchTransport(current.output, value as OutputTransport) }))
          }}
        >
          <Label>{t('output.transport')}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {OUTPUT_TRANSPORTS.map((transport) => (
                <ListBox.Item id={transport} key={transport} textValue={t(`output.transport.${transport}`)}>
                  {t(`output.transport.${transport}`)}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <p className="text-xs text-muted">{t(`output.transportNote.${draft.output.transport}`)}</p>

        {draft.output.transport !== 'serial' && (
          <>
            <TextField
              className="w-80"
              value={draft.output.host ?? ''}
              variant="secondary"
              onChange={(value) => {
                setNotice(null)
                // Kept as typed, trimmed by the validator. Trimming on every
                // keystroke would make a leading space impossible to delete.
                setDraft((current) => ({ ...current, output: { ...current.output, host: value } }))
              }}
            >
              <Label>{t('output.host')}</Label>
              <Input placeholder={t('output.host.placeholder')} />
            </TextField>
            <p className="text-xs text-muted">
              {t(draft.output.transport === 'wled' ? 'output.host.note.wled' : 'output.host.note.websocket')}
            </p>
          </>
        )}

        {draft.output.transport === 'wled' && (
          <>
            <div className="w-40">
              <EdgeCount
                label={t('output.segment')}
                value={draft.output.segment ?? 0}
                onChange={(value) => {
                  setNotice(null)
                  setDraft((current) => ({ ...current, output: { ...current.output, segment: value } }))
                }}
              />
            </div>
            <p className="text-xs text-muted">{t('output.segment.note')}</p>
            <p className="text-xs text-muted">{t('output.wledFormat')}</p>
          </>
        )}

        {/*
          The wire format sits with the channel order because both describe how
          the DEVICE is spoken to rather than what the screen looks like. Afx is
          ours; the other two are Adalight, which is what HyperSerialESP32,
          HyperSerialWLED and every stock Adalight FastLED sketch already speak -
          the difference between "works with the strip you already own" and
          "reflash your board first".
        */}
        {draft.output.transport !== 'wled' && (
        <>
        <Select
          className="w-80"
          value={draft.output.format}
          onChange={(value) => {
            setNotice(null)
            setDraft((current) => ({
              ...current,
              // The calibration bytes only exist on Awa; carrying them onto
              // another format is refused by the parser, so they are dropped
              // here rather than turned into an error the user cannot act on.
              // Only the format changes: the transport, host and segment belong to
              // the output section too and carrying `{ format }` alone would drop
              // whichever device the user had configured.
              //
              // Awa is the only format that carries the four calibration bytes,
              // so switching away from it drops them rather than sending them
              // where they cannot be read.
              output: value === 'Awa'
                ? { ...current.output, format: 'Awa' }
                : { ...current.output, format: value as WireFormat, calibration: undefined }
            }))
          }}
        >
          <Label>{t('output.format')}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {WIRE_FORMATS.map((format) => (
                <ListBox.Item id={format} key={format} textValue={t(`output.format.${format}`)}>
                  {t(`output.format.${format}`)}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <p className="text-xs text-muted">{t(`output.note.${draft.output.format}`)}</p>
        </>
        )}

        {/*
          An empty address is the expected state the moment a network transport
          is chosen, so it is said as the next thing to do rather than as the
          validator's own sentence about `output.host`.
        */}
        {!resolved.ok && (
          <Surface className="rounded-xl p-3 text-sm text-danger" variant="secondary">
            {hostMissing ? t('output.host.required') : resolved.message}
            {!hostMissing && <span className="block text-xs text-muted">{t('layout.lastDrawable')}</span>}
          </Surface>
        )}
        {notice !== null && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
        )}

        <div className="flex flex-wrap gap-2">
          <Button isDisabled={!resolved.ok || saving} onPress={apply}>
            {t(saving ? 'layout.applying' : 'layout.apply')}
          </Button>
          <Button
            variant="secondary"
            onPress={() => reset((layout.kind === 'matrix' ? MATRIX_ENGINE_CONFIG : DEFAULT_ENGINE_CONFIG) as EngineConfig)}
          >
            {t('layout.reset')}
          </Button>
        </div>
        <p className="text-xs text-muted">{t('layout.applyNote')}</p>
      </Card.Content>
    </Card>
  )
}
