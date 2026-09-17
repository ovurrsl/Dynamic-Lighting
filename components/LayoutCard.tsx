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

import { useEngine } from '#components/Engine'
import { LedFrame } from '#components/LedFrame'
import { useTranslate } from '#components/Preferences'
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
import { CORNERS, DEPTH_MAX, EDGE_GAP_MAX, LAYOUT_DEFAULTS, NO_KEYSTONE, OVERLAP_MAX, type Corner, type Keystone } from '#lib/engine/layout'
import { COLOR_ORDERS, type ColorOrder } from '#lib/engine/order'
import { formatOverrideList, formatRangeList, parseOverrideList, parseRangeList } from '#lib/engine/ranges'
import { WLED_DEFAULT_GAMMA, WLED_GAMMA_MAX, WLED_GAMMA_MIN } from '#lib/engine/wled'
import { createLiveSampler, PREVIEW_HZ, type LiveFrame, type LiveSampler } from '#lib/live-sampler'
import { CORNER_ORDER, frameAspect, isDefaultKeystone, wireOrderColor } from '#lib/preview'
import type { LedRect } from '#lib/engine/types'
import type { MessageKey } from '#lib/i18n/strings'

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
  minValue = 0,
  onChange
}: {
  label: string
  value: number
  /** An edge may be empty; a matrix axis may not. */
  minValue?: number
  onChange: (value: number) => void
}) {
  return (
    <NumberField
      maxValue={512}
      minValue={minValue}
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
  minValue = 0,
  step = 0.005,
  onChange
}: {
  label: string
  value: number
  maxValue: number
  /** The generator's own bound, so the slider cannot reach a value it refuses. */
  minValue?: number
  step?: number
  onChange: (value: number) => void
}) {
  return (
    <Slider
      maxValue={maxValue}
      minValue={minValue}
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
  const { saveConfig, instances, activeId } = useEngine()
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
  /**
   * The two typed lists, as text while they are being typed.
   *
   * Null means "show the draft's value"; a string is what the user has typed
   * so far, kept even when it does not parse yet - "0-" is on its way to
   * "0-3" and must not be corrected under the cursor. The problem beside it
   * says what is still wrong.
   */
  const [blacklistText, setBlacklistText] = useState<string | null>(null)
  const [blacklistProblem, setBlacklistProblem] = useState<string | null>(null)
  const [overridesText, setOverridesText] = useState<string | null>(null)
  const [overridesProblem, setOverridesProblem] = useState<string | null>(null)
  const resetTypedLists = (): void => {
    setBlacklistText(null)
    setBlacklistProblem(null)
    setOverridesText(null)
    setOverridesProblem(null)
  }
  const [screen, setScreen] = useState<MediaStream | null>(null)
  /**
   * The live sample: one colour per LED, taken from the captured screen by the
   * engine's own modules. Null until a capture is running.
   */
  const [live, setLive] = useState<LiveFrame | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const liveSampler = useRef<LiveSampler | null>(null)

  /**
   * The starting configuration is the ACTIVE STRIP's, taken from the engine
   * rather than from a copy of it.
   *
   * There used to be three sources here - a stored single config, the
   * extension, then the reference rig - and since strips there is one: the
   * strip list, which whichever host owns it has already read from its own
   * storage and validated. Editing a second copy is how an editor ends up
   * applying stale settings over a strip that was changed elsewhere.
   *
   * Re-seeded when the selected strip changes, because otherwise switching to
   * the TV would leave the desk's layout on screen under the TV's name, and
   * pressing Apply would copy one onto the other.
   */
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    if (seeded.current === activeId) return
    const active = instances.find((instance) => instance.id === activeId)
    if (active === undefined) return
    seeded.current = activeId
    setNotice(null)
    setDraft(active.config)
    setBlacklistText(null)
    setBlacklistProblem(null)
    setOverridesText(null)
    setOverridesProblem(null)
    report.current?.(active.config)
  }, [instances, activeId])

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
    setBlacklistText(null)
    setBlacklistProblem(null)
    setOverridesText(null)
    setOverridesProblem(null)
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
    void saveConfig(config).then((result) => {
      setSaving(false)
      if (result.error !== undefined) { setNotice(t('layout.extensionRejected', { reason: result.error })); return }
      report.current?.(config)
      setNotice(result.notStored === undefined
        ? t('layout.applied')
        : t('layout.appliedNotStored', { reason: result.notStored }))
    })
  }, [resolved, saveConfig, t])

  /**
   * Resets the LAYOUT, and only that. The whole configuration used to be
   * replaced with the reference rig's, which silently took the output transport,
   * the host address, the colour order, the capture settings and every other
   * page's values with it - and reported that as applied, though nothing had
   * been sent.
   */
  const reset = useCallback((to: EngineConfig) => {
    setDraft((current) => ({ ...current, layout: to.layout }))
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
              // Only the layout changes shape. The other pages' settings on this
              // strip are not the layout's to discard.
              setDraft((current) => ({
                ...current,
                layout: (value === 'matrix' ? MATRIX_ENGINE_CONFIG : DEFAULT_ENGINE_CONFIG).layout as LayoutConfig
              }))
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
                  maxValue={DEPTH_MAX}
                  minValue={0.005}
                  value={layout.depthTopBottom}
                  onChange={(depthTopBottom) => patchLayout({ depthTopBottom })}
                />
                <Fraction
                  label={t('layout.depthLeftRight')}
                  maxValue={DEPTH_MAX}
                  minValue={0.005}
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
                      maxValue={OVERLAP_MAX}
                      step={0.01}
                      value={layout.overlap ?? LAYOUT_DEFAULTS.overlap}
                      onChange={(overlap) => patchLayout({ overlap })}
                    />
                    <Fraction
                      label={t('layout.edgeGap')}
                      maxValue={EDGE_GAP_MAX}
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
              <EdgeCount label={t('layout.columns')} minValue={1} value={layout.columns} onChange={(columns) => patchLayout({ columns })} />
              <EdgeCount label={t('layout.rows')} minValue={1} value={layout.rows} onChange={(rows) => patchLayout({ rows })} />
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
              {/*
                The frame the wall leaves uncovered on each side, as the
                generator has always accepted it. It was parsed, validated and
                round-trip tested with nothing here to set it.
              */}
              {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                <Fraction
                  key={side}
                  label={t(`layout.matrixGap.${side}`)}
                  maxValue={0.45}
                  value={layout.gap?.[side] ?? 0}
                  onChange={(value) => patchLayout({ gap: { ...(layout.gap ?? {}), [side]: value } })}
                />
              ))}
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
          Two lists the parser has accepted since the layout work - per-LED
          channel-order overrides and the blacklist - typed as text, because
          they are lists a person types rather than sliders they drag. The
          grammar and its error messages are lib/engine/ranges.ts.
        */}
        <TextField
          className="w-full max-w-md"
          value={overridesText ?? formatOverrideList(draft.colorOrder.overrides)}
          variant="secondary"
          onChange={(value) => {
            setNotice(null)
            setOverridesText(value)
            try {
              const overrides = parseOverrideList(value)
              setOverridesProblem(null)
              setDraft((current) => ({
                ...current,
                colorOrder: {
                  ...current.colorOrder,
                  ...(Object.keys(overrides).length === 0 ? { overrides: undefined } : { overrides })
                }
              }))
            } catch (error) {
              setOverridesProblem(error instanceof Error ? error.message : String(error))
            }
          }}
        >
          <Label>{t('layout.overrides')}</Label>
          <Input placeholder="5:grb, 7:brg" />
        </TextField>
        <p className={`text-xs ${overridesProblem !== null ? 'text-warning' : 'text-muted'}`}>
          {overridesProblem ?? t('layout.overrides.note')}
        </p>

        <TextField
          className="w-full max-w-md"
          value={blacklistText ?? formatRangeList(draft.blacklist)}
          variant="secondary"
          onChange={(value) => {
            setNotice(null)
            setBlacklistText(value)
            try {
              const blacklist = parseRangeList(value)
              setBlacklistProblem(null)
              setDraft((current) => ({ ...current, blacklist }))
            } catch (error) {
              setBlacklistProblem(error instanceof Error ? error.message : String(error))
            }
          }}
        >
          <Label>{t('layout.blacklist')}</Label>
          <Input placeholder="0-3, 10, 20-24" />
        </TextField>
        <p className={`text-xs ${blacklistProblem !== null ? 'text-warning' : 'text-muted'}`}>
          {blacklistProblem ?? t('layout.blacklist.note')}
        </p>

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
            <Fraction
              label={t('output.wledGamma')}
              value={draft.output.wledGamma ?? WLED_DEFAULT_GAMMA}
              minValue={WLED_GAMMA_MIN}
              maxValue={WLED_GAMMA_MAX}
              step={0.1}
              onChange={(value) => {
                setNotice(null)
                setDraft((current) => ({ ...current, output: { ...current.output, wledGamma: value } }))
              }}
            />
            <p className="text-xs text-muted">{t('output.wledGamma.note')}</p>
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
              // Afx is dithered by the firmware, so the host dither is dropped
              // on the way there rather than becoming a parser error the user
              // cannot act on - the same handling the calibration bytes get.
              output: value === 'Awa'
                ? { ...current.output, format: 'Awa' }
                : value === 'Ada'
                  ? { ...current.output, format: 'Ada', calibration: undefined }
                  : { ...current.output, format: value as WireFormat, calibration: undefined, dither: undefined }
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

        {/*
          HyperHDR's calibrated frame: Awa's four white-balance bytes, which
          turn the magic into "AwA". Parsed and refused on any other format
          since the encoder work, and until now settable from nowhere. Off by
          default and the note says why: a stock Adalight sketch does not read
          the calibrated frame at all.
        */}
        {draft.output.format === 'Awa' && (
          <Surface className="flex flex-col gap-3 rounded-xl p-3" variant="secondary">
            <Switch
              isSelected={draft.output.calibration !== undefined}
              onChange={(on) => {
                setNotice(null)
                setDraft((current) => ({
                  ...current,
                  output: {
                    ...current.output,
                    calibration: on ? { limit: 255, red: 255, green: 255, blue: 255 } : undefined
                  }
                }))
              }}
            >
              <Switch.Content>
                <Switch.Control><Switch.Thumb /></Switch.Control>
                {t('output.calibration')}
              </Switch.Content>
            </Switch>
            <p className="text-xs text-muted">{t('output.calibration.note')}</p>
            {draft.output.calibration !== undefined && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(['limit', 'red', 'green', 'blue'] as const).map((channel) => (
                  <NumberField
                    key={channel}
                    maxValue={255}
                    minValue={0}
                    value={draft.output.calibration?.[channel] ?? 255}
                    variant="secondary"
                    onChange={(value) => {
                      if (!Number.isFinite(value)) return
                      setDraft((current) => current.output.calibration === undefined
                        ? current
                        : {
                            ...current,
                            output: { ...current.output, calibration: { ...current.output.calibration, [channel]: value } }
                          })
                    }}
                  >
                    <Label>{t(`output.calibration.${channel}`)}</Label>
                    <NumberField.Group>
                      <NumberField.DecrementButton />
                      <NumberField.Input className="w-14" />
                      <NumberField.IncrementButton />
                    </NumberField.Group>
                  </NumberField>
                ))}
              </div>
            )}
          </Surface>
        )}

        {/*
          Only on the two 8-bit formats, because that is the only place it does
          anything: Afx carries 16-bit and the firmware sigma-deltas it on the
          strip's own refresh. Showing a disabled switch under Afx would invite
          the reading that ours is the format without dithering, which is the
          opposite of true.
        */}
        {draft.output.format !== 'Afx' && (
          <Surface className="flex flex-col gap-2 rounded-xl p-3" variant="secondary">
            <Switch
              isSelected={draft.output.dither === true}
              onChange={(dither) => {
                setNotice(null)
                setDraft((current) => ({
                  ...current,
                  output: { ...current.output, dither: dither ? true : undefined }
                }))
              }}
            >
              <Switch.Content>
                <Switch.Control><Switch.Thumb /></Switch.Control>
                {t('output.dither')}
              </Switch.Content>
            </Switch>
            <p className="text-xs text-muted">{t('output.dither.note')}</p>
            <p className="text-xs text-muted">{t('output.dither.rate')}</p>
          </Surface>
        )}
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
          <Button aria-label={`${t('layout.apply')} — ${t('layout.title')}`} isDisabled={!resolved.ok || saving} onPress={apply}>
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
