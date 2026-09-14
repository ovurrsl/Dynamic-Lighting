'use client'

import { Card, Surface } from '@heroui/react'

import { useTranslate } from '#components/Preferences'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * What is missing, in the order it is being built - and what is not coming.
 *
 * This page exists so the navigation does not have to lie. The alternative was
 * a sidebar full of disabled entries promising an effects page and an audio
 * page that do not exist; a list that says plainly "not built, here is where it
 * sits in the order" is more honest and more useful than a greyed-out menu item
 * a user keeps clicking.
 *
 * The "not happening" half is the part worth having. Twelve or so of Hyperion's
 * LED drivers cannot exist in a browser at all, and saying so with the
 * measurement beside it saves the next person the afternoon I already spent
 * finding out.
 */

type State = 'done' | 'next' | 'planned' | 'never'

const ITEMS: Array<{ title: MessageKey, body: MessageKey, state: State }> = [
  // Reordered 2026-09-14. An iPhone was shown capturing its own screen and
  // feeding our sampler - and iOS Safari has no Web Serial, WebUSB, WebHID or
  // Web Bluetooth, so a captured frame there has nowhere to go. The output
  // abstraction and the network driver stopped being "later".
  //
  // The 'done' entries stay on the page rather than being deleted. This list is
  // the answer to "what can this thing do compared with Hyperion", and a list
  // that only ever shows what is missing answers half of it.
  { title: 'roadmap.sink.title', body: 'roadmap.sink.body', state: 'done' },
  { title: 'roadmap.wled.title', body: 'roadmap.wled.body', state: 'done' },
  { title: 'roadmap.host.title', body: 'roadmap.host.body', state: 'done' },
  { title: 'roadmap.effects.title', body: 'roadmap.effects.body', state: 'done' },
  { title: 'roadmap.audio.title', body: 'roadmap.audio.body', state: 'done' },
  { title: 'roadmap.capture.title', body: 'roadmap.capture.body', state: 'done' },
  { title: 'roadmap.priority.title', body: 'roadmap.priority.body', state: 'done' },
  { title: 'roadmap.events.title', body: 'roadmap.events.body', state: 'next' },
  { title: 'roadmap.instances.title', body: 'roadmap.instances.body', state: 'planned' },
  { title: 'roadmap.udp.title', body: 'roadmap.udp.body', state: 'never' },
  { title: 'roadmap.spi.title', body: 'roadmap.spi.body', state: 'never' }
]

const STATE_KEY: Record<State, MessageKey> = {
  done: 'roadmap.state.done',
  next: 'roadmap.state.next',
  planned: 'roadmap.state.planned',
  never: 'roadmap.state.never'
}

export function RoadmapCard () {
  const t = useTranslate()

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('nav.roadmap')}</Card.Title>
        <Card.Description>{t('roadmap.intro')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        <ol className="flex flex-col gap-4">
          {ITEMS.map((item, at) => (
            <li key={item.title} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-xs text-muted">
                  {item.state === 'never' ? '—' : item.state === 'done' ? '✓' : String(at + 1).padStart(2, '0')}
                </span>
                <h3 className="text-sm font-semibold">{t(item.title)}</h3>
                <span
                  className={`rounded-full border px-2 py-0.5 text-xs ${
                    item.state === 'done'
                      ? 'border-success/50 text-success'
                      : item.state === 'next'
                        ? 'border-default/50'
                        : 'border-default/25 text-muted'
                  }`}
                >
                  {t(STATE_KEY[item.state])}
                </span>
              </div>
              <p className="text-sm text-muted">{t(item.body)}</p>
            </li>
          ))}
        </ol>
        <Surface className="rounded-xl p-3 text-xs text-muted" variant="secondary">
          {t('roadmap.source')}
        </Surface>
      </Card.Content>
    </Card>
  )
}
