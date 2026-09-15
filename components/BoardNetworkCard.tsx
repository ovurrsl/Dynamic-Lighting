'use client'

import { useState } from 'react'
import { Button, Card, Input, Label, Surface, Switch, TextField } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useTranslate } from '#components/Preferences'
import {
  MAX_PASSPHRASE_BYTES,
  MAX_SSID_BYTES,
  MIN_PASSPHRASE_BYTES
} from '#lib/engine/control'

/**
 * Putting the board on a network.
 *
 * This exists because without it the firmware's WebSocket server is unreachable
 * in practice: something has to tell the board a name and a passphrase before
 * it can be dialled, and "open a serial terminal" is not an answer a product
 * gives. The message goes over the AxC control channel, down whichever link is
 * already carrying frames - so the usual path is over the cable, and a board
 * that is already on WiFi can be moved to another network over WiFi.
 *
 * The passphrase is typed here and sent; it is never read back. The board
 * reports its SSID and its address and nothing else, deliberately - a
 * credential echoed into a telemetry line ends up in whatever log the panel or
 * a support ticket happens to keep.
 */

/** The byte lengths the firmware enforces, checked here so the field can say so. */
const bytesOf = (text: string): number => new TextEncoder().encode(text).length

export function BoardNetworkCard () {
  const t = useTranslate()
  const { probe, host, stats, sendControl } = useEngine()
  const [ssid, setSsid] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  const ssidBytes = bytesOf(ssid.trim())
  const passBytes = bytesOf(passphrase)
  const ssidTooLong = ssidBytes > MAX_SSID_BYTES
  const passBad = passBytes !== 0 && (passBytes < MIN_PASSPHRASE_BYTES || passBytes > MAX_PASSPHRASE_BYTES)
  const needsName = enabled && ssidBytes === 0
  const canSend = !busy && !ssidTooLong && !passBad && !needsName

  // A control frame needs a link that carries our bytes. A WLED speaks its own
  // protocol and the loopback has no board, so the card says why rather than
  // offering a button that cannot work.
  const mode = stats?.link.mode
  const linkReady = mode === 'port' || mode === 'websocket'

  const apply = (): void => {
    setBusy(true)
    setNotice(null)
    void sendControl({ kind: 'wifi', ssid: ssid.trim(), passphrase, enabled }).then((error) => {
      setBusy(false)
      setNotice(error === null ? t('board.wifi.sent') : t('board.wifi.failed', { reason: error }))
      // Not kept in state a moment longer than the send needs it.
      if (error === null) setPassphrase('')
    })
  }

  // Shown for either host: a page driving a board over a socket can
  // reconfigure it just as well as the extension can.
  if (host !== 'page' && probe?.available !== true) return null

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('board.wifi.title')}</Card.Title>
        <Card.Description>{t('board.wifi.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        {!linkReady && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">
            {t('board.wifi.needLink')}
          </Surface>
        )}

        <TextField className="w-80" value={ssid} variant="secondary" onChange={(value) => { setTouched(true); setSsid(value) }}>
          <Label>{t('board.wifi.ssid')}</Label>
          <Input placeholder={t('board.wifi.ssid.placeholder')} />
        </TextField>
        <p className="text-xs text-muted">
          {ssidTooLong ? t('board.wifi.ssid.tooLong', { bytes: ssidBytes }) : t('board.wifi.ssid.note')}
        </p>

        <TextField className="w-80" type="password" value={passphrase} variant="secondary" onChange={setPassphrase}>
          <Label>{t('board.wifi.passphrase')}</Label>
          <Input placeholder={t('board.wifi.passphrase.placeholder')} />
        </TextField>
        <p className="text-xs text-muted">
          {passBad ? t('board.wifi.passphrase.bad') : t('board.wifi.passphrase.note')}
        </p>

        <Switch isSelected={enabled} size="md" onChange={setEnabled}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            {t('board.wifi.enabled')}
          </Switch.Content>
        </Switch>
        <p className="text-xs text-muted">{t('board.wifi.enabled.note')}</p>

        {needsName && touched && (
          <Surface className="rounded-xl p-3 text-sm text-danger" variant="secondary">
            {t('board.wifi.needName')}
          </Surface>
        )}
        {notice !== null && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
        )}

        <div className="flex flex-wrap gap-2">
          <Button isDisabled={!canSend || !linkReady} onPress={apply}>
            {t(busy ? 'board.wifi.sending' : 'board.wifi.apply')}
          </Button>
        </div>
        <p className="text-xs text-muted">{t('board.wifi.note')}</p>
      </Card.Content>
    </Card>
  )
}
