'use client'

import { useCallback, useState } from 'react'
import { Button, Card, Surface } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useEngineConfig } from '#components/EngineConfig'
import { useTranslate } from '#components/Preferences'
import { deriveColorOrder, type SeenChannel } from '#lib/engine/order'
import { WIZARD_COLORS, type PatternKind, type PatternSpec } from '#lib/engine/patterns'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * Calibration: prove the wiring, then find the channel order.
 *
 * Both halves have existed in the engine for a while with nothing to drive
 * them. `deriveColorOrder` was written and tested when the order stage was
 * built and has never once been called by anything a user could reach; the test
 * patterns are the plan's "cheapest risk reduction in the project" and until
 * now only the firmware ran them, at boot, where you cannot ask for one.
 *
 * The wizard's two questions are the whole trick. A WS2812B strip is sold in
 * six channel orders and the packaging almost never says which; Hyperion offers
 * the six names in a dropdown and lets you guess. Light pure red, ask what the
 * strip showed, light pure green, ask again - and the answer is determined, not
 * guessed.
 */

const PATTERNS: Array<{ kind: PatternKind, label: MessageKey, note: MessageKey }> = [
  { kind: 'walk', label: 'cal.pattern.walk', note: 'cal.pattern.walkNote' },
  { kind: 'ramp', label: 'cal.pattern.ramp', note: 'cal.pattern.rampNote' },
  { kind: 'solid', label: 'cal.pattern.white', note: 'cal.pattern.whiteNote' },
  { kind: 'flash', label: 'cal.pattern.flash', note: 'cal.pattern.flashNote' }
]

const ANSWERS: Array<{ channel: SeenChannel, label: MessageKey }> = [
  { channel: 'red', label: 'cal.order.red' },
  { channel: 'green', label: 'cal.order.green' },
  { channel: 'blue', label: 'cal.order.blue' }
]

/** Where the wizard is. `null` for the two answers means "not asked yet". */
interface Wizard {
  step: 'red' | 'green' | 'done'
  sawWhenRed?: SeenChannel
  order?: string
  problem?: string
  saved?: boolean
}

