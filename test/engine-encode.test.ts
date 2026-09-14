import assert from 'node:assert/strict'
import test from 'node:test'

import { createFrameEncoder } from '#lib/engine/encode'
import { FrameParser, frameSize } from '#lib/engine/protocol'
import { allocLedColors } from '#lib/engine/types'
import { srgbToLinear } from '#lib/light'

/** Every encoder's output must survive the parser the firmware is written against. */
function roundTrip (bytes: Uint8Array): { kind: string, payload: Uint8Array } {
  const parser = new FrameParser()
  const frames = parser.push(bytes)
  assert.equal(frames.length, 1, 'the reference parser took no frame')
  assert.equal(parser.stats.resyncs, 0)
  assert.equal(parser.stats.badChecksum, 0)
  const frame = frames[0] as { kind: string, payload: Uint8Array }
  return frame
}

test('every format produces a frame the reference parser accepts', () => {
  const colors = allocLedColors(108)
  for (let i = 0; i < colors.length; i++) colors[i] = (i % 17) / 16
  for (const format of ['Afx', 'Awa', 'Ada'] as const) {
    const encoder = createFrameEncoder(format, 108)
    const bytes = encoder.encode(colors)
    assert.equal(bytes.length, frameSize(format, 108), format)
    assert.equal(bytes.length, encoder.frameBytes, format)
    assert.equal(roundTrip(bytes).kind, format)
  }
})

test('Afx carries 16-bit precision that 8-bit formats cannot', () => {
  const colors = allocLedColors(1)
  // A value that survives 16-bit rounding and is destroyed by 8-bit.
  colors[0] = 1 / 512
  const afx = createFrameEncoder('Afx', 1).encode(colors)
  const ada = createFrameEncoder('Ada', 1).encode(colors)
  const afxPayload = roundTrip(afx).payload
  const adaPayload = roundTrip(ada).payload
  // 1/512 * 65535 = 128; 1/512 * 255 = 0.498 -> 0.
  assert.equal((afxPayload[0] as number) << 8 | (afxPayload[1] as number), 128)
  assert.equal(adaPayload[0], 0)
})

test('Awa and Ada carry LINEAR bytes, not sRGB ones', () => {
  /*
   * The decision this asserts: an Adalight sketch writes the byte straight to
   * its LED library and a WS2812's brightness follows PWM duty, so the byte
   * must be the linear value. Gamma-encoding here would be applied a second
   * time by the physics.
   */
  const colors = allocLedColors(1)
  colors[0] = 0.5
  for (const format of ['Awa', 'Ada'] as const) {
    const payload = roundTrip(createFrameEncoder(format, 1).encode(colors)).payload
    assert.equal(payload[0], 128, `${format} did not send linear 0.5`)
    // What it would have been with an sRGB encode, spelled out so a future
    // "fix" that adds gamma fails here rather than on someone's desk.
    assert.notEqual(payload[0], Math.round(Math.sqrt(0.5) * 255))
  }
  // And the inverse direction is what the ramp pattern relies on.
  colors[0] = srgbToLinear(0.5)
  assert.equal(roundTrip(createFrameEncoder('Ada', 1).encode(colors)).payload[0], 55)
})

test('the buffer is reused, so the 120 Hz path allocates nothing', () => {
  const encoder = createFrameEncoder('Afx', 8)
  const colors = allocLedColors(8)
  const first = encoder.encode(colors)
  const second = encoder.encode(colors)
  // Same backing store: the view a caller holds is valid only until the next
  // encode, which is exactly as long as a latest-wins writer needs it.
  assert.equal(first.buffer, second.buffer)
})

test('a colour buffer larger than the strip is narrowed, not overrun', () => {
  // The pattern source hands over the engine's scratch buffer, which can be
  // longer than the configured LED count after a layout change.
  const encoder = createFrameEncoder('Afx', 4)
  const big = allocLedColors(64)
  big.fill(1)
  const bytes = encoder.encode(big)
  assert.equal(bytes.length, frameSize('Afx', 4))
  const frame = roundTrip(bytes)
  assert.equal(frame.payload.length, 4 * 6)
})

test('calibration rides on Awa and is refused on the formats that cannot carry it', () => {
  const calibration = { limit: 255, red: 255, green: 240, blue: 220 }
  const encoder = createFrameEncoder('Awa', 4, calibration)
  assert.equal(encoder.frameBytes, frameSize('Awa', 4, true))
  assert.equal(roundTrip(encoder.encode(allocLedColors(4))).kind, 'Awa')

  for (const format of ['Afx', 'Ada'] as const) {
    assert.throws(() => createFrameEncoder(format, 4, calibration), /only carried by Awa/)
  }
})

test('bad arguments are refused at construction', () => {
  assert.throws(() => createFrameEncoder('Afx', 0), /positive integer/)
  assert.throws(() => createFrameEncoder('Afx', 2.5), /positive integer/)
  // @ts-expect-error the guard exists for a value arriving from configuration
  assert.throws(() => createFrameEncoder('Tpm2', 4), /unknown format/)
})

test('a colour buffer too small for the strip throws rather than sending a short frame', () => {
  const encoder = createFrameEncoder('Afx', 8)
  assert.throws(() => encoder.encode(allocLedColors(7)), /needs 24/)
})
