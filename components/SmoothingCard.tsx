'use client'

import { useCallback, useMemo, useState } from 'react'
import { Button, Card, Label, Slider, Surface, Switch } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useEngineConfig } from '#components/EngineConfig'
import { useTranslate } from '#components/Preferences'
import { SMOOTHING_MS_MIN, type SmoothingConfig } from '#lib/engine/config'
import { SMOOTHING_PROFILES, SMOOTHING_PROFILE_NAMES, profileOf, type SmoothingProfileName } from '#lib/engine/smooth'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * How hard the strip is smoothed.
 *
 * These were the smoother's own defaults until now - good numbers, compiled in.
 * The reason they become a setting is not that they were wrong but that the
 * right answer depends on what is on screen rather than on taste: a film is
 * 24 fps of deliberate cuts, a game is continuous motion you are reacting to,
 * and what flatters one is wrong for the other.
 *
 * Three named profiles first, the two numbers underneath. The profile NAME is
 * derived from the numbers rather than stored beside them, so touching either
 * slider says "custom" without anything having to remember to - and a saved
 * configuration can never claim to be Balanced while holding Cinema's numbers.
 *
 * The asymmetry is worth a sentence on the page, because it is the thing that
 * makes this different from Hyperion's single constant: the eye reads
 * BRIGHTENING as response and DARKENING as noise, so the two directions want
 * different answers and one number cannot give both.
 */

const PROFILE_KEY: Record<SmoothingProfileName, MessageKey> = {
  cinema: 'smoothing.profile.cinema',
  balanced: 'smoothing.profile.balanced',
  competitive: 'smoothing.profile.competitive'
}

const PROFILE_NOTE: Record<SmoothingProfileName, MessageKey> = {
  cinema: 'smoothing.profile.cinema.note',
  balanced: 'smoothing.profile.balanced.note',
  competitive: 'smoothing.profile.competitive.note'
}

/** The bypass is off at exactly 1; see the note in lib/engine/config.ts. */
const CUT_OFF = 1
const CUT_ON = 0.25

/**
 * The sliders are squared, not linear, and this is a measurement rather than a
 * preference.
 *
 * Every value anyone actually wants lives in the bottom tenth of the range the
 * configuration allows: the three profiles use 6, 15 and 40 ms for the rise. On
 * a linear track to 2000 ms those three sit within nine pixels of each other,
 * so the control cannot express the difference between the profiles it ships
 * with. Squaring the position spreads them across a third of the track while
 * still reaching the slow end for anyone who wants it.
 *
 * The track is in POSITION units and the value is always derived from the
 * milliseconds, never the other way round - so selecting a profile puts the
 * thumb exactly where that profile's number is, rather than at the nearest
 * position the slider happens to quantise to.
 */
const POSITIONS = 1000
const ATTACK_MAX_MS = 400
const RELEASE_MAX_MS = 1200

const toPosition = (ms: number, maxMs: number): number =>
  Math.round(POSITIONS * Math.sqrt(Math.min(ms, maxMs) / maxMs))

const toMs = (position: number, maxMs: number): number =>
  Math.round(maxMs * (position / POSITIONS) ** 2)

/**
 * One slider step, guaranteed to be worth at least a millisecond.
 *
 * At the fast end the curve is shallow enough that a single position is worth
 * less than 1 ms and rounds to the value already shown - so the smallest step
 * a keyboard can make would do nothing at all, on exactly the settings where
 * a millisecond matters most. Nudging by one in the direction of travel is the
 * fix; a drag moves many positions at once and never reaches this.
 */
function stepped (from: number, position: number, maxMs: number): number {
  // Never below the parser's floor: the track's left end is position 0, which
  // is 0 ms, which the engine refuses.
  const next = Math.max(SMOOTHING_MS_MIN, toMs(position, maxMs))
  if (next !== from) return next
  return position > toPosition(from, maxMs) ? Math.min(from + 1, maxMs) : Math.max(SMOOTHING_MS_MIN, from - 1)
}

