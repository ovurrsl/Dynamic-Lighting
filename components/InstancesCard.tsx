'use client'

import { useCallback, useState } from 'react'
import { Button, Card, Input, Label, Surface, Switch, TextField } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useEngineText, useTranslate } from '#components/Preferences'
import { configLedCount } from '#lib/engine/config'
import {
  MAX_INSTANCES,
  addInstance,
  removeInstance,
  updateInstance,
  type Instance
} from '#lib/engine/instances'

/**
 * The strips this installation drives.
 *
 * One page, because a second strip changes the meaning of every other page: the
 * layout, the capture settings, the board's network and the colour controls all
 * belong to ONE strip from here on, and there has to be somewhere that says
 * which. Selecting a strip here is what every other page then edits, and the
 * sidebar repeats the choice so it is never more than a glance away.
 *
 * The thing worth saying on the page, because it is the question anyone with
 * two strips asks first: **they share one screen capture.** Two strips do not
 * mean two pickers. Strips reading different sources - one on the screen, one
 * on an HDMI capture card - do get one capture each, and that arrangement is
 * the only thing that beats DRM blanking.
 */
export function InstancesCard () {
  const t = useTranslate()
  const tx = useEngineText()
  const { instances, activeId, setActiveId, saveInstances, pool, storageProblem } = useEngine()
  const [draft, setDraft] = useState<Instance[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  /**
   * The live list until somebody edits, and the draft from then on.
   *
   * Deliberately NOT seeded once on mount. The list arrives asynchronously -
   * from the worker, or from this browser's storage after the first paint - and
   * a card that copied it at mount would freeze the one-strip default that is
   * on screen for those few milliseconds, which is exactly what a reload looked
   * like: two strips saved, one strip shown.
   */
  const list = draft ?? instances

  const patch = useCallback((id: string, change: Partial<Omit<Instance, 'id'>>) => {
    setNotice(null)
    setDraft((current) => updateInstance(current ?? instances, id, change))
  }, [instances])

  const save = useCallback(async () => {
    setSaving(true)
    setNotice(null)
    try {
      const result = await saveInstances(list)
      // Back to following the live list: the host trims names and may reorder,
      // and the card should show what is actually running rather than what was
      // typed at it.
      if (result.error === undefined) setDraft(null)
      setNotice(
        result.error !== undefined
          ? t('strips.failed', { reason: result.error })
          : result.notStored !== undefined
            ? t('strips.notStored', { reason: result.notStored })
            : t('strips.saved')
      )
    } catch (error) {
      setNotice(t('strips.failed', { reason: error instanceof Error ? error.message : String(error) }))
    } finally {
      setSaving(false)
    }
  }, [list, saveInstances, t])

  const report = (id: string) => pool?.instances.find((instance) => instance.id === id)

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('strips.title')}</Card.Title>
        <Card.Description>{t('strips.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-5">
        {/*
          Said BEFORE the list, because the list below is the fallback and
          the next Save writes it over the stored one. Both hosts substitute
          the reference rig for a stored list they cannot read; neither used
          to say so.
        */}
        {storageProblem !== null && (
          <Surface className="rounded-xl p-3 text-sm text-warning" variant="secondary">
            {t('strips.storageProblem', { reason: storageProblem })}
          </Surface>
        )}

        {list.map((instance, index) => {
          const live = report(instance.id)
          const selected = instance.id === activeId
          return (
            <Surface
              className={`flex flex-col gap-3 rounded-xl p-3 ${selected ? 'ring-1 ring-primary' : ''}`}
              key={instance.id}
              variant="secondary"
            >
              <div className="flex flex-wrap items-end gap-3">
                <TextField
                  className="w-48"
                  value={instance.name}
                  variant="secondary"
                  onChange={(value) => { patch(instance.id, { name: value }) }}
                >
                  <Label>{t('strips.name')}</Label>
                  <Input placeholder={`Şerit ${index + 1}`} />
                </TextField>

                <Switch
                  isSelected={instance.enabled}
                  size="sm"
                  onChange={(enabled) => { patch(instance.id, { enabled }) }}
                >
                  <Switch.Content>
                    <Switch.Control><Switch.Thumb /></Switch.Control>
                    {t('strips.enabled')}
                  </Switch.Content>
                </Switch>

                <div className="ml-auto flex flex-wrap gap-2">
                  <Button
                    isDisabled={selected}
                    size="sm"
                    variant={selected ? 'secondary' : 'primary'}
                    onPress={() => { setActiveId(instance.id) }}
                  >
                    {t(selected ? 'strips.selected' : 'strips.select')}
                  </Button>
                  {/*
                    Removing the last strip is refused by the model rather than
                    defended against here - but a disabled button says so before
                    the click instead of after it.
                  */}
                  <Button
                    isDisabled={list.length <= 1}
                    size="sm"
                    variant="secondary"
                    onPress={() => {
                      setNotice(null)
                      setDraft(removeInstance(list, instance.id))
                    }}
                  >
                    {t('strips.remove')}
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                <span>{t('strips.leds', { count: configLedCount(instance.config) })}</span>
                <span>· {t(`output.transport.${instance.config.output.transport}`)}</span>
                {instance.config.output.host !== undefined && <span>· {instance.config.output.host}</span>}
                {live !== undefined && (
                  <span className="flex items-center gap-1.5">
                    ·
                    <span
                      aria-hidden
                      className={`size-2 rounded-full ${
                        live.state === 'running' ? 'bg-success' : live.state === 'error' ? 'bg-danger' : 'bg-default'
                      }`}
                    />
                    {live.state === 'running' && live.stats !== null
                      ? t('strips.rate', { fps: live.stats.outputFps.toFixed(0) })
                      : t(`device.state.${live.state}` as 'device.state.idle')}
                  </span>
                )}
                {live?.error !== undefined && <span className="text-danger">· {tx(live.error)}</span>}
              </div>
            </Surface>
          )
        })}

        <div className="flex flex-wrap gap-2">
          <Button
            isDisabled={list.length >= MAX_INSTANCES}
            variant="secondary"
            onPress={() => {
              setNotice(null)
              // A new strip copies the last one rather than the reference rig:
              // whoever is adding a second strip has just finished describing
              // the first, and the difference is usually the output and a
              // handful of LED counts.
              setDraft(addInstance(list))
            }}
          >
            {t('strips.add')}
          </Button>
          <Button isDisabled={saving} onPress={() => { void save() }}>
            {t(saving ? 'strips.saving' : 'strips.save')}
          </Button>
        </div>

        {notice !== null && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
        )}

        {/*
          How many pickers the user was actually shown. More than one means
          two strips disagree about their source, which is either the desk/TV
          arrangement working as intended or a strip pointed at the wrong
          source - and this is the number that says which.
        */}
        {pool !== null && pool.captures > 1 && (
          <p className="text-xs text-muted">{t('strips.captures', { count: pool.captures })}</p>
        )}
        <p className="text-xs text-muted">{t('strips.captureNote')}</p>
        <p className="text-xs text-muted">{t('strips.serialNote')}</p>
      </Card.Content>
    </Card>
  )
}

/**
 * The strip picker, repeated wherever the panel needs it.
 *
 * Hidden with one strip: a selector with a single entry is a control that
 * cannot be used, and every installation starts with one.
 */
export function StripPicker ({ className }: { className?: string }) {
  const t = useTranslate()
  const { instances, activeId, setActiveId } = useEngine()
  if (instances.length < 2) return null
  return (
    <div className={`flex flex-col gap-1 ${className ?? ''}`}>
      <span className="px-3 text-xs font-semibold uppercase tracking-wide text-muted">{t('strips.active')}</span>
      <div className="flex flex-wrap gap-1 px-3">
        {instances.map((instance) => (
          <button
            key={instance.id}
            aria-pressed={instance.id === activeId}
            className={`rounded-full border px-2.5 py-1 text-xs transition ${
              instance.id === activeId
                ? 'border-primary bg-primary/15'
                : 'border-default/40 text-muted hover:border-default'
            } ${instance.enabled ? '' : 'opacity-50'}`}
            type="button"
            onClick={() => { setActiveId(instance.id) }}
          >
            {instance.name}
          </button>
        ))}
      </div>
    </div>
  )
}