export function CalibrationCard () {
  const t = useTranslate()
  const { probe, host, pageCapable, stats, runPattern, saveConfig, stop: stopEngine } = useEngine()
  const { config, setConfig } = useEngineConfig()
  const [notice, setNotice] = useState<string | null>(null)
  const [wizard, setWizard] = useState<Wizard | null>(null)

  // Either host can drive a test pattern: the pattern path is the engine's,
  // not the extension's.
  const installed = host === 'page' ? pageCapable : probe?.available === true
  const running = stats?.pattern

  const send = useCallback(async (spec: PatternSpec): Promise<void> => {
    const result = await runPattern(spec)
    setNotice(result.error ?? null)
  }, [runPattern])

  const stop = useCallback(async (): Promise<void> => {
    // Black first, then stop: stopping alone leaves the strip holding whatever
    // the last pattern frame was, and a strip stuck on full white after a power
    // test is alarming in a way that is entirely our fault.
    await runPattern({ kind: 'off' })
    await stopEngine()
    setNotice(null)
  }, [runPattern, stopEngine])

  const answer = useCallback((seen: SeenChannel) => {
    setWizard((current) => {
      if (current === null) return current
      if (current.step === 'red') {
        void send({ kind: 'solid', color: WIZARD_COLORS.green })
        return { step: 'green', sawWhenRed: seen }
      }
      const sawWhenRed = current.sawWhenRed
      if (sawWhenRed === undefined) return current
      try {
        return { step: 'done', sawWhenRed, order: deriveColorOrder(sawWhenRed, seen) }
      } catch {
        // The one reachable failure: the same colour for both questions, which
        // cannot be true of any strip. Its own sentence, because "invalid
        // input" would leave the user with no idea what to do differently.
        return { step: 'done', sawWhenRed, problem: t('cal.order.contradiction') }
      }
    })
  }, [send, t])

  const apply = useCallback(async (order: string): Promise<void> => {
    const next = { ...config, colorOrder: { ...config.colorOrder, order: order as never } }
    const failure = await saveConfig(next)
    if (failure !== null) {
      setWizard((current) => (current === null ? current : { ...current, problem: t('cal.order.failed', { reason: failure }) }))
      return
    }
    setConfig(next)
    setWizard((current) => (current === null ? current : { ...current, saved: true }))
    await stop()
  }, [config, setConfig, stop, t])

  if (probe !== null && !installed) {
    return (
      <Card variant="default">
        <Card.Header>
          <Card.Title>{t('nav.calibration')}</Card.Title>
        </Card.Header>
        <Card.Content>
          <p className="text-sm text-muted">{t('cal.needExtension')}</p>
        </Card.Content>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Card variant="default">
        <Card.Header>
          <Card.Title>{t('cal.patterns.title')}</Card.Title>
          <Card.Description>{t('cal.patterns.description')}</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {PATTERNS.map((entry) => (
              <Button
                key={entry.label}
                isDisabled={!installed}
                size="sm"
                variant="secondary"
                onPress={() => { void send({ kind: entry.kind }) }}
              >
                {t(entry.label)}
              </Button>
            ))}
            <Button isDisabled={!installed} size="sm" variant="secondary" onPress={() => { void stop() }}>
              {t('cal.pattern.off')}
            </Button>
          </div>

          {running !== undefined && (
            <Surface className="rounded-xl p-3 text-sm" variant="secondary">
              {t('cal.running', { pattern: running })}
            </Surface>
          )}
          {notice !== null && (
            <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
          )}

          <dl className="flex flex-col gap-2">
            {PATTERNS.map((entry) => (
              <div key={entry.note} className="flex flex-col gap-0.5">
                <dt className="text-sm font-medium">{t(entry.label)}</dt>
                <dd className="text-sm text-muted">{t(entry.note)}</dd>
              </div>
            ))}
          </dl>
        </Card.Content>
      </Card>

      <Card variant="default">
        <Card.Header>
          <Card.Title>{t('cal.order.title')}</Card.Title>
          <Card.Description>{t('cal.order.description')}</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          {wizard === null && (
            <Button
              isDisabled={!installed}
              onPress={() => {
                setNotice(null)
                setWizard({ step: 'red' })
                void send({ kind: 'solid', color: WIZARD_COLORS.red })
              }}
            >
              {t('cal.order.start')}
            </Button>
          )}

          {wizard !== null && wizard.step !== 'done' && (
            <>
              <p className="text-sm">{t(wizard.step === 'red' ? 'cal.order.askRed' : 'cal.order.askGreen')}</p>
              <div className="flex flex-wrap gap-2">
                {ANSWERS.map((entry) => (
                  <Button key={entry.channel} variant="secondary" onPress={() => answer(entry.channel)}>
                    {t(entry.label)}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted">{t('cal.order.dark')}</p>
            </>
          )}

          {wizard?.step === 'done' && (
            <>
              {wizard.problem !== undefined && <p className="text-sm text-danger">{wizard.problem}</p>}
              {wizard.order !== undefined && (
                <p className="text-sm">
                  {t(wizard.saved === true ? 'cal.order.applied' : 'cal.order.result', {
                    order: wizard.order.toUpperCase()
                  })}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {wizard.order !== undefined && wizard.saved !== true && (
                  <Button onPress={() => { void apply(wizard.order as string) }}>
                    {t('cal.order.apply')}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onPress={() => {
                    setWizard({ step: 'red' })
                    void send({ kind: 'solid', color: WIZARD_COLORS.red })
                  }}
                >
                  {t('cal.order.again')}
                </Button>
              </div>
            </>
          )}
        </Card.Content>
      </Card>
    </div>
  )
}
