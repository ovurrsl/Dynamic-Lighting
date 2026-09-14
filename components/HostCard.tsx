'use client'

import { Card, Label, ListBox, Select, Surface } from '@heroui/react'

import { useEngine, type EngineHostKind } from '#components/Engine'
import { useTranslate } from '#components/Preferences'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * Choosing where the engine runs.
 *
 * This is a real choice with a real trade-off, so it is presented as one rather
 * than decided silently. The extension's offscreen document is never rendered
 * and therefore never throttled - it is the only host that keeps up while
 * someone plays a full-screen game. The page host works in every browser that
 * can capture a screen, which since the network drivers means an iPhone can run
 * the whole application, and it is throttled the moment its tab is hidden.
 *
 * Neither of those sentences is hidden behind a tooltip. A user who picks the
 * page host and then minimises the window would otherwise watch their strip
 * freeze with nothing anywhere explaining why.
 */

const HOST_KEY: Record<EngineHostKind, MessageKey> = {
  extension: 'host.extension',
  page: 'host.page'
}

const NOTE_KEY: Record<EngineHostKind, MessageKey> = {
  extension: 'host.extension.note',
  page: 'host.page.note'
}

export function HostCard () {
  const t = useTranslate()
  const { host, setHost, probe, pageCapable, state } = useEngine()

  const extensionReady = probe?.available === true
  const hosts: EngineHostKind[] = ['extension', 'page']

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('host.title')}</Card.Title>
        <Card.Description>{t('host.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        <Select
          className="w-80"
          value={host}
          onChange={(value) => { setHost(value as EngineHostKind) }}
        >
          <Label>{t('host.title')}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {hosts.map((kind) => (
                <ListBox.Item
                  id={kind}
                  key={kind}
                  // An unavailable host is shown and disabled rather than
                  // hidden: "the extension is not installed" is information,
                  // and a menu that silently has one entry is not.
                  isDisabled={kind === 'extension' ? !extensionReady : !pageCapable}
                  textValue={t(HOST_KEY[kind])}
                >
                  {t(HOST_KEY[kind])}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>

        <Emphasised className="text-xs text-muted" text={t(NOTE_KEY[host])} />

        {!extensionReady && probe !== null && (
          <p className="text-xs text-muted">{t('host.extension.unavailable')}</p>
        )}
        {!pageCapable && (
          <p className="text-xs text-muted">{t('host.page.unavailable')}</p>
        )}

        {state === 'running' && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">
            {t('host.running')} · {t(HOST_KEY[host])}
          </Surface>
        )}
        <p className="text-xs text-muted">{t('host.switchWarning')}</p>
      </Card.Content>
    </Card>
  )
}

/**
 * Renders `**bold**` runs, and nothing else.
 *
 * The throttling sentence is the one thing on this card a user must not skim
 * past, and the alternative to this was splitting one translated sentence into
 * three strings that every translator then has to reassemble in the right
 * order.
 */
function Emphasised ({ text, className }: { text: string, className?: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g)
  return (
    <p className={className}>
      {parts.map((part, index) => (
        index % 2 === 1
          ? <strong className="text-foreground" key={index}>{part}</strong>
          : <span key={index}>{part}</span>
      ))}
    </p>
  )
}
