import { encodeAxc } from '#lib/engine/protocol'

/**
 * The control channel, host side.
 *
 * Until now the firmware had an `AxC` channel and nothing could speak it: the
 * LED count, the power budget, the idle brightness, the bench run and - since
 * the network build - the WiFi credentials were all reachable only from a
 * serial terminal. A board that has to be provisioned by hand is not a product,
 * and it is what would have made the firmware's WebSocket server unreachable in
 * practice: someone has to put the board on a network before it can be dialled.
 *
 * The validation here MIRRORS the firmware's (firmware/lib/afx/src/afx_net.h
 * and afx_config.h) deliberately, so the panel refuses an impossible value at
 * the field rather than sending it and reading `refused` back with nothing to
 * show the user. Where the two could drift, the firmware is the authority and
 * this file is the copy - the tests below quote its rules.
 */

/** TLV types, matching `afx::Tlv` and `afx::NetTlv`. */
export const TLV = Object.freeze({
  version: 0x01,
  runBench: 0x02,
  ledCount: 0x03,
  budgetMa: 0x04,
  idleBrightness: 0x05,
  benchOnBoot: 0x06,
  queryConfig: 0x07,
  save: 0x08,
  resetDefaults: 0x09,
  wifiSsid: 0x0a,
  wifiPassphrase: 0x0b,
  wifiEnabled: 0x0c,
  queryNet: 0x0d
})

/** Firmware limits, quoted rather than invented. */
export const MAX_SSID_BYTES = 32
export const MIN_PASSPHRASE_BYTES = 8
export const MAX_PASSPHRASE_BYTES = 63
export const MAX_LED_COUNT = 512
export const MIN_BUDGET_MA = 100
export const MAX_BUDGET_MA = 20000

export interface Tlv {
  type: number
  value: Uint8Array
}

const encoder = new TextEncoder()

export function tlvAction (type: number): Tlv {
  return { type, value: new Uint8Array(0) }
}

export function tlvU8 (type: number, value: number): Tlv {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`control: ${type} takes 0..255, got ${String(value)}`)
  }
  return { type, value: Uint8Array.of(value) }
}

export function tlvU16 (type: number, value: number): Tlv {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`control: ${type} takes 0..65535, got ${String(value)}`)
  }
  return { type, value: Uint8Array.of(value >> 8, value & 0xff) }
}

/**
 * A text TLV, measured in BYTES.
 *
 * Not characters: an SSID is 32 OCTETS in 802.11, so `Şirket Ağı` costs more
 * than its ten characters suggest and a length check on `.length` would let a
 * name through that the firmware then refuses. This project's own language
 * makes that the common case rather than an edge one.
 */
export function tlvText (type: number, text: string, maxBytes: number): Tlv {
  const value = encoder.encode(text)
  if (value.length > maxBytes) {
    throw new RangeError(`control: ${value.length} bytes is over the ${maxBytes} the firmware accepts`)
  }
  // A NUL would truncate the value inside the firmware's fixed buffer and leave
  // the board holding something other than what was sent.
  if (value.includes(0)) throw new RangeError('control: a NUL cannot be sent in a text field')
  return { type, value }
}

/** Lays the TLVs out and frames them. The bytes a port or a socket takes. */
export function encodeControl (items: readonly Tlv[]): Uint8Array {
  if (items.length === 0) throw new RangeError('control: nothing to send')
  let length = 0
  for (const item of items) {
    if (item.value.length > 255) {
      throw new RangeError(`control: a TLV value is at most 255 bytes, got ${item.value.length}`)
    }
    length += 2 + item.value.length
  }
  const body = new Uint8Array(length)
  let at = 0
  for (const item of items) {
    body[at] = item.type
    body[at + 1] = item.value.length
    body.set(item.value, at + 2)
    at += 2 + item.value.length
  }
  return encodeAxc(body)
}

export interface WifiCredentials {
  ssid: string
  /** Empty means an open network, which the firmware accepts as a real answer. */
  passphrase: string
  enabled: boolean
}

/**
 * The TLVs that put a board on a network.
 *
 * A passphrase between one and seven characters is REFUSED rather than sent:
 * WPA2-PSK as ASCII is 8..63, so a shorter one can never associate, and a board
 * that boots and retries forever with nothing saying why is the worst of the
 * possible outcomes.
 */
export function wifiControl (credentials: WifiCredentials, save = true): Uint8Array {
  // Sent as typed: 802.11 allows a name that begins or ends with a space and
  // the firmware takes the exact bytes, so trimming here made such a network
  // impossible to join. Only "nothing but spaces" counts as no name.
  const ssid = tlvText(TLV.wifiSsid, credentials.ssid.trim() === '' ? '' : credentials.ssid, MAX_SSID_BYTES)
  const passphrase = tlvText(TLV.wifiPassphrase, credentials.passphrase, MAX_PASSPHRASE_BYTES)
  if (passphrase.value.length !== 0 &&
      (passphrase.value.length < MIN_PASSPHRASE_BYTES || passphrase.value.length > MAX_PASSPHRASE_BYTES)) {
    throw new RangeError(
      `control: a WPA2 passphrase is ${MIN_PASSPHRASE_BYTES}..${MAX_PASSPHRASE_BYTES} bytes, got ${passphrase.value.length}`)
  }
  if (credentials.enabled && ssid.value.length === 0) {
    throw new RangeError('control: a network cannot be joined without a name')
  }
  const items: Tlv[] = [
    ssid,
    passphrase,
    tlvU8(TLV.wifiEnabled, credentials.enabled ? 1 : 0),
    // Saved, because credentials that do not survive a power cut are not
    // credentials - the board would come back on the cable only.
    ...(save ? [tlvAction(TLV.save)] : []),
    tlvAction(TLV.queryNet)
  ]
  return encodeControl(items)
}

/** Asks the board what it is: version, configuration, and network state. */
export function queryControl (): Uint8Array {
  return encodeControl([tlvAction(TLV.queryConfig), tlvAction(TLV.queryNet)])
}