export function SmoothingCard () {
  const t = useTranslate()
  const { probe, host, pageCapable, saveConfig } = useEngine()
  const { config, setConfig } = useEngineConfig()
  const [draft, setDraft] = useState<SmoothingConfig | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const current = draft ?? config.smoothing
  const profile = useMemo(() => profileOf(current), [current])

  const patch = useCallback((over: Partial<SmoothingConfig>) => {
    setNotice(null)
    setDraft((value) => ({ ...(value ?? config.smoothing), ...over }))
  }, [config.smoothing])

  const apply = useCallback(() => {
    setSaving(true)
    const next = { ...config, smoothing: current }
    void saveConfig(next).then((result) => {
      setSaving(false)
      if (result.error !== undefined) { setNotice(t('smoothing.failed', { reason: result.error })); return }
      setConfig(next)
      setDraft(null)
      setNotice(result.notStored === undefined
        ? t('smoothing.applied')
        : t('layout.appliedNotStored', { reason: result.notStored }))
    })
  }, [config, current, saveConfig, setConfig, t])

  const hosted = host === 'page' ? pageCapable : probe === null || probe.available === true
  if (!hosted) {
    return (
      <Card variant="default">
        <Card.Header><Card.Title>{t('smoothing.title')}</Card.Title></Card.Header>
        <Card.Content><p className="text-sm text-muted">{t('smoothing.needEngine')}</p></Card.Content>
      </Card>
    )
  }

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('smoothing.title')}</Card.Title>
        <Card.Description>{t('smoothing.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted">{t('smoothing.profile')}</span>
          <div className="flex flex-wrap gap-2">
            {SMOOTHING_PROFILE_NAMES.map((name) => {
              const on = profile === name
              return (
                <button
                  key={name}
                  aria-pressed={on}
                  className={`rounded-xl border px-3 py-2 text-left text-sm transition ${
                    on ? 'border-primary bg-primary/15' : 'border-default/40 hover:border-default'
                  }`}
                  type="button"
                  onClick={() => { patch({ ...SMOOTHING_PROFILES[name] }) }}
                >
                  <span className="block font-medium">{t(PROFILE_KEY[name])}</span>
                  <span className="block text-xs text-muted">{t(PROFILE_NOTE[name])}</span>
                </button>
              )
            })}
          </div>
          {profile === null && <p className="text-xs text-muted">{t('smoothing.profile.custom')}</p>}
        </div>

        <Slider
          maxValue={POSITIONS}
          minValue={0}
          step={1}
          value={toPosition(current.attackMs, ATTACK_MAX_MS)}
          onChange={(value) => { patch({ attackMs: stepped(current.attackMs, Number(value), ATTACK_MAX_MS) }) }}
        >
          <Label>{t('smoothing.attack')}</Label>
          <Slider.Output>{`${current.attackMs} ms`}</Slider.Output>
          <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
        </Slider>
        <p className="-mt-4 text-xs text-muted">{t('smoothing.attack.note')}</p>

        <Slider
          maxValue={POSITIONS}
          minValue={0}
          step={1}
          value={toPosition(current.releaseMs, RELEASE_MAX_MS)}
          onChange={(value) => { patch({ releaseMs: stepped(current.releaseMs, Number(value), RELEASE_MAX_MS) }) }}
        >
          <Label>{t('smoothing.release')}</Label>
          <Slider.Output>{`${current.releaseMs} ms`}</Slider.Output>
          <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
        </Slider>
        <p className="-mt-4 text-xs text-muted">{t('smoothing.release.note')}</p>

        <div className="flex flex-col gap-2">
          <Switch
            isSelected={current.cutThreshold < CUT_OFF}
            onChange={(on) => { patch({ cutThreshold: on ? CUT_ON : CUT_OFF }) }}
          >
            <Switch.Content>
              <Switch.Control><Switch.Thumb /></Switch.Control>
              {t('smoothing.cut')}
            </Switch.Content>
          </Switch>
          <p className="text-xs text-muted">{t('smoothing.cut.note')}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button isDisabled={saving} onPress={apply}>
            {t(saving ? 'smoothing.applying' : 'smoothing.apply')}
          </Button>
          <Button
            variant="secondary"
            onPress={() => { patch({ ...SMOOTHING_PROFILES.balanced }) }}
          >
            {t('smoothing.reset')}
          </Button>
        </div>

        {notice !== null && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
        )}

        <p className="text-xs text-muted">{t('smoothing.asymmetryNote')}</p>
      </Card.Content>
    </Card>
  )
}
