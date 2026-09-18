'use client'

import { useCallback, useState } from 'react'
import {
  Button,
  Card,
  ColorArea,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  Label,
  ListBox,
  Select,
  Slider,
  Surface
} from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useTranslate } from '#components/Preferences'
import {
  AUDIO_KINDS,
  DEFAULT_DECAY,
  DEFAULT_GAIN,
  GAIN_MAX,
  GAIN_MIN,
  NOISE_FLOOR,
  type AudioKind,
  type AudioSpec
} from '#lib/engine/audio'
import type { AudioInputKind } from '#lib/engine/audio-input'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * Sound on the strip.
 *
 * Two choices that are genuinely different and both worth explaining: which
 * visualiser, and where the sound comes from. The input matters more than it
 * looks - the microphone works in every browser and hears the room, tab audio
 * is clean but Chromium only - so it is a labelled control with its own
 * sentence rather than a hidden default.
 *
 * The heard-level meter is here because a strip is across the room and a user
 * whose visualiser sits dark needs to know whether the engine is hearing
 * anything at all. "Check the input, not the strip" is a sentence this meter
 * saves someone from needing.
 */

const COLOURED: ReadonlySet<AudioKind> = new Set<AudioKind>(['level', 'pulse'])

const INPUTS: AudioInputKind[] = ['microphone', 'display']

const DEFAULT_COLOR = { r: 0, g: 180, b: 255 }

