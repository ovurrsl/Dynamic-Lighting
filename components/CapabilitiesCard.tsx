'use client'

import { useEffect, useState } from 'react'
import { Card, Surface } from '@heroui/react'

import { useTranslate } from '#components/Preferences'
import {
  captureRoute,
  currentEnvironment,
  detectCapabilities,
  outputRoutes,
  type Capability,
  type CapabilityId
} from '#lib/capabilities'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * What this browser can actually do, measured here rather than looked up.
 *
 * The reason this page exists is on the record three times over: the
 * compatibility tables have been wrong about this project at every turn, and
 * each correction moved the architecture. The most recent one arrived as a
 * screenshot from an iPhone doing something caniuse still says iOS cannot do.
 *
 * So the panel stops asserting and starts asking. It is also the first thing to
 * look at in a support conversation - "send me a photo of this page" answers
 * more than twenty questions about versions do.
 */

const LABEL: Record<CapabilityId, MessageKey> = {
  screenCapture: 'caps.screenCapture',
  cameraCapture: 'caps.cameraCapture',
  serial: 'caps.serial',
  hid: 'caps.hid',
  usb: 'caps.usb',
  network: 'caps.network',
  fastCapture: 'caps.fastCapture',
  frameCallback: 'caps.frameCallback',
  offscreenCanvas: 'caps.offscreenCanvas',
  extensionBridge: 'caps.extensionBridge'
}

const NOTE: Record<CapabilityId, MessageKey> = {
  screenCapture: 'caps.screenCapture.note',
  cameraCapture: 'caps.cameraCapture.note',
  serial: 'caps.serial.note',
  hid: 'caps.hid.note',
  usb: 'caps.usb.note',
  network: 'caps.network.note',
  fastCapture: 'caps.fastCapture.note',
  frameCallback: 'caps.frameCallback.note',
  offscreenCanvas: 'caps.offscreenCanvas.note',
  extensionBridge: 'caps.extensionBridge.note'
}

const ROUTE: Record<ReturnType<typeof captureRoute>, MessageKey> = {
  capture: 'caps.route.capture',
  card: 'caps.route.card',
  remote: 'caps.route.remote'
}

export function CapabilitiesCard () {
  const t = useTranslate()
  /**
   * Read after mount, never during render. The server has no `navigator`, so
   * rendering this on the server would either crash or - worse - quietly report
   * that nothing is supported, which is exactly the kind of confident wrong
   * answer this card exists to stop producing.
   */
  const [capabilities, setCapabilities] = useState<Capability[] | null>(null)
  useEffect(() => { setCapabilities(detectCapabilities(currentEnvironment())) }, [])

  if (capabilities === null) return null

  const route = captureRoute(capabilities)
  const outputs = outputRoutes(capabilities)

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('caps.title')}</Card.Title>
        <Card.Description>{t('caps.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        <Surface className="flex flex-col gap-1 rounded-xl p-3 text-sm" variant="secondary">
          <span>{t(ROUTE[route])}</span>
          <span className="text-muted">
            {outputs.length === 0
              ? t('caps.output.none')
              : t('caps.output.some', { routes: outputs.map((id) => t(LABEL[id])).join(', ') })}
          </span>
        </Surface>

        <ul className="flex flex-col gap-3">
          {capabilities.map((entry) => (
            <li key={entry.id} className="flex flex-col gap-0.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className={`text-sm ${entry.weight === 'detail' ? 'text-muted' : 'font-medium'}`}>
                  {t(LABEL[entry.id])}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono text-xs ${
                    entry.present ? 'border-default/50' : 'border-default/25 text-muted'
                  }`}
                >
                  {t(entry.present ? 'caps.yes' : 'caps.no')}
                </span>
              </div>
              <p className="text-xs text-muted">{t(NOTE[entry.id])}</p>
            </li>
          ))}
        </ul>

        <p className="text-xs text-muted">{t('caps.share')}</p>
      </Card.Content>
    </Card>
  )
}
