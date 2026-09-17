'use client'

import { useEffect, useState } from 'react'
import { Card, Surface } from '@heroui/react'

import { useTranslate } from '#components/Preferences'
import { currentEnvironment, detectCapabilities, outputRoutes } from '#lib/capabilities'
import { hashForSection } from '#lib/sections'
import type { MessageKey } from '#lib/i18n/strings'

const REPO = 'https://github.com/ovurrsl/Dynamic-Lighting'

/**
 * The manual, in the application.
 *
 * It lives on the page rather than in a README because the people who need it
 * are the ones who have just opened the panel and have no strip lit. A README is
 * read by someone who already cloned the repository; this is read by someone who
 * does not yet know they have to load an extension at all.
 *
 * Deliberately not a link to documentation elsewhere: an installation guide that
 * needs a working network and a second tab is a guide that fails exactly when
 * the user is already stuck.
 */

/**
 * A numbered step: title, body, an optional caveat that earns a box, and an
 * optional link. The link belongs to its step rather than sitting under the
 * list, because "open the repository" is only an instruction while you are
 * reading step one.
 */
const STEPS: Array<{ title: MessageKey, body: MessageKey, aside?: MessageKey, link?: MessageKey }> = [
  { title: 'guide.step.download.title', body: 'guide.step.download.body', link: 'guide.step.download.repo' },
  { title: 'guide.step.install.title', body: 'guide.step.install.body', aside: 'guide.step.install.warning' },
  { title: 'guide.step.pair.title', body: 'guide.step.pair.body', aside: 'guide.step.pair.note' },
  { title: 'guide.step.capture.title', body: 'guide.step.capture.body' },
  { title: 'guide.step.layout.title', body: 'guide.step.layout.body' }
]

const WIRING: MessageKey[] = ['guide.wiring.power', 'guide.wiring.level', 'guide.wiring.parts']

const TROUBLE: Array<{ q: MessageKey, a: MessageKey }> = [
  { q: 'guide.trouble.nothing.q', a: 'guide.trouble.nothing.a' },
  { q: 'guide.trouble.black.q', a: 'guide.trouble.black.a' },
  { q: 'guide.trouble.order.q', a: 'guide.trouble.order.a' },
  { q: 'guide.trouble.mirror.q', a: 'guide.trouble.mirror.a' },
  { q: 'guide.trouble.stop.q', a: 'guide.trouble.stop.a' }
]

const LIMITS: MessageKey[] = ['guide.limits.session', 'guide.limits.drm']

export function GuideCard () {
  const t = useTranslate()

  /**
   * Whether THIS browser has any local-device route at all (serial, HID, USB).
   *
   * The five steps below are all "download the extension, pair the serial
   * port" - which is simply wrong advice on a browser with no Web Serial, not
   * a longer path. Safari and Firefox declined to implement it on every
   * platform, and on iOS there is no extension host to load one into either.
   * Those browsers are not unsupported - lib/page-host.ts exists specifically
   * to run the engine in this page for them - but a guide that never says so
   * sends someone through five steps that cannot work for their browser.
   *
   * Measured the same way the Device page measures it, not sniffed from the
   * user agent: a UA string says what a browser CLAIMS to be, not what it can
   * do, and this project has been burned by trusting a claim over asking three
   * times already.
   */
  const [hasLocalDevice, setHasLocalDevice] = useState<boolean | null>(null)
  useEffect(() => {
    // Specifically serial/HID/USB - the routes an EXTENSION reaches. `network`
    // is deliberately excluded: WebSocket exists in every browser, extension or
    // not, so checking outputRoutes() as a whole would say "yes" everywhere and
    // never show this box at all.
    const local: ReadonlySet<string> = new Set(['serial', 'hid', 'usb'])
    const routes = outputRoutes(detectCapabilities(currentEnvironment()))
    setHasLocalDevice(routes.some((id) => local.has(id)))
  }, [])

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('guide.title')}</Card.Title>
        <Card.Description>{t('guide.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-6">
        <p className="text-sm text-muted">{t('guide.why')}</p>

        {hasLocalDevice === false && (
          <Surface className="flex flex-col gap-2 rounded-xl p-3 text-sm" variant="secondary">
            <p className="font-medium">{t('guide.noExtension.title')}</p>
            <p className="text-muted">{t('guide.noExtension.body')}</p>
            <a
              className="self-start text-sm underline underline-offset-4"
              href={hashForSection('device')}
            >
              {t('guide.noExtension.link')}
            </a>
          </Surface>
        )}

        <ol className={`flex flex-col gap-4 ${hasLocalDevice === false ? 'opacity-60' : ''}`}>
          {STEPS.map((step) => (
            <li key={step.title} className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t(step.title)}</h3>
              <p className="text-sm text-muted">{t(step.body)}</p>
              {step.link !== undefined && (
                <a
                  className="self-start text-sm underline underline-offset-4"
                  href={REPO}
                  rel="noreferrer"
                  target="_blank"
                >
                  {t(step.link)}
                </a>
              )}
              {step.aside !== undefined && (
                <Surface className="rounded-xl p-3 text-xs text-muted" variant="secondary">
                  {t(step.aside)}
                </Surface>
              )}
            </li>
          ))}
        </ol>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t('guide.wiring.title')}</h3>
          <ul className="flex list-disc flex-col gap-1 ps-5 text-sm text-muted">
            {WIRING.map((key) => <li key={key}>{t(key)}</li>)}
          </ul>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{t('guide.trouble.title')}</h3>
          <dl className="flex flex-col gap-3">
            {TROUBLE.map((entry) => (
              <div key={entry.q} className="flex flex-col gap-1">
                <dt className="text-sm font-medium">{t(entry.q)}</dt>
                <dd className="text-sm text-muted">{t(entry.a)}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t('guide.limits.title')}</h3>
          <ul className="flex list-disc flex-col gap-1 ps-5 text-sm text-muted">
            {LIMITS.map((key) => <li key={key}>{t(key)}</li>)}
          </ul>
        </section>
      </Card.Content>
    </Card>
  )
}
