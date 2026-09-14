'use client'

import { useCallback, useState } from 'react'
import { Button, Card, Surface } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useEngineConfig } from '#components/EngineConfig'
import { useTranslate } from '#components/Preferences'
import { CORNERS, type Corner } from '#lib/engine/layout'
import { layoutFromCorners, stepWalk, type CalibratedLayout } from '#lib/engine/calibrate'
import { configLedCount } from '#lib/engine/config'
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

/** The same four names the layout editor uses, because they are the same four corners. */
const CORNER_KEY: Record<Corner, MessageKey> = {
  'top-left': 'layout.corner.topLeft',
  'top-right': 'layout.corner.topRight',
  'bottom-right': 'layout.corner.bottomRight',
  'bottom-left': 'layout.corner.bottomLeft'
}

/**
 * The layout wizard's state.
 *
 * The two orientation questions come LAST, after the walk, and that is the
 * whole reason this is usable: asked first, "which way does it run clockwise"
 * is a question about a strip the user has not watched yet, and clockwise seen
 * from the front is the opposite of how it looks from behind the monitor where
 * the strip is. Asked after four corners have gone by, they know.
 */
interface Walk {
  step: 'mark' | 'corner' | 'direction' | 'done'
  /** Which LED is lit. */
  at: number
  /** The corners marked so far, in the order the light reached them. */
  marks: number[]
  firstCorner?: Corner
  layout?: CalibratedLayout
  problem?: string
  saved?: boolean
}

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
  const [walk, setWalk] = useState<Walk | null>(null)

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
    if (failure.error !== undefined) {
      setWizard((current) => (current === null ? current : { ...current, problem: t('cal.order.failed', { reason: failure.error as string }) }))
      return
    }
    setConfig(next)
    setWizard((current) => (current === null ? current : { ...current, saved: true }))
    await stop()
  }, [config, setConfig, stop, t])

  // -------------------------------------------------------------------------
  // The layout wizard.
  // -------------------------------------------------------------------------

  const total = configLedCount(config)

  /** Lights one LED and remembers which, so the marks mean something. */
  const light = useCallback((at: number) => {
    setWalk((current) => (current === null ? current : { ...current, at }))
    void send({ kind: 'single', index: at })
  }, [send])

  const move = useCallback((by: number) => {
    setWalk((current) => {
      if (current === null) return current
      const at = stepWalk(current.at, by, total)
      void send({ kind: 'single', index: at })
      return { ...current, at }
    })
  }, [send, total])

  /**
   * Marks the lit LED as the first one of a new edge.
   *
   * Four marks and the walk is over; the orientation questions follow. The
   * light is left where it is rather than jumped anywhere, because the user is
   * about to answer a question about what they just watched.
   */
  const mark = useCallback(() => {
    setWalk((current) => {
      if (current === null) return current
      const marks = [...current.marks, current.at]
      return marks.length < 4
        ? { ...current, marks }
        : { ...current, marks, step: 'corner' }
    })
  }, [])

  const answerCorner = useCallback((corner: Corner) => {
    setWalk((current) => (current === null ? current : { ...current, firstCorner: corner, step: 'direction' }))
  }, [])

  const answerDirection = useCallback((clockwise: boolean) => {
    setWalk((current) => {
      if (current === null || current.firstCorner === undefined) return current
      try {
        const layout = layoutFromCorners({
          indices: current.marks,
          firstCorner: current.firstCorner,
          clockwise,
          total
        })
        return { ...current, step: 'done', layout }
      } catch (error) {
        // The marks did not partition the strip: pressed out of order, or one
        // was missed. Said here rather than applied, because a layout wrong in
        // this way is not noticed until the strip is on the wall.
        return {
          ...current,
          step: 'done',
          problem: error instanceof Error ? error.message : String(error)
        }
      }
    })
  }, [total])

  const applyLayout = useCallback(async (layout: CalibratedLayout): Promise<void> => {
    const next = {
      ...config,
      layout: { ...config.layout, ...layout }
    }
    const failure = await saveConfig(next)
    if (failure.error !== undefined) {
      setWalk((current) => (current === null ? current : { ...current, problem: failure.error as string }))
      return
    }
    setConfig(next)
    setWalk((current) => (current === null ? current : { ...current, saved: true }))
    await stop()
  }, [config, saveConfig, setConfig, stop])

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
          <Card.Title>{t('cal.walk.title')}</Card.Title>
          <Card.Description>{t('cal.walk.description')}</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          {walk === null && (
            <>
              <Button
                isDisabled={!installed}
                onPress={() => {
                  setNotice(null)
                  setWalk({ step: 'mark', at: 0, marks: [] })
                  void send({ kind: 'single', index: 0 })
                }}
              >
                {t('cal.walk.start')}
              </Button>
              <p className="text-xs text-muted">{t('cal.walk.why')}</p>
            </>
          )}

          {walk?.step === 'mark' && (
            <>
              <p className="text-sm">{t('cal.walk.instruction')}</p>
              <Surface className="flex flex-wrap items-center gap-3 rounded-xl p-3" variant="secondary">
                <span className="font-mono text-sm">{t('cal.walk.at', { at: walk.at, total })}</span>
                <div className="ml-auto flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onPress={() => { move(-10) }}>−10</Button>
                  <Button size="sm" variant="secondary" onPress={() => { move(-1) }}>−1</Button>
                  <Button size="sm" variant="secondary" onPress={() => { move(1) }}>+1</Button>
                  <Button size="sm" variant="secondary" onPress={() => { move(10) }}>+10</Button>
                </div>
              </Surface>
              <div className="flex flex-wrap items-center gap-3">
                <Button onPress={mark}>{t('cal.walk.mark', { n: walk.marks.length + 1 })}</Button>
                {walk.marks.length > 0 && (
                  <>
                    <span className="font-mono text-xs text-muted">{walk.marks.join(' · ')}</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => {
                        // Undo rather than restart: three corners marked and a
                        // slip on the fourth should not mean walking it again.
                        setWalk((current) => (current === null ? current : { ...current, marks: current.marks.slice(0, -1) }))
                      }}
                    >
                      {t('cal.walk.undo')}
                    </Button>
                  </>
                )}
                <Button className="ml-auto" size="sm" variant="secondary" onPress={() => { setWalk(null); void stop() }}>
                  {t('cal.walk.cancel')}
                </Button>
              </div>
              <p className="text-xs text-muted">{t('cal.walk.markNote')}</p>
            </>
          )}

          {walk?.step === 'corner' && (
            <>
              <p className="text-sm">{t('cal.walk.askCorner')}</p>
              <div className="flex flex-wrap gap-2">
                {CORNERS.map((corner) => (
                  <Button key={corner} variant="secondary" onPress={() => { answerCorner(corner) }}>
                    {t(CORNER_KEY[corner])}
                  </Button>
                ))}
              </div>
            </>
          )}

          {walk?.step === 'direction' && (
            <>
              <p className="text-sm">{t('cal.walk.askDirection')}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onPress={() => { answerDirection(true) }}>{t('cal.walk.clockwise')}</Button>
                <Button variant="secondary" onPress={() => { answerDirection(false) }}>{t('cal.walk.anticlockwise')}</Button>
              </div>
              <p className="text-xs text-muted">{t('cal.walk.directionNote')}</p>
            </>
          )}

          {walk?.step === 'done' && (
            <>
              {walk.problem !== undefined && <p className="text-sm text-danger">{walk.problem}</p>}
              {walk.layout !== undefined && (
                <Surface className="flex flex-col gap-1 rounded-xl p-3 text-sm" variant="secondary">
                  <span>{t('cal.walk.result', {
                    top: walk.layout.top,
                    right: walk.layout.right,
                    bottom: walk.layout.bottom,
                    left: walk.layout.left
                  })}</span>
                  {/*
                    A strip whose LED 0 sits on the corner is the common case,
                    and "LED 0 is 0 along" reads like a bug rather than like the
                    tidiest possible answer.
                  */}
                  <span className="text-xs text-muted">{t(
                    walk.layout.offset === 0 ? 'cal.walk.resultStartFlush' : 'cal.walk.resultStart',
                    {
                      corner: t(CORNER_KEY[walk.layout.start]),
                      direction: t(walk.layout.clockwise ? 'cal.walk.clockwise' : 'cal.walk.anticlockwise'),
                      offset: walk.layout.offset
                    }
                  )}</span>
                </Surface>
              )}
              {walk.saved === true && <p className="text-sm">{t('cal.walk.applied')}</p>}
              <div className="flex flex-wrap gap-2">
                {walk.layout !== undefined && walk.saved !== true && (
                  <Button onPress={() => { void applyLayout(walk.layout as CalibratedLayout) }}>
                    {t('cal.walk.apply')}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onPress={() => {
                    setWalk({ step: 'mark', at: 0, marks: [] })
                    void send({ kind: 'single', index: 0 })
                  }}
                >
                  {t('cal.walk.again')}
                </Button>
              </div>
            </>
          )}
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