export function AudioCard () {
  const t = useTranslate()
  const { probe, host, pageCapable, stats, runAudio, stop } = useEngine()
  const [kind, setKind] = useState<AudioKind | null>(null)
  const [input, setInput] = useState<AudioInputKind>('microphone')
  const [gain, setGain] = useState(DEFAULT_GAIN)
  const [decay, setDecay] = useState(DEFAULT_DECAY)
  const [brightness, setBrightness] = useState(1)
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [notice, setNotice] = useState<string | null>(null)

  const hosted = host === 'page' ? pageCapable : probe === null || probe.available === true
  const running = stats?.audio

  const spec = useCallback((next: AudioKind, over: Partial<AudioSpec> = {}): AudioSpec => ({
    kind: next,
    gain: over.gain ?? gain,
    decay: over.decay ?? decay,
    brightness: over.brightness ?? brightness,
    ...(COLOURED.has(next) ? { color: over.color ?? color } : {})
  }), [brightness, color, decay, gain])

  const run = useCallback(async (next: AudioKind, over: Partial<AudioSpec> = {}) => {
    setKind(next)
    setNotice(null)
    const result = await runAudio(spec(next, over), input)
    setNotice(result.error ?? null)
  }, [input, runAudio, spec])

  /**
   * Moving a slider retunes a running visualiser rather than waiting for a
   * button. The permission is already granted at that point, so restarting is
   * cheap - and a gain control that does nothing until you press Start is a
   * control nobody can set by ear.
   */
  const retune = useCallback((over: Partial<AudioSpec>) => {
    if (over.gain !== undefined) setGain(over.gain)
    if (over.decay !== undefined) setDecay(over.decay)
    if (over.brightness !== undefined) setBrightness(over.brightness)
    if (over.color !== undefined) setColor(over.color)
    if (kind === null || running === undefined) return
    void runAudio(spec(kind, over), input)
  }, [input, kind, running, runAudio, spec])

  if (!hosted) {
    return (
      <Card variant="default">
        <Card.Header><Card.Title>{t('audio.title')}</Card.Title></Card.Header>
        <Card.Content><p className="text-sm text-muted">{t('audio.needEngine')}</p></Card.Content>
      </Card>
    )
  }

  const level = running?.level ?? 0
  const hearing = level > NOISE_FLOOR * 1.5

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('audio.title')}</Card.Title>
        <Card.Description>{t('audio.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Select
            className="w-80"
            value={input}
            onChange={(value) => {
              setInput(value as AudioInputKind)
              // Not retuned in place: the input is a different stream and a
              // different permission, so it has to be reopened.
              if (kind !== null && running !== undefined) void runAudio(spec(kind), value as AudioInputKind)
            }}
          >
            <Label>{t('audio.input')}</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {INPUTS.map((each) => (
                  <ListBox.Item id={each} key={each} textValue={t(`audio.input.${each}` as MessageKey)}>
                    {t(`audio.input.${each}` as MessageKey)}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <p className="text-xs text-muted">{t(`audio.input.${input}.note` as MessageKey)}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {AUDIO_KINDS.map((each) => {
            const active = running?.kind === each
            return (
              <button
                className={`rounded-xl border p-3 text-left transition ${
                  active
                    ? 'border-primary bg-primary/15 ring-1 ring-primary'
                    : 'border-default/40 hover:border-default'
                }`}
                key={each}
                type="button"
                onClick={() => { void run(each) }}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {t(`audio.kind.${each}` as MessageKey)}
                  {active && <span aria-hidden className="size-2 rounded-full bg-primary" />}
                </span>
                <span className="mt-1 block text-xs text-muted">{t(`audio.kind.${each}.note` as MessageKey)}</span>
              </button>
            )
          })}
        </div>

        {/*
          The meter, because a strip is across the room. A visualiser sitting
          dark while music plays is either a dead input or a dark strip, and
          those need opposite things done about them.
        */}
        {running !== undefined && (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <Label>{t('audio.level')}</Label>
              <span className="font-mono text-xs text-muted">{(level * 100).toFixed(0)}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-default/30">
              <div
                className={`h-full rounded-full transition-all ${hearing ? 'bg-success' : 'bg-default'}`}
                style={{ width: `${Math.min(100, level * 100)}%` }}
              />
            </div>
            <p className="text-xs text-muted">{t('audio.levelNote')}</p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <Slider
            maxValue={GAIN_MAX}
            minValue={GAIN_MIN}
            step={0.1}
            value={gain}
            onChange={(value) => { retune({ gain: value as number }) }}
          >
            <div className="flex items-baseline justify-between">
              <Label>{t('audio.gain')}</Label>
              <span className="font-mono text-xs text-muted">{gain.toFixed(1)}×</span>
            </div>
            <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
          </Slider>

          <Slider
            maxValue={0.5}
            minValue={0.01}
            step={0.01}
            value={decay}
            onChange={(value) => { retune({ decay: value as number }) }}
          >
            <div className="flex items-baseline justify-between">
              <Label>{t('audio.decay')}</Label>
              <span className="font-mono text-xs text-muted">{decay.toFixed(2)}</span>
            </div>
            <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
          </Slider>

          <Slider
            maxValue={1}
            minValue={0.02}
            step={0.01}
            value={brightness}
            onChange={(value) => { retune({ brightness: value as number }) }}
          >
            <div className="flex items-baseline justify-between">
              <Label>{t('audio.brightness')}</Label>
              <span className="font-mono text-xs text-muted">{Math.round(brightness * 100)}%</span>
            </div>
            <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
          </Slider>
        </div>
        <p className="text-xs text-muted">{t('audio.gain.note')}</p>

        {(kind === null || COLOURED.has(kind)) && (
          <div className="flex flex-col gap-2">
            <ColorPicker
              value={`rgb(${color.r}, ${color.g}, ${color.b})`}
              onChange={(value) => {
                const rgb = value.toFormat('rgb')
                retune({
                  color: {
                    r: Math.round(rgb.getChannelValue('red')),
                    g: Math.round(rgb.getChannelValue('green')),
                    b: Math.round(rgb.getChannelValue('blue'))
                  }
                })
              }}
            >
              <ColorPicker.Trigger>
                <ColorSwatch size="lg" />
                <Label>{t('audio.color')}</Label>
              </ColorPicker.Trigger>
              <ColorPicker.Popover className="gap-2">
                <ColorArea
                  aria-label={t('audio.color')}
                  className="max-w-full"
                  colorSpace="hsb"
                  xChannel="saturation"
                  yChannel="brightness"
                >
                  <ColorArea.Thumb />
                </ColorArea>
                <ColorSlider aria-label={t('audio.color')} channel="hue" colorSpace="hsb">
                  <ColorSlider.Track><ColorSlider.Thumb /></ColorSlider.Track>
                </ColorSlider>
              </ColorPicker.Popover>
            </ColorPicker>
            <p className="text-xs text-muted">{t('audio.colorNote')}</p>
          </div>
        )}

        {running !== undefined && (
          <Surface className="flex flex-wrap items-center gap-3 rounded-xl p-3 text-sm" variant="secondary">
            <span>
              {t('audio.running', {
                kind: t(`audio.kind.${running.kind}` as MessageKey),
                input: t(`audio.input.${running.input}` as MessageKey)
              })}
            </span>
            <Button size="sm" variant="secondary" onPress={() => { void stop() }}>{t('audio.stop')}</Button>
          </Surface>
        )}
        {notice !== null && (
          <Surface className="rounded-xl p-3 text-sm text-danger" variant="secondary">
            {t('audio.failed', { reason: notice })}
          </Surface>
        )}

        <p className="text-xs text-muted">{t('audio.permission')}</p>
      </Card.Content>
    </Card>
  )
}
