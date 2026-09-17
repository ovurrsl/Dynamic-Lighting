'use client'

import { Card, Surface } from '@heroui/react'

import { useTranslate } from '#components/Preferences'
import { EFFECT_KINDS } from '#lib/engine/effects'
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

/**
 * Two states, not four. 'next' and 'planned' existed while the list still had
 * things ahead of it; every item is now built or ruled out, and a state no
 * item can have is a promise the page cannot keep.
 */
type State = 'done' | 'never'

const ITEMS: Array<{ title: MessageKey, body: MessageKey, state: State, values?: Record<string, number> }> = [
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
  // Counted from the engine's own list, so the sentence cannot fall behind it
  // again: it said "seven" while twelve were shipping.
  { title: 'roadmap.effects.title', body: 'roadmap.effects.body', state: 'done', values: { count: EFFECT_KINDS.length } },
  { title: 'roadmap.audio.title', body: 'roadmap.audio.body', state: 'done' },
  { title: 'roadmap.capture.title', body: 'roadmap.capture.body', state: 'done' },
  { title: 'roadmap.priority.title', body: 'roadmap.priority.body', state: 'done' },
  { title: 'roadmap.events.title', body: 'roadmap.events.body', state: 'done' },
  { title: 'roadmap.instances.title', body: 'roadmap.instances.body', state: 'done' },
  { title: 'roadmap.udp.title', body: 'roadmap.udp.body', state: 'never' },
  { title: 'roadmap.spi.title', body: 'roadmap.spi.body', state: 'never' }
]

const STATE_KEY: Record<State, MessageKey> = {
  done: 'roadmap.state.done',
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
          {ITEMS.map((item) => (
            <li key={item.title} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-xs text-muted">{item.state === 'never' ? '—' : '✓'}</span>
                <h3 className="text-sm font-semibold">{t(item.title)}</h3>
                <span
                  className={`rounded-full border px-2 py-0.5 text-xs ${
                    item.state === 'done' ? 'border-success/50 text-success' : 'border-default/25 text-muted'
                  }`}
                >
                  {t(STATE_KEY[item.state])}
                </span>
              </div>
              <p className="text-sm text-muted">{t(item.body, item.values)}</p>
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
