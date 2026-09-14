import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_SSID_BYTES,
  TLV,
  encodeControl,
  queryControl,
  tlvAction,
  tlvText,
  tlvU16,
  tlvU8,
  wifiControl
} from '#lib/engine/control'
import { fletcherAwa } from '#lib/engine/protocol'

/**
 * The firmware's own walk, rewritten here from afx_config.h.
 *
 * Deliberately a second implementation rather than an import: what these tests
 * are for is that the bytes this encoder produces are the bytes THAT parser
 * reads, and checking the encoder against itself would prove nothing.
 */
function parseFrame (frame: Uint8Array): { magic: string, count: number, tlvs: Array<{ type: number, value: number[] }> } {
  const magic = String.fromCharCode(frame[0] as number, frame[1] as number, frame[2] as number)
  const hi = frame[3] as number
  const lo = frame[4] as number
  assert.equal(frame[5], (hi ^ lo ^ 0x55), 'the header XOR')
  const count = (hi << 8 | lo) + 1          // AxC counts BYTES, not LEDs
  const body = frame.subarray(6, 6 + count)
  assert.equal(frame.length, 6 + count + 3)
  assert.deepEqual(Array.from(frame.subarray(6 + count)), fletcherAwa(body), 'the trailer')

  const tlvs: Array<{ type: number, value: number[] }> = []
  let at = 0
  while (at + 2 <= body.length) {
    const type = body[at] as number
    const size = body[at + 1] as number
    if (at + 2 + size > body.length) break
    tlvs.push({ type, value: Array.from(body.subarray(at + 2, at + 2 + size)) })
    at += 2 + size
  }
  return { magic, count, tlvs }
}

test('a control frame has its own magic, because a TLV body looks like pixels', () => {
  // Without the separate magic, "set the LED count to 108" would be pushed onto
  // the strip as three pixels - the body is the same bytes as a short 8-bit
  // frame and nothing else distinguishes them.
  const frame = encodeControl([tlvU16(TLV.ledCount, 108)])
  assert.equal(parseFrame(frame).magic, 'AxC')
})

test('the header counts bytes, not LEDs', () => {
  // A TLV body of 6 bytes is announced as 6. Counting LEDs would refuse every
  // body whose length is not a multiple of three.
  const frame = encodeControl([tlvU16(TLV.ledCount, 108), tlvAction(TLV.save)])
  const parsed = parseFrame(frame)
  assert.equal(parsed.count, 6, '4 bytes of ledCount TLV + 2 of the save action')
  assert.deepEqual(parsed.tlvs, [
    { type: TLV.ledCount, value: [0, 108] },
    { type: TLV.save, value: [] }
  ])
})

test('values go out big-endian, as the firmware reads them', () => {
  const parsed = parseFrame(encodeControl([tlvU16(TLV.budgetMa, 1500), tlvU8(TLV.idleBrightness, 40)]))
  assert.deepEqual(parsed.tlvs[0]?.value, [0x05, 0xdc])
  assert.deepEqual(parsed.tlvs[1]?.value, [40])
})

test('an SSID is measured in bytes, not characters', () => {
  // 802.11 says 32 OCTETS. A Turkish network name spends two bytes on several
  // of its letters, so a check on string length would let through a name the
  // firmware then refuses - and this project's own language makes that the
  // common case, not an edge one.
  const twenty = 'S'.repeat(20).replace(/S/g, 'Ş')
  assert.equal(twenty.length, 20)
  assert.equal(new TextEncoder().encode(twenty).length, 40)
  assert.throws(() => tlvText(TLV.wifiSsid, twenty, MAX_SSID_BYTES), /over the 32/)

  const sixteen = twenty.slice(0, 16)
  assert.equal(tlvText(TLV.wifiSsid, sixteen, MAX_SSID_BYTES).value.length, 32)
})

test('a NUL is refused rather than silently truncating the value', () => {
  const withNul = `stu${String.fromCharCode(0)}dio`
  assert.throws(() => tlvText(TLV.wifiSsid, withNul, MAX_SSID_BYTES), /NUL/)
})

test('the WiFi message carries the name, the secret, the switch and a save', () => {
  const frame = wifiControl({ ssid: 'studio', passphrase: 'hunter22', enabled: true })
  const parsed = parseFrame(frame)
  assert.deepEqual(parsed.tlvs.map((t) => t.type), [
    TLV.wifiSsid, TLV.wifiPassphrase, TLV.wifiEnabled, TLV.save, TLV.queryNet
  ])
  assert.equal(String.fromCharCode(...(parsed.tlvs[0]?.value ?? [])), 'studio')
  assert.deepEqual(parsed.tlvs[2]?.value, [1])
})

test('a passphrase too short to associate is refused here, not on the board', () => {
  // WPA2-PSK as ASCII is 8..63; "abc" can never associate. Sending it would
  // give a board that boots, retries forever, and says nothing about why.
  assert.throws(() => wifiControl({ ssid: 'studio', passphrase: 'abc', enabled: true }), /8\.\.63/)
  // Empty is a real answer: an open network.
  assert.ok(wifiControl({ ssid: 'cafe', passphrase: '', enabled: true }))
})

test('a network cannot be joined without a name', () => {
  assert.throws(() => wifiControl({ ssid: '  ', passphrase: 'hunter22', enabled: true }), /without a name/)
  // But clearing it while switching off is exactly how a board is taken off a
  // network, so that has to be allowed.
  assert.ok(wifiControl({ ssid: '', passphrase: '', enabled: false }))
})

test('the query asks for both halves, because they are reported separately', () => {
  assert.deepEqual(parseFrame(queryControl()).tlvs.map((t) => t.type), [TLV.queryConfig, TLV.queryNet])
})

test('an empty message is refused rather than framed', () => {
  assert.throws(() => encodeControl([]), /nothing to send/)
})
