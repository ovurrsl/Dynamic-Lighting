'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Input, Label, ListBox, Select, Surface, Switch, TextField } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useTranslate } from '#components/Preferences'
import { EFFECT_KINDS, type EffectKind } from '#lib/engine/effects'
import {
  ACTION_KINDS,
  formatMinute,
  parseMinute,
  type ScheduleAction,
  type ScheduleRule
} from '#lib/engine/schedule'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * Time-of-day rules.
 *
 * The rules are edited here and kept by the ENGINE. That is not an
 * implementation detail the user should have to know, but it is why the page
 * has a Save button rather than applying as you type: a half-typed time must
 * not reach a rule that fires with nobody watching.
 *
 * Two sentences on the page are limitations rather than instructions, and both
 * are the kind a user would otherwise discover at 8 a.m. on a Monday: a timer
 * cannot open a screen picker in a page (no user gesture, and that is the
 * browser's rule), and a machine that slept through several rules gets only the
 * last one.
 */

const ACTION_KEY: Record<ScheduleAction['kind'], MessageKey> = {
  stop: 'schedule.action.stop',
  capture: 'schedule.action.capture',
  effect: 'schedule.action.effect',
  color: 'schedule.action.color'
}

const DAY_KEYS: MessageKey[] = [
  'schedule.day.0', 'schedule.day.1', 'schedule.day.2', 'schedule.day.3',
  'schedule.day.4', 'schedule.day.5', 'schedule.day.6'
]

/**
 * "Every strip" as a value a dropdown can hold.
 *
 * A rule with no `instanceId` applies everywhere, and `undefined` is not
 * something a select can carry - so it is spelled here, once, rather than in
 * each of the four places that would otherwise invent their own sentinel.
 */
const ALL_STRIPS = '*'

/** A local draft: the time is text while it is being typed, not a number. */
interface Draft {
  id: string
  enabled: boolean
  time: string
  days: number[]
  action: ScheduleAction
  /** `ALL_STRIPS`, or one strip's id. */
  instanceId: string
}

const toDraft = (rule: ScheduleRule): Draft => ({
  id: rule.id,
  enabled: rule.enabled,
  time: formatMinute(rule.atMinute),
  days: [...rule.days],
  action: rule.action,
  instanceId: rule.instanceId ?? ALL_STRIPS
})

let nextId = 0

export function ScheduleCard () {
  const t = useTranslate()
  const { probe, host, pageCapable, schedule, saveSchedule, instances } = useEngine()
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Loaded once from the engine; after that the page owns the draft, or every
  // poll would throw away whatever is half-edited.
  useEffect(() => {
    if (schedule !== null && drafts === null) setDrafts(schedule.map(toDraft))
  }, [schedule, drafts])

  const hosted = host === 'page' ? pageCapable : probe === null || probe.available === true

  const patch = useCallback((id: string, over: Partial<Draft>) => {
    setNotice(null)
    setDrafts((current) => (current ?? []).map((d) => (d.id === id ? { ...d, ...over } : d)))
  }, [])

  const save = useCallback(async () => {
    setSaving(true)
    setNotice(null)
    try {
      const rules: ScheduleRule[] = (drafts ?? []).map((d) => ({
        id: d.id,
        enabled: d.enabled,
        atMinute: parseMinute(d.time),
        days: d.days,
        action: d.action,
        // Dropped rather than sent as the sentinel: "applies everywhere" is the
        // ABSENCE of a strip, and storing a magic string for it would put a
        // strip called "*" one typo away from being addressable.
        ...(d.instanceId === ALL_STRIPS ? {} : { instanceId: d.instanceId })
      }))
      const result = await saveSchedule(rules)
      setNotice(
        result.error !== undefined
          ? t('schedule.failed', { reason: result.error })
          : result.notStored !== undefined
            ? t('schedule.notStored', { reason: result.notStored })
            : t('schedule.saved')
      )
    } catch (error) {
      setNotice(t('schedule.failed', { reason: error instanceof Error ? error.message : String(error) }))
    } finally {
      setSaving(false)
    }
  }, [drafts, saveSchedule, t])

  if (!hosted) {
    return (
      <Card variant="default">
        <Card.Header><Card.Title>{t('schedule.title')}</Card.Title></Card.Header>
        <Card.Content><p className="text-sm text-muted">{t('schedule.needEngine')}</p></Card.Content>
      </Card>
    )
  }

  const list = drafts ?? []

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('schedule.title')}</Card.Title>
        <Card.Description>{t('schedule.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-5">
        {list.length === 0 && <p className="text-sm text-muted">{t('schedule.empty')}</p>}

        {list.map((draft) => (
          <Surface className="flex flex-col gap-3 rounded-xl p-3" key={draft.id} variant="secondary">
            <div className="flex flex-wrap items-end gap-3">
              <TextField
                className="w-28"
                value={draft.time}
                variant="secondary"
                onChange={(value) => { patch(draft.id, { time: value }) }}
              >
                <Label>{t('schedule.time')}</Label>
                <Input placeholder="22:00" />
              </TextField>

              <Select
                className="w-64"
                value={draft.action.kind}
                onChange={(value) => {
                  const kind = value as ScheduleAction['kind']
                  patch(draft.id, { action: defaultAction(kind, draft.action) })
                }}
              >
                <Label>{t('schedule.action')}</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {ACTION_KINDS.map((kind) => (
                      <ListBox.Item id={kind} key={kind} textValue={t(ACTION_KEY[kind])}>
                        {t(ACTION_KEY[kind])}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>

              {draft.action.kind === 'effect' && (
                <Select
                  className="w-52"
                  value={draft.action.spec.kind}
                  onChange={(value) => {
                    patch(draft.id, { action: { kind: 'effect', spec: { kind: value as EffectKind } } })
                  }}
                >
                  <Label>{t('schedule.effect')}</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {EFFECT_KINDS.map((kind) => (
                        <ListBox.Item id={kind} key={kind} textValue={t(`effects.kind.${kind}` as MessageKey)}>
                          {t(`effects.kind.${kind}` as MessageKey)}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              )}

              {draft.action.kind === 'color' && (
                <TextField
                  className="w-32"
                  value={hex(draft.action.color)}
                  variant="secondary"
                  onChange={(value) => {
                    const parsed = fromHex(value)
                    if (parsed !== null) patch(draft.id, { action: { kind: 'color', color: parsed } })
                  }}
                >
                  <Label>{t('schedule.color')}</Label>
                  <Input placeholder="#ffb43c" />
                </TextField>
              )}

              {/*
                Only with more than one strip. A dropdown whose every option but
                one is "all strips" is a control that cannot be used, and every
                installation starts with one strip.
              */}
              {instances.length > 1 && (
                <Select
                  className="w-44"
                  value={draft.instanceId}
                  onChange={(value) => { patch(draft.id, { instanceId: String(value) }) }}
                >
                  <Label>{t('schedule.strip')}</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id={ALL_STRIPS} textValue={t('schedule.strip.all')}>
                        {t('schedule.strip.all')}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      {instances.map((instance) => (
                        <ListBox.Item id={instance.id} key={instance.id} textValue={instance.name}>
                          {instance.name}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              )}

              <Switch
                isSelected={draft.enabled}
                size="sm"
                onChange={(enabled) => { patch(draft.id, { enabled }) }}
              >
                <Switch.Content>
                  <Switch.Control><Switch.Thumb /></Switch.Control>
                  {t('schedule.enabled')}
                </Switch.Content>
              </Switch>

              <Button
                className="ml-auto"
                size="sm"
                variant="secondary"
                onPress={() => { setDrafts((c) => (c ?? []).filter((d) => d.id !== draft.id)) }}
              >
                {t('schedule.remove')}
              </Button>
            </div>

            {/*
              Days as toggles rather than a multi-select: "weekdays only" is the
              common case and picking five entries out of a dropdown for it is
              five clicks and a scroll.
            */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">{t('schedule.days')}</span>
              {DAY_KEYS.map((key, day) => {
                const on = draft.days.includes(day)
                return (
                  <button
                    className={`rounded-full border px-2 py-0.5 text-xs transition ${
                      on ? 'border-primary bg-primary/15' : 'border-default/40 text-muted hover:border-default'
                    }`}
                    key={key}
                    type="button"
                    onClick={() => {
                      patch(draft.id, {
                        days: on ? draft.days.filter((d) => d !== day) : [...draft.days, day].sort((a, b) => a - b)
                      })
                    }}
                  >
                    {t(key)}
                  </button>
                )
              })}
              {draft.days.length === 0 && (
                <span className="text-xs text-muted">· {t('schedule.days.every')}</span>
              )}
            </div>
          </Surface>
        ))}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onPress={() => {
              setDrafts((c) => [...(c ?? []), {
                id: `new-${nextId++}`,
                enabled: true,
                time: '22:00',
                days: [],
                action: { kind: 'stop' },
                instanceId: ALL_STRIPS
              }])
            }}
          >
            {t('schedule.add')}
          </Button>
          <Button isDisabled={saving} onPress={() => { void save() }}>
            {t(saving ? 'schedule.saving' : 'schedule.save')}
          </Button>
        </div>

        {notice !== null && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
        )}

        <p className="text-xs text-muted">{t('schedule.captureNote')}</p>
        <p className="text-xs text-muted">{t('schedule.asleepNote')}</p>
      </Card.Content>
    </Card>
  )
}

/** Keeps whatever the previous action carried, so switching back is not a reset. */
function defaultAction (kind: ScheduleAction['kind'], previous: ScheduleAction): ScheduleAction {
  switch (kind) {
    case 'stop': return { kind: 'stop' }
    case 'capture': return { kind: 'capture' }
    case 'effect':
      return previous.kind === 'effect' ? previous : { kind: 'effect', spec: { kind: 'candle' } }
    default:
      return previous.kind === 'color' ? previous : { kind: 'color', color: { r: 255, g: 180, b: 60 } }
  }
}

const hex = (color: { r: number, g: number, b: number }): string =>
  `#${[color.r, color.g, color.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

function fromHex (text: string): { r: number, g: number, b: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(text.trim())
  if (match === null) return null
  const value = Number.parseInt(match[1] as string, 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}
