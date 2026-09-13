import assert from 'node:assert/strict'
import test from 'node:test'

import { REFERENCE_LAYOUT, ledCount } from '#lib/engine/layout'
import {
  AWA_CALIBRATION_SIZE,
  FLETCHER_ESCAPE,
  HEADER_SIZE,
  MAX_LED_COUNT,
  TRAILER_SIZE,
  createFramer,
  decodeFrame,
  fletcher,
  frameSize,
  writeHeader,
  type Protocol
} from '#lib/engine/protocol'
import { allocLedColors, type LedColors } from '#lib/engine/types'
import { encodeAfxPayload, encodeLinear16, encodeLinear8 } from '#lib/light'

const LEDS = ledCount(REFERENCE_LAYOUT)
const PROTOCOLS: readonly Protocol[] = ['ada', 'awa', 'afx']

function prng (seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomColors (count: number, next: () => number): LedColors {
  const colors = allocLedColors(count)
  for (let i = 0; i < colors.length; i++) colors[i] = next()
  return colors
}

function randomBytes (length: number, next: () => number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(next() * 256)
  return bytes
}

/**
 * An independent transcription of LedDeviceAdalight.cpp:165-178, written in
 * a different style from the module (`% 256` instead of a mask, a plain
 * array), with the position width as a parameter so the same function can
 * play the `size_t` rewrite the plan warns about.
 */
function referenceFletcher (payload: ArrayLike<number>, positionBits: 8 | 32): [number, number, number] {
  let f1 = 0
  let f2 = 0
  let ext = 0
  let pos = 0
  for (let i = 0; i < payload.length; i++) {
    const byte = payload[i] as number
    ext = (ext + (byte ^ pos)) % 255
    pos = positionBits === 8 ? (pos + 1) % 256 : pos + 1
    f1 = (f1 + byte) % 255
    f2 = (f2 + f1) % 255
  }
  return [f1, f2, ext === 0x41 ? 0xaa : ext]
}

test('the header is the magic, N-1 big-endian, and hi ^ lo ^ 0x55', () => {
  const header = (protocol: Protocol, count: number, calibrated = false) => {
    const out = new Uint8Array(HEADER_SIZE)
    assert.equal(writeHeader(out, 0, protocol, count, calibrated), HEADER_SIZE)
    return Array.from(out)
  }
  // 108 LEDs: N-1 = 107 = 0x006b, 0x00 ^ 0x6b ^ 0x55 = 0x3e.
  assert.deepEqual(header('ada', LEDS), [0x41, 0x64, 0x61, 0x00, 0x6b, 0x3e])
  assert.deepEqual(header('awa', LEDS), [0x41, 0x77, 0x61, 0x00, 0x6b, 0x3e])
  assert.deepEqual(header('awa', LEDS, true), [0x41, 0x77, 0x41, 0x00, 0x6b, 0x3e])
  assert.deepEqual(header('afx', LEDS), [0x41, 0x66, 0x78, 0x00, 0x6b, 0x3e])
  // The N-1 convention is what keeps 256 LEDs inside a byte pair's low half.
  assert.deepEqual(header('ada', 1).slice(3), [0x00, 0x00, 0x55])
  assert.deepEqual(header('ada', 256).slice(3), [0x00, 0xff, 0xaa])
  assert.deepEqual(header('ada', 257).slice(3), [0x01, 0x00, 0x54])
  assert.deepEqual(header('ada', MAX_LED_COUNT).slice(3), [0xff, 0xff, 0x55])
  // Calibration is an AWA flag; on the others the third byte is the magic.
  assert.deepEqual(header('ada', LEDS, true), header('ada', LEDS))
  assert.deepEqual(header('afx', LEDS, true), header('afx', LEDS))
})

test('108 LEDs is 330 bytes of ADA, 333 of AWA, 337 calibrated, 657 of Afx', () => {
  assert.equal(frameSize('ada', LEDS), 330)
  assert.equal(frameSize('awa', LEDS), 333)
  assert.equal(frameSize('awa', LEDS, true), 337)
  assert.equal(frameSize('afx', LEDS), 657)
  for (const protocol of PROTOCOLS) {
    const framer = createFramer(protocol, LEDS)
    assert.equal(framer.size, frameSize(protocol, LEDS))
    assert.equal(framer.frame(allocLedColors(LEDS)).length, framer.size)
  }
  assert.equal(createFramer('awa', LEDS, { calibration: { limit: 255, red: 255, green: 255, blue: 255 } }).size, 337)
})

test('Fletcher hand vectors', () => {
  const trailer = (...payload: number[]) => Array.from(fletcher(Uint8Array.from(payload)))
  assert.deepEqual(trailer(), [0, 0, 0])
  // Zeros are not a fixed point: the position XOR feeds 0, 1, 2 into ext.
  assert.deepEqual(trailer(0, 0, 0), [0, 0, 3])
  // ext: (1^0) + (2^1) + (3^2) = 1 + 3 + 1 = 5; f1: 1, 3, 6; f2: 1, 4, 10.
  assert.deepEqual(trailer(1, 2, 3), [6, 10, 5])
  // Sums are taken modulo 255, not 256.
  assert.deepEqual(trailer(255), [0, 0, 0])
  assert.deepEqual(trailer(254), [254, 254, 254])
  // f1: 200, 400 % 255 = 145; f2: 200, 345 % 255 = 90; ext: 200, (200 + (200 ^ 1)) % 255 = 146.
  assert.deepEqual(trailer(200, 200), [145, 90, 146])
})

test('only the third byte is escaped away from 0x41; fletcher1 and fletcher2 may be A', () => {
  // A lone 0x41 makes all three sums 0x41. Two survive; the extension is
  // replaced (cpp:176-178).
  assert.deepEqual(Array.from(fletcher(Uint8Array.from([0x41]))), [0x41, 0x41, FLETCHER_ESCAPE])
  assert.equal(FLETCHER_ESCAPE, 0xaa)

  // Over a stream of random payloads the escape fires on about one in 255
  // and the third byte is never 'A' afterwards, while the first two are
  // whatever the sums say.
  const next = prng(41)
  let escaped = 0
  let firstTwoAreA = 0
  for (let round = 0; round < 4000; round++) {
    const payload = randomBytes(1 + Math.floor(next() * 40), next)
    const [f1, f2, ext] = Array.from(fletcher(payload)) as [number, number, number]
    assert.notEqual(ext, 0x41)
    const [, , rawExt] = referenceFletcher(payload, 8)
    if (rawExt === FLETCHER_ESCAPE) {
      // Either a real 0xaa or an escaped 0x41; the reference escapes too, so
      // compare the un-escaped computation directly.
      let raw = 0
      for (let i = 0; i < payload.length; i++) raw = (raw + ((payload[i] as number) ^ (i & 0xff))) % 255
      if (raw === 0x41) escaped++
    }
    if (f1 === 0x41 || f2 === 0x41) firstTwoAreA++
  }
  assert.ok(escaped > 5, `the escape should have fired a handful of times in 4000 frames, fired ${escaped}`)
  assert.ok(firstTwoAreA > 10, `fletcher1/2 should read 0x41 now and then, did ${firstTwoAreA} times`)
})

test('position is a uint8 and wraps at 256, which a 108-LED frame relies on', () => {
  // sum(p ^ 0) for p = 0..255 is 32640 = 128 * 255, so 256 zero bytes leave
  // ext at 0. The 257th byte then adds 0 ^ 0 (wrapped) - or 0 ^ 256 = 1 if
  // the position had kept counting.
  const zeros = new Uint8Array(257)
  assert.deepEqual(Array.from(fletcher(zeros)), [0, 0, 0])
  assert.deepEqual(referenceFletcher(zeros, 8), [0, 0, 0])
  assert.deepEqual(referenceFletcher(zeros, 32), [0, 0, 1])

  // A full 108-LED payload is 324 bytes and crosses the wrap. Against the
  // independent transcription for many random frames, at both widths, so the
  // test is shown to tell them apart.
  const next = prng(256)
  let distinguished = 0
  for (let round = 0; round < 500; round++) {
    const payload = randomBytes(LEDS * 3, next)
    const ours = Array.from(fletcher(payload))
    assert.deepEqual(ours, referenceFletcher(payload, 8))
    if (ours[2] !== referenceFletcher(payload, 32)[2]) distinguished++
  }
  assert.ok(distinguished > 400, `the size_t rewrite should disagree on most frames, disagreed on ${distinguished}`)

  // And across every length up to a 16-bit 108-LED frame.
  for (let length = 0; length <= LEDS * 6; length += 7) {
    const payload = randomBytes(length, next)
    assert.deepEqual(Array.from(fletcher(payload)), referenceFletcher(payload, 8), `length ${length}`)
  }
})

test('the checksum covers the payload only, never the header', () => {
  const frame = createFramer('awa', LEDS).frame(randomColors(LEDS, prng(7)))
  const payloadEnd = HEADER_SIZE + LEDS * 3
  const trailer = Array.from(frame.subarray(payloadEnd, payloadEnd + TRAILER_SIZE))
  assert.deepEqual(Array.from(fletcher(frame, HEADER_SIZE, payloadEnd)), trailer)
  assert.notDeepEqual(Array.from(fletcher(frame, 0, payloadEnd)), trailer)
  // ADA has no trailer at all.
  assert.equal(createFramer('ada', LEDS).size, HEADER_SIZE + LEDS * 3)
})

test('floats go out as the plain encoders would; codes go out untouched', () => {
  const colors = randomColors(LEDS, prng(3))

  const ada = createFramer('ada', LEDS).frame(colors)
  assert.deepEqual(Array.from(ada.subarray(HEADER_SIZE)), Array.from(encodeLinear8(colors)))

  const afx = createFramer('afx', LEDS).frame(colors)
  const payload = afx.subarray(HEADER_SIZE, HEADER_SIZE + LEDS * 6)
  assert.deepEqual(Array.from(payload), Array.from(encodeLinear16(colors)))
  // ... and identical to the control panel's integer encoder.
  const ints = Array.from({ length: LEDS }, (_, i) => ({
    r: Math.round((colors[i * 3] as number) * 65535),
    g: Math.round((colors[i * 3 + 1] as number) * 65535),
    b: Math.round((colors[i * 3 + 2] as number) * 65535)
  }))
  assert.deepEqual(Array.from(payload), Array.from(encodeAfxPayload(ints)))

  // Dithered codes are copied as they are: the framer must not re-round them.
  const codes8 = randomBytes(LEDS * 3, prng(8))
  assert.deepEqual(Array.from(createFramer('awa', LEDS).frame(codes8).subarray(HEADER_SIZE, HEADER_SIZE + LEDS * 3)), Array.from(codes8))
  const codes16 = new Uint16Array(LEDS * 3)
  const next = prng(16)
  for (let i = 0; i < codes16.length; i++) codes16[i] = Math.floor(next() * 65536)
  const out16 = createFramer('afx', LEDS).frame(codes16).subarray(HEADER_SIZE, HEADER_SIZE + LEDS * 6)
  for (let i = 0; i < codes16.length; i++) {
    assert.equal(((out16[i * 2] as number) << 8) | (out16[i * 2 + 1] as number), codes16[i], `code ${i}`)
  }
})

test('every protocol round-trips through the reference decoder', () => {
  const colors = randomColors(LEDS, prng(11))
  const calibration = { limit: 200, red: 255, green: 240, blue: 230 }
  const cases = [
    { framer: createFramer('ada', LEDS), checksumOk: null, calibration: null },
    { framer: createFramer('awa', LEDS), checksumOk: true, calibration: null },
    { framer: createFramer('awa', LEDS, { calibration }), checksumOk: true, calibration },
    { framer: createFramer('afx', LEDS), checksumOk: true, calibration: null }
  ]
  for (const c of cases) {
    const frame = c.framer.frame(colors)
    const decoded = decodeFrame(frame)
    assert.equal(decoded.protocol, c.framer.protocol)
    assert.equal(decoded.count, LEDS)
    assert.equal(decoded.checksumOk, c.checksumOk)
    assert.deepEqual(decoded.calibration, c.calibration)
    const expected = c.framer.protocol === 'afx' ? encodeLinear16(colors) : encodeLinear8(colors)
    assert.deepEqual(Array.from(decoded.payload), Array.from(expected))
  }
})

test('a calibrated AWA frame carries its four bytes after the pixels, inside the checksum', () => {
  const calibration = { limit: 128, red: 255, green: 200, blue: 180 }
  const frame = createFramer('awa', LEDS, { calibration }).frame(allocLedColors(LEDS))
  assert.equal(frame[2], 0x41)
  const payloadEnd = HEADER_SIZE + LEDS * 3
  assert.deepEqual(Array.from(frame.subarray(payloadEnd, payloadEnd + AWA_CALIBRATION_SIZE)), [128, 255, 200, 180])
  const hashedEnd = payloadEnd + AWA_CALIBRATION_SIZE
  assert.deepEqual(Array.from(frame.subarray(hashedEnd)), Array.from(fletcher(frame, HEADER_SIZE, hashedEnd)))
  // Excluding the calibration from the hash gives a different trailer.
  assert.notDeepEqual(Array.from(frame.subarray(hashedEnd)), Array.from(fletcher(frame, HEADER_SIZE, payloadEnd)))
})

test('a corrupted payload byte fails the checksum; a corrupted header or length is rejected outright', () => {
  const framer = createFramer('afx', LEDS)
  const frame = framer.frame(randomColors(LEDS, prng(5)))

  const flipped = Uint8Array.from(frame)
  flipped[HEADER_SIZE + 100] = (flipped[HEADER_SIZE + 100] as number) ^ 0x01
  assert.equal(decodeFrame(flipped).checksumOk, false)

  const badHeader = Uint8Array.from(frame)
  badHeader[5] = (badHeader[5] as number) ^ 0x01
  assert.throws(() => decodeFrame(badHeader), /header checksum/)

  const badMagic = Uint8Array.from(frame)
  badMagic[1] = 0x64 // 'Adx' is nothing
  assert.throws(() => decodeFrame(badMagic), /unknown magic/)

  assert.throws(() => decodeFrame(frame.subarray(0, frame.length - 1)), RangeError)
  assert.throws(() => decodeFrame(frame.subarray(0, 3)), RangeError)
  // Skydimo's broken lookalike header ('A','d','a',0,0,N) fails the XOR.
  assert.throws(() => decodeFrame(Uint8Array.from([0x41, 0x64, 0x61, 0, 0, LEDS, ...new Uint8Array(LEDS * 3)])), RangeError)
})

test('frames into a caller buffer without allocating and returns a view of exactly the frame', () => {
  const framer = createFramer('awa', LEDS)
  const out = new Uint8Array(framer.size + 64)
  const colors = randomColors(LEDS, prng(9))
  const frame = framer.frame(colors, out)
  assert.equal(frame.length, framer.size)
  assert.equal(frame.buffer, out.buffer)
  assert.deepEqual(Array.from(frame), Array.from(framer.frame(colors)))
  // An exact-size buffer comes back as itself.
  const exact = new Uint8Array(framer.size)
  assert.equal(framer.frame(colors, exact), exact)
})

test('rejects nonsense sizes, sources and options', () => {
  assert.throws(() => createFramer('ada', 0), RangeError)
  assert.throws(() => createFramer('ada', 1.5), RangeError)
  assert.throws(() => createFramer('ada', MAX_LED_COUNT + 1), RangeError)
  assert.throws(() => createFramer('lbapa' as Protocol, LEDS), RangeError)
  assert.throws(() => frameSize('afx', -1), RangeError)

  const ada = createFramer('ada', LEDS)
  const afx = createFramer('afx', LEDS)
  assert.throws(() => ada.frame(allocLedColors(LEDS - 1)), RangeError)
  assert.throws(() => ada.frame(new Uint16Array(LEDS * 3)), TypeError)
  assert.throws(() => afx.frame(new Uint8Array(LEDS * 3)), TypeError)
  assert.throws(() => ada.frame([] as unknown as Uint8Array), TypeError)
  assert.throws(() => ada.frame(allocLedColors(LEDS), new Uint8Array(ada.size - 1)), RangeError)

  const calibration = { limit: 255, red: 255, green: 255, blue: 255 }
  assert.throws(() => createFramer('ada', LEDS, { calibration }), RangeError)
  assert.throws(() => createFramer('afx', LEDS, { calibration }), RangeError)
  assert.throws(() => createFramer('awa', LEDS, { calibration: { ...calibration, red: 256 } }), RangeError)
  assert.throws(() => createFramer('awa', LEDS, { calibration: { ...calibration, limit: -1 } }), RangeError)
  assert.throws(() => createFramer('awa', LEDS, { calibration: { ...calibration, blue: 0.5 } }), RangeError)
})
