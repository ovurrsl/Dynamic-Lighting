'use client'

import { Card, Surface } from '@heroui/react'

import { useTranslate } from '#components/Preferences'
import { ROADMAP_ITEMS, ROADMAP_STATE_KEY } from '#lib/roadmap'

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
          {ROADMAP_ITEMS.map((item) => (
            <li key={item.title} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-xs text-muted">{item.state === 'never' ? '—' : '✓'}</span>
                <h3 className="text-sm font-semibold">{t(item.title)}</h3>
                <span
                  className={`rounded-full border px-2 py-0.5 text-xs ${
                    item.state === 'done' ? 'border-success/50 text-success' : 'border-default/25 text-muted'
                  }`}
                >
                  {t(ROADMAP_STATE_KEY[item.state])}
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
