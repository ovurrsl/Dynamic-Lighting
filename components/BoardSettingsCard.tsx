'use client'

import { useState } from 'react'
import { Button, Card, Label, NumberField, Surface, Switch } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useTranslate } from '#components/Preferences'
import { MAX_BUDGET_MA, MAX_LED_COUNT, MIN_BUDGET_MA } from '#lib/engine/control'

/**
 * The board's own settings.
 *
 * The firmware has kept a LED count, a power budget, an idle brightness and a
 * bench switch in its flash since the control channel existed, and until now
 * the only way to set any of them was a serial terminal and a hand-built TLV.
 * The WiFi card put the board on a network from the panel; this card does the
 * same for the four values that decide whether the strip is the right length
 * and the supply survives a white frame.
 *
 * Only the fields the user touched are sent. The board applies each TLV on its
 * own, so a message with one value leaves the other three exactly as the board
 * has them - and the panel does not yet read the board's reply, so it cannot
 * honestly claim to know what those are. The card says so at the bottom rather
 * than showing a default as if it were a reading.
 */

/** The firmware's compiled-in defaults, quoted from afx_config.h `DeviceConfig`. */
const DEFAULTS = Object.freeze({ ledCount: 108, budgetMa: 1500, idleBrightness: 40, benchOnBoot: true })

type Field = 'ledCount' | 'budgetMa' | 'idleBrightness' | 'benchOnBoot'

export function BoardSettingsCard () {
  const t = useTranslate()
  const { probe, host, stats, sendControl } = useEngine()
  const [ledCount, setLedCount] = useState<number>(DEFAULTS.ledCount)
  const [budgetMa, setBudgetMa] = useState<number>(DEFAULTS.budgetMa)
  const [idleBrightness, setIdleBrightness] = useState<number>(DEFAULTS.idleBrightness)
  const [benchOnBoot, setBenchOnBoot] = useState<boolean>(DEFAULTS.benchOnBoot)
  const [touched, setTouched] = useState<ReadonlySet<Field>>(new Set())
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const touch = (field: Field): void => setTouched((prev) => new Set(prev).add(field))

  // The same rule as the WiFi card: a control frame needs a link that carries
  // our bytes. A WLED has its own settings page and the loopback has no board.
  const mode = stats?.link.mode
  const linkReady = mode === 'port' || mode === 'websocket'

  const ledOk = Number.isInteger(ledCount) && ledCount >= 1 && ledCount <= MAX_LED_COUNT
  const budgetOk = Number.isInteger(budgetMa) && budgetMa >= MIN_BUDGET_MA && budgetMa <= MAX_BUDGET_MA
  const idleOk = Number.isInteger(idleBrightness) && idleBrightness >= 0 && idleBrightness <= 255
  const canSend = !busy && linkReady && touched.size > 0 && ledOk && budgetOk && idleOk

  const run = (request: Parameters<typeof sendControl>[0], sent: string): void => {
    setBusy(true)
    setNotice(null)
    void sendControl(request).then((error) => {
      setBusy(false)
      setNotice(error === null ? sent : t('board.settings.failed', { reason: error }))
      if (error === null && request.kind !== 'bench') setTouched(new Set())
    })
  }

  const apply = (): void => {
    if (touched.size === 0) {
      setNotice(t('board.settings.nothing'))
      return
    }
    run({
      kind: 'device',
      ...(touched.has('ledCount') ? { ledCount } : {}),
      ...(touched.has('budgetMa') ? { budgetMa } : {}),
      ...(touched.has('idleBrightness') ? { idleBrightness } : {}),
      ...(touched.has('benchOnBoot') ? { benchOnBoot } : {})
    }, t('board.settings.sent'))
  }

  const reset = (): void => {
    setLedCount(DEFAULTS.ledCount)
    setBudgetMa(DEFAULTS.budgetMa)
    setIdleBrightness(DEFAULTS.idleBrightness)
    setBenchOnBoot(DEFAULTS.benchOnBoot)
    run({ kind: 'reset' }, t('board.settings.resetSent'))
  }

  // Shown for either host, like the WiFi card: a page driving a board over a
  // socket can reconfigure it just as well as the extension can.
  if (host !== 'page' && probe?.available !== true) return null

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('board.settings.title')}</Card.Title>
        <Card.Description>{t('board.settings.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        {!linkReady && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">
            {t('board.settings.needLink')}
          </Surface>
        )}

        <Count
          label={t('board.settings.ledCount')}
          maxValue={MAX_LED_COUNT}
          minValue={1}
          value={ledCount}
          onChange={(next) => { touch('ledCount'); setLedCount(next) }}
        />
        <p className="text-xs text-muted">{t('board.settings.ledCount.note')}</p>

        <Count
          label={t('board.settings.budget')}
          maxValue={MAX_BUDGET_MA}
          minValue={MIN_BUDGET_MA}
          step={100}
          value={budgetMa}
          onChange={(next) => { touch('budgetMa'); setBudgetMa(next) }}
        />
        <p className="text-xs text-muted">{t('board.settings.budget.note')}</p>

        <Count
          label={t('board.settings.idle')}
          maxValue={255}
          minValue={0}
          value={idleBrightness}
          onChange={(next) => { touch('idleBrightness'); setIdleBrightness(next) }}
        />
        <p className="text-xs text-muted">{t('board.settings.idle.note')}</p>

        <Switch isSelected={benchOnBoot} size="md" onChange={(next) => { touch('benchOnBoot'); setBenchOnBoot(next) }}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            {t('board.settings.benchOnBoot')}
          </Switch.Content>
        </Switch>
        <p className="text-xs text-muted">{t('board.settings.benchOnBoot.note')}</p>

        {notice !== null && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
        )}

        <div className="flex flex-wrap gap-2">
          <Button aria-label={`${t('board.settings.apply')} — ${t('board.settings.title')}`} isDisabled={!canSend} onPress={apply}>
            {t(busy ? 'board.settings.sending' : 'board.settings.apply')}
          </Button>
          <Button isDisabled={busy || !linkReady} variant="secondary" onPress={() => run({ kind: 'bench' }, t('board.settings.benchSent'))}>
            {t('board.settings.bench')}
          </Button>
          <Button isDisabled={busy || !linkReady} variant="tertiary" onPress={reset}>
            {t('board.settings.reset')}
          </Button>
        </div>
        <p className="text-xs text-muted">{t('board.settings.resetNote')}</p>
        <p className="text-xs text-muted">{t('board.settings.note')}</p>
      </Card.Content>
    </Card>
  )
}

function Count ({
  label,
  value,
  minValue,
  maxValue,
  step = 1,
  onChange
}: {
  label: string
  value: number
  minValue: number
  maxValue: number
  step?: number
  onChange: (value: number) => void
}) {
  return (
    <NumberField
      className="w-56"
      maxValue={maxValue}
      minValue={minValue}
      step={step}
      value={value}
      variant="secondary"
      // A cleared input reports NaN; that is a keystroke, not a setting.
      onChange={(next) => { if (Number.isFinite(next)) onChange(next) }}
    >
      <Label>{label}</Label>
      <NumberField.Group>
        <NumberField.DecrementButton />
        <NumberField.Input className="w-20" />
        <NumberField.IncrementButton />
      </NumberField.Group>
    </NumberField>
  )
}
