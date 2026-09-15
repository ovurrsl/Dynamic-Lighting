'use client'

import { Button, Card, Surface } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useTranslate } from '#components/Preferences'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * What the strip is showing, and what is queued underneath it.
 *
 * This is the visible half of priority layers. Before them every source stopped
 * every other: starting an effect ended the capture, and stopping the effect
 * left the strip dark with the user picking their screen again. Now several
 * sources are live at once and the muxer decides which one the strip sees - so
 * there has to be somewhere that says which, or the user is left guessing why
 * their effect is not showing while a test pattern runs above it.
 *
 * The winner is reported BY THE ENGINE rather than worked out here. Which
 * source is on the strip is the muxer's decision; a panel that derived it
 * separately would disagree with the strip exactly when it mattered.
 */

export const COMPONENT_KEY: Record<string, MessageKey | undefined> = {
  capture: 'layers.component.capture',
  effect: 'layers.component.effect',
  audio: 'layers.component.audio',
  color: 'layers.component.color',
  flash: 'layers.component.flash',
  pattern: 'layers.component.pattern',
  // The two automatic layers name themselves here too. Without these the list
  // shows the raw component tag, which is the one place in the panel a user
  // would see an internal name.
  background: 'layers.component.background',
  startup: 'layers.component.startup'
}

export function LayersCard () {
  const t = useTranslate()
  const { stats, clearLayer } = useEngine()
  const layers = stats?.layers ?? []

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('layers.title')}</Card.Title>
        <Card.Description>{t('layers.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        {layers.length === 0 && <p className="text-sm text-muted">{t('layers.empty')}</p>}

        {layers.map((layer) => {
          const name = COMPONENT_KEY[layer.component]
          return (
            <Surface
              className={`flex flex-wrap items-center gap-3 rounded-xl p-3 text-sm ${
                layer.winning ? 'ring-1 ring-primary' : ''
              }`}
              key={layer.priority}
              variant="secondary"
            >
              <span
                aria-hidden
                className={`size-2 rounded-full ${layer.winning ? 'bg-primary' : 'bg-default'}`}
              />
              <span className="font-medium">{name === undefined ? layer.component : t(name)}</span>
              <span className="text-xs text-muted">{t('layers.priority', { priority: layer.priority })}</span>
              <span className="text-xs text-muted">
                {/*
                  Three states, not two. A source that has registered but not
                  delivered a frame yet is neither showing nor waiting its turn -
                  it is a capture whose picker is still open, and saying
                  "underneath" about it would be wrong.
                */}
                {!layer.active
                  ? t('layers.inactive')
                  : layer.winning ? t('layers.showing') : t('layers.waiting')}
              </span>
              <Button
                className="ml-auto"
                size="sm"
                variant="secondary"
                onPress={() => { void clearLayer(layer.priority) }}
              >
                {t('layers.clear')}
              </Button>
            </Surface>
          )
        })}
      </Card.Content>
    </Card>
  )
}
