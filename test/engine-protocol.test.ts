import assert from 'node:assert/strict'
import test from 'node:test'

import { REFERENCE_LAYOUT, ledCount } from '#lib/engine/layout'
import {
  BYTES_PER_LED,
  CALIBRATION_SIZE,
  FrameParser,
  HEADER_SIZE,
  MAX_LEDS,
  TRAILER_SIZE,
  encodeAda,
  encodeAfx,
  encodeAwa,
  fletcherAwa,
  frameSize,
  type Calibration,
  type Frame,
  type FrameKind
} from '#lib/engine/protocol'
import { allocLedColors, type LedColors } from '#lib/engine/types'
import { encodeLinear16, encodeLinear8 } from '#lib/light'

const LEDS = ledCount(REFERENCE_LAYOUT)
const A = 0x41

/**
 * Deterministic pseudo-random bytes (mulberry32). A checksum test that cannot
 * be replayed is a checksum test that cannot be debugged.
 */
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

function randomBytes (length: number, next: () => number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(next() * 256)
  return bytes
}

/**
 * The Fletcher trailer written out the straightforward way, independently of
 * the module: the position counter is masked explicitly, and `wrapPosition:
 * false` gives the divergent `size_t` counter the port plan warns about, for
 * the tests that must show we match the wrapping one.
 */
function referenceFletcher (payload: Uint8Array, wrapPosition = true): {
  f1: number, f2: number, rawExt: number, wire: [number, number, number]
} {
  let f1 = 0
  let f2 = 0
  let ext = 0
  let position = 0
  for (const b of payload) {
    ext = (ext + (b ^ position)) % 255
    position = wrapPosition ? (position + 1) & 0xff : position + 1
    f1 = (f1 + b) % 255
    f2 = (f2 + f1) % 255
  }
  return { f1, f2, rawExt: ext, wire: [f1, f2, ext === 0x41 ? 0xaa : ext] }
}

function concat (...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** XOR 1 into one byte: the sum of bytes moves by exactly one, never by a multiple of 255. */
function flip (bytes: Uint8Array, index: number): void {
  bytes[index] = (bytes[index] as number) ^ 0x01
}

function parseAll (bytes: Uint8Array): { frames: Frame[], parser: FrameParser } {
  const parser = new FrameParser()
  return { frames: parser.push(bytes), parser }
}

/**
 * A random payload whose encoded frame contains 'A' nowhere but in its magic,
 * so that after a deliberate fault every byte the parser re-scans is inert
 * and the recovery statistics are exact rather than "at least".
 */
function cleanFrame (kind: FrameKind, count: number, next: () => number, calibration?: Calibration): {
  payload: Uint8Array, frame: Uint8Array
} {
  for (;;) {
    const payload = randomBytes(count * BYTES_PER_LED[kind], next)
    const frame = kind === 'Ada' ? encodeAda(payload) : kind === 'Awa' ? encodeAwa(payload, calibration) : encodeAfx(payload)
    if (frame.indexOf(A, 1) === -1) return { payload, frame }
  }
}

function findPayload (length: number, seed: number, wanted: (r: ReturnType<typeof referenceFletcher>) => boolean): Uint8Array {
  const next = prng(seed)
  for (let tries = 0; tries < 100_000; tries++) {
    const payload = randomBytes(length, next)
    if (wanted(referenceFletcher(payload))) return payload
  }
  throw new Error('no payload satisfies the predicate within the search budget')
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

test('the header carries N-1 big-endian and XORs the two count bytes with 0x55', () => {
  const header = (count: number) => Array.from(encodeAda(new Uint8Array(count * 3)).subarray(0, HEADER_SIZE))

  assert.deepEqual(header(1), [A, 0x64, 0x61, 0x00, 0x00, 0x55])
  assert.deepEqual(header(LEDS), [A, 0x64, 0x61, 0x00, 0x6b, 0x6b ^ 0x55])
  // The off-by-one trap: 256 LEDs is 255 on the wire, which still fits the low
  // byte. A sender that encoded N rather than N-1 would put 1 in hi here -
  // that is Hyperion's LBAPA inconsistency, which we do not carry.
  assert.deepEqual(header(256), [A, 0x64, 0x61, 0x00, 0xff, 0xff ^ 0x55])
  assert.deepEqual(header(257), [A, 0x64, 0x61, 0x01, 0x00, 0x01 ^ 0x55])
  assert.deepEqual(header(MAX_LEDS), [A, 0x64, 0x61, 0xff, 0xff, 0x55])

  // The parser reads the same numbers back, including the widest count.
  for (const count of [1, LEDS, 256, 257, MAX_LEDS]) {
    const { frames } = parseAll(encodeAda(new Uint8Array(count * 3)))
    assert.equal(frames.length, 1)
    assert.equal(frames[0]!.count, count)
  }
})

test('each kind has its own magic and the third Awa byte is the calibration flag', () => {
  const rgb = new Uint8Array(3)
  const calibration: Calibration = { limit: 1, red: 2, green: 3, blue: 4 }
  assert.deepEqual(Array.from(encodeAda(rgb).subarray(0, 3)), [0x41, 0x64, 0x61]) // 'Ada'
  assert.deepEqual(Array.from(encodeAwa(rgb).subarray(0, 3)), [0x41, 0x77, 0x61]) // 'Awa'
  assert.deepEqual(Array.from(encodeAwa(rgb, calibration).subarray(0, 3)), [0x41, 0x77, 0x41]) // 'AwA'
  assert.deepEqual(Array.from(encodeAfx(new Uint8Array(6)).subarray(0, 3)), [0x41, 0x66, 0x78]) // 'Afx'
})

test('frame sizes: Ada has no trailer, Awa and Afx have one, calibration adds four bytes', () => {
  assert.equal(frameSize('Ada', LEDS), HEADER_SIZE + LEDS * 3)
  assert.equal(frameSize('Awa', LEDS), HEADER_SIZE + LEDS * 3 + TRAILER_SIZE)
  assert.equal(frameSize('Awa', LEDS, true), HEADER_SIZE + LEDS * 3 + CALIBRATION_SIZE + TRAILER_SIZE)
  assert.equal(frameSize('Afx', LEDS), HEADER_SIZE + LEDS * 6 + TRAILER_SIZE)
  const next = prng(3)
  assert.equal(encodeAda(randomBytes(LEDS * 3, next)).length, frameSize('Ada', LEDS))
  assert.equal(encodeAwa(randomBytes(LEDS * 3, next)).length, frameSize('Awa', LEDS))
  assert.equal(encodeAwa(randomBytes(LEDS * 3, next), { limit: 0, red: 0, green: 0, blue: 0 }).length, frameSize('Awa', LEDS, true))
  assert.equal(encodeAfx(randomBytes(LEDS * 6, next)).length, frameSize('Afx', LEDS))
})

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

test('Ada, Awa and Afx frames round-trip through the parser for random payloads of many sizes', () => {
  const next = prng(7)
  for (const count of [1, 2, 3, 85, LEDS, 300, 1000]) {
    for (const kind of ['Ada', 'Awa', 'Afx'] as const) {
      const payload = randomBytes(count * BYTES_PER_LED[kind], next)
      const frame = kind === 'Ada' ? encodeAda(payload) : kind === 'Awa' ? encodeAwa(payload) : encodeAfx(payload)
      const { frames, parser } = parseAll(frame)
      assert.equal(frames.length, 1, `${kind} x${count}`)
      const got = frames[0]!
      assert.equal(got.kind, kind)
      assert.equal(got.count, count)
      assert.equal(got.calibration, undefined)
      assert.deepEqual(Array.from(got.payload), Array.from(payload))
      assert.deepEqual(parser.stats, { frames: 1, resyncs: 0, badChecksum: 0, countMismatch: 0 })
    }
  }
})

test('a chunk holding several frames of mixed kinds yields them all, in order', () => {
  const next = prng(11)
  const calibration: Calibration = { limit: 200, red: 255, green: 240, blue: 220 }
  const payloads = {
    ada: randomBytes(LEDS * 3, next),
    awa: randomBytes(LEDS * 3, next),
    awA: randomBytes(LEDS * 3, next),
    afx: randomBytes(LEDS * 6, next)
  }
  const stream = concat(
    encodeAda(payloads.ada),
    encodeAwa(payloads.awa),
    encodeAwa(payloads.awA, calibration),
    encodeAfx(payloads.afx),
    encodeAda(payloads.ada)
  )
  const { frames, parser } = parseAll(stream)
  assert.deepEqual(frames.map((f) => f.kind), ['Ada', 'Awa', 'Awa', 'Afx', 'Ada'])
  assert.deepEqual(frames.map((f) => f.calibration), [undefined, undefined, calibration, undefined, undefined])
  assert.deepEqual(Array.from(frames[2]!.payload), Array.from(payloads.awA))
  assert.deepEqual(Array.from(frames[3]!.payload), Array.from(payloads.afx))
  assert.deepEqual(parser.stats, { frames: 5, resyncs: 0, badChecksum: 0, countMismatch: 0 })
})

test('Afx carries 16-bit linear per channel, which no Hyperion serial protocol can', () => {
  // A linear value that 8 bits cannot represent at all: 0.001 rounds to code
  // 0 on the Awa path and to 66 on the Afx path. The dark end of a linear
  // ramp is where a bias light spends its evenings, so this is not academic.
  const colors: LedColors = allocLedColors(LEDS)
  colors.fill(0.001)
  assert.equal(encodeLinear8(colors)[0], 0)

  const wire = encodeLinear16(colors)
  const frame = encodeAfx(wire)
  const { frames } = parseAll(frame)
  assert.equal(frames.length, 1)
  const got = frames[0]!
  assert.equal(got.kind, 'Afx')
  assert.equal(got.count, LEDS)
  assert.equal(got.payload.length, LEDS * 6)
  assert.deepEqual(Array.from(got.payload), Array.from(wire))
  const code = ((got.payload[0] as number) << 8) | (got.payload[1] as number)
  assert.equal(code, Math.round(0.001 * 65535))
  assert.ok(code > 0)
})

// ---------------------------------------------------------------------------
// Fletcher
// ---------------------------------------------------------------------------

test('Fletcher known-answer vectors by hand and against an independent implementation', () => {
  // By hand: ext = (1^0)+(2^1)+(3^2) = 1+3+1 = 5; f1 = 6; f2 = 1+3+6 = 10.
  assert.deepEqual(fletcherAwa(new Uint8Array([1, 2, 3])), [6, 10, 5])
  // Zero bytes only see the position: ext = 0+1+2.
  assert.deepEqual(fletcherAwa(new Uint8Array([0, 0, 0])), [0, 0, 3])
  assert.deepEqual(fletcherAwa(new Uint8Array(0)), [0, 0, 0])

  const next = prng(13)
  for (const length of [3, 6, 30, 255, 256, 257, 300, LEDS * 3, LEDS * 6, 4096]) {
    for (let round = 0; round < 8; round++) {
      const payload = randomBytes(length, next)
      assert.deepEqual(fletcherAwa(payload), referenceFletcher(payload).wire, `length ${length}`)
    }
  }
})

test('the position counter is a uint8 that wraps at 256: a 108-LED payload crosses it and we match the wrapping sum', () => {
  // With an unbounded counter every byte past position 255 XORs against
  // 256+q instead of q, which adds exactly 256 = 1 (mod 255) per byte. For
  // 324 bytes that is 68 extra: the two checksums differ on EVERY payload of
  // this length, not just an unlucky one, and a receiver with a size_t counter
  // would never accept a single reference-rig frame.
  const extraBytes = LEDS * 3 - 256
  assert.equal(extraBytes, 68)

  const zeros = new Uint8Array(LEDS * 3)
  // Positions 0..255 then 0..67: 32640 + 2278 = 34918 = 238 (mod 255).
  assert.deepEqual(fletcherAwa(zeros), [0, 0, 238])
  // Unbounded: 0..323 sum to 52326 = 51 (mod 255). Not what we produce.
  assert.equal(referenceFletcher(zeros, false).rawExt, 51)
  assert.equal((238 + extraBytes) % 255, 51)

  const next = prng(17)
  for (let round = 0; round < 32; round++) {
    const payload = randomBytes(LEDS * 3, next)
    const wrapping = referenceFletcher(payload, true)
    const unbounded = referenceFletcher(payload, false)
    assert.equal(unbounded.rawExt, (wrapping.rawExt + extraBytes) % 255)
    assert.notEqual(unbounded.rawExt, wrapping.rawExt)
    assert.deepEqual(fletcherAwa(payload), wrapping.wire)
  }

  // Up to 256 bytes the two agree - the divergence is the wrap and only the wrap.
  const short = randomBytes(255, next)
  assert.deepEqual(referenceFletcher(short, false).wire, referenceFletcher(short, true).wire)
})

test('a raw fletcherExt of 0x41 goes on the wire as 0xaa, and only the third trailer byte is ever escaped', () => {
  // Constructed: ext = (0x41^0) + (1^1) + (2^2) = 0x41; f1 = 0x44; f2 = 0xc7.
  const constructed = new Uint8Array([0x41, 0x01, 0x02])
  assert.equal(referenceFletcher(constructed).rawExt, 0x41)
  assert.deepEqual(fletcherAwa(constructed), [0x44, 0xc7, 0xaa])

  // Found: the same on a payload we did not pick by hand.
  const found = findPayload(9, 19, (r) => r.rawExt === 0x41)
  const frame = encodeAwa(found)
  assert.equal(frame[frame.length - 1], 0xaa)
  assert.equal(fletcherAwa(found)[2], 0xaa)

  // fletcher1 == 0x41 is emitted raw: [0x41,0,0] sums to 0x41.
  const rawF1 = new Uint8Array([0x41, 0x00, 0x00])
  assert.equal(referenceFletcher(rawF1).f1, 0x41)
  assert.deepEqual(fletcherAwa(rawF1), [0x41, 0xc3, 0x44])
  const f1Frame = encodeAwa(rawF1)
  assert.equal(f1Frame[f1Frame.length - 3], 0x41)

  // fletcher2 == 0x41 likewise.
  const rawF2 = findPayload(6, 23, (r) => r.f2 === 0x41 && r.rawExt !== 0x41)
  const f2Frame = encodeAwa(rawF2)
  assert.equal(f2Frame[f2Frame.length - 2], 0x41)
  assert.equal(fletcherAwa(rawF2)[1], 0x41)

  // The receiver recomputes rather than decodes, so an escaped 0x41 and a
  // legitimate 0xaa both parse - the escape is not invertible and need not be.
  const legitimateAa = findPayload(6, 29, (r) => r.rawExt === 0xaa)
  for (const payload of [constructed, found, rawF1, rawF2, legitimateAa]) {
    const { frames, parser } = parseAll(encodeAwa(payload))
    assert.equal(frames.length, 1)
    assert.deepEqual(Array.from(frames[0]!.payload), Array.from(payload))
    assert.equal(parser.stats.badChecksum, 0)
  }
})

test('the trailer covers the payload only: the header is outside it', () => {
  const next = prng(31)
  const payload = randomBytes(LEDS * 3, next)
  const frame = encodeAwa(payload)
  const trailer = Array.from(frame.subarray(frame.length - TRAILER_SIZE))
  assert.deepEqual(trailer, fletcherAwa(payload))
  // Had the header been hashed too, the trailer would depend on it.
  assert.notDeepEqual(trailer, fletcherAwa(frame.subarray(0, frame.length - TRAILER_SIZE)))
})

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

test('calibration flips the third magic byte, follows the pixels, and is inside the checksum', () => {
  const next = prng(37)
  const payload = randomBytes(LEDS * 3, next)
  const calibration: Calibration = { limit: 128, red: 255, green: 200, blue: 180 }
  const plain = encodeAwa(payload)
  const frame = encodeAwa(payload, calibration)

  assert.equal(plain[2], 0x61)
  assert.equal(frame[2], 0x41)
  assert.equal(frame.length, plain.length + CALIBRATION_SIZE)

  const at = HEADER_SIZE + payload.length
  assert.deepEqual(Array.from(frame.subarray(at, at + CALIBRATION_SIZE)), [128, 255, 200, 180])

  // The trailer is the checksum of pixels + calibration, not of pixels alone.
  const trailer = Array.from(frame.subarray(frame.length - TRAILER_SIZE))
  assert.deepEqual(trailer, fletcherAwa(concat(payload, new Uint8Array([128, 255, 200, 180]))))
  assert.notDeepEqual(trailer, fletcherAwa(payload))

  const { frames, parser } = parseAll(frame)
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0]!.calibration, calibration)
  assert.deepEqual(Array.from(frames[0]!.payload), Array.from(payload))
  assert.equal(parser.stats.resyncs, 0, "'AwA' is a magic, not a stray 'A'")

  // A flipped calibration byte fails the frame, which is the proof it is hashed.
  const damaged = frame.slice()
  flip(damaged, at + 1)
  const bad = parseAll(damaged)
  assert.equal(bad.frames.length, 0)
  assert.equal(bad.parser.stats.badChecksum, 1)
})

// ---------------------------------------------------------------------------
// Parser: resync, splitting, faults
// ---------------------------------------------------------------------------

test("a stray 'A' before a frame ('AAda...') costs one resync and the frame is recovered", () => {
  const next = prng(41)
  for (const kind of ['Ada', 'Awa', 'Afx'] as const) {
    const { payload, frame } = cleanFrame(kind, LEDS, next)
    const { frames, parser } = parseAll(concat(new Uint8Array([A]), frame))
    assert.equal(frames.length, 1, kind)
    assert.deepEqual(Array.from(frames[0]!.payload), Array.from(payload))
    assert.deepEqual(parser.stats, { frames: 1, resyncs: 1, badChecksum: 0, countMismatch: 0 })
  }
})

test('every partial magic before a frame costs exactly one resync per abandoned attempt', () => {
  const next = prng(43)
  const first = cleanFrame('Awa', LEDS, next)
  const second = cleanFrame('Awa', LEDS, next)
  // prefix -> [frames delivered, resyncs, countMismatch]
  const cases: Array<[string, number, number, number]> = [
    ['A', 2, 1, 0],
    ['AA', 2, 2, 0],
    ['AAA', 2, 3, 0],
    ['Ad', 2, 1, 0], // 'A','d' then the frame's 'A' fails MAGIC2 and restarts there
    ['Af', 2, 1, 0],
    ['AdA', 2, 2, 0], // ... and 'AdA' + 'A' fails MAGIC1 once more
    // 'Aw' is the one prefix a frame's own 'A' can COMPLETE: "AwA" is the
    // calibrated magic, so the parser reads 'w','a' as the count and it is
    // the header check that catches it - after the first frame is lost. The
    // price of a flag byte that is also the magic byte; HyperHDR's design,
    // kept as is, and the second frame shows the recovery.
    ['Aw', 1, 1, 1]
  ]
  for (const [prefix, frames, resyncs, countMismatch] of cases) {
    const bytes = concat(new Uint8Array(prefix.split('').map((c) => c.charCodeAt(0))), first.frame, second.frame)
    const parsed = parseAll(bytes)
    assert.equal(parsed.frames.length, frames, prefix)
    assert.deepEqual(Array.from(parsed.frames.at(-1)!.payload), Array.from(second.payload), prefix)
    assert.deepEqual(parsed.parser.stats, { frames, resyncs, badChecksum: 0, countMismatch }, prefix)
  }
})

test('a frame split across three push() calls at arbitrary boundaries parses exactly once, from the push that completes it', () => {
  const next = prng(47)
  const payload = randomBytes(LEDS * 3, next)
  const calibration: Calibration = { limit: 10, red: 20, green: 30, blue: 40 }
  const frame = encodeAwa(payload, calibration)
  const n = frame.length
  const boundaries: Array<[number, number]> = [
    [1, 2], // inside the magic, twice
    [2, 5], // magic | count | check byte
    [5, 6], // header complete on the third push
    [6, 200], // mid payload
    [200, 330], // mid payload | inside calibration
    [330, 334], // calibration | trailer
    [334, 336], // inside the trailer, twice
    [n - 2, n - 1] // the last two bytes one per push
  ]
  for (const [a, b] of boundaries) {
    const parser = new FrameParser()
    assert.deepEqual(parser.push(frame.subarray(0, a)), [], `${a},${b} first push`)
    assert.deepEqual(parser.push(frame.subarray(a, b)), [], `${a},${b} second push`)
    const frames = parser.push(frame.subarray(b))
    assert.equal(frames.length, 1, `${a},${b} third push`)
    assert.deepEqual(Array.from(frames[0]!.payload), Array.from(payload))
    assert.deepEqual(frames[0]!.calibration, calibration)
    assert.deepEqual(parser.stats, { frames: 1, resyncs: 0, badChecksum: 0, countMismatch: 0 })
  }

  // The degenerate split: one byte per push.
  const parser = new FrameParser()
  const collected: Frame[] = []
  for (let i = 0; i < n; i++) collected.push(...parser.push(frame.subarray(i, i + 1)))
  assert.equal(collected.length, 1)
  assert.deepEqual(Array.from(collected[0]!.payload), Array.from(payload))
})

test('a corrupted header is a count mismatch and the next frame is recovered', () => {
  const next = prng(53)
  const first = cleanFrame('Awa', LEDS, next)
  const second = cleanFrame('Awa', LEDS, next)

  for (const index of [3, 4, 5]) {
    const damaged = first.frame.slice()
    flip(damaged, index)
    const { frames, parser } = parseAll(concat(damaged, second.frame))
    assert.equal(frames.length, 1, `byte ${index}`)
    assert.deepEqual(Array.from(frames[0]!.payload), Array.from(second.payload))
    assert.deepEqual(parser.stats, { frames: 1, resyncs: 1, badChecksum: 0, countMismatch: 1 }, `byte ${index}`)
  }
})

test('a corrupted payload is a bad checksum, the frame is dropped, and the next frame is recovered', () => {
  const next = prng(59)
  const first = cleanFrame('Awa', LEDS, next)
  const second = cleanFrame('Afx', LEDS, next)

  // XOR 1 moves the byte sum by exactly one, so fletcher1 always changes.
  const damaged = first.frame.slice()
  flip(damaged, HEADER_SIZE + 100)
  const { frames, parser } = parseAll(concat(damaged, second.frame))
  assert.equal(frames.length, 1)
  assert.equal(frames[0]!.kind, 'Afx')
  assert.deepEqual(Array.from(frames[0]!.payload), Array.from(second.payload))
  assert.deepEqual(parser.stats, { frames: 1, resyncs: 1, badChecksum: 1, countMismatch: 0 })
})

test('a transmitter dying before the trailer does not swallow the next frame', () => {
  const next = prng(61)
  const first = cleanFrame('Awa', LEDS, next)
  const second = cleanFrame('Awa', LEDS, next)
  const truncated = first.frame.subarray(0, first.frame.length - TRAILER_SIZE)

  // The next frame's 'A' arrives where fletcher1 was expected, fails, and is
  // re-evaluated as magic - the resync rule in the one place it is easiest to
  // forget.
  const { frames, parser } = parseAll(concat(truncated, second.frame))
  assert.equal(frames.length, 1)
  assert.deepEqual(Array.from(frames[0]!.payload), Array.from(second.payload))
  assert.deepEqual(parser.stats, { frames: 1, resyncs: 1, badChecksum: 1, countMismatch: 0 })
})

test('a frame truncated mid-payload costs the frame it collides with and no more', () => {
  const next = prng(67)
  const first = cleanFrame('Awa', LEDS, next)
  const second = cleanFrame('Awa', LEDS, next)
  const third = cleanFrame('Awa', LEDS, next)
  const short = 10
  const truncated = first.frame.subarray(0, first.frame.length - TRAILER_SIZE - short)

  // The parser completes the first payload with the second frame's first ten
  // bytes and then checks the next three against a trailer that cannot match.
  const swallowed = concat(first.payload.subarray(0, first.payload.length - short), second.frame.subarray(0, short))
  assert.notEqual(fletcherAwa(swallowed)[0], second.frame[short], 'precondition: the collision fails on its first trailer byte')

  const { frames, parser } = parseAll(concat(truncated, second.frame, third.frame))
  assert.equal(frames.length, 1)
  assert.deepEqual(Array.from(frames[0]!.payload), Array.from(third.payload))
  assert.deepEqual(parser.stats, { frames: 1, resyncs: 1, badChecksum: 1, countMismatch: 0 })
})

test('Ada frames end at their last pixel and carry no integrity check: back-to-back frames parse, a truncated one is delivered corrupted', () => {
  const next = prng(71)
  const first = cleanFrame('Ada', LEDS, next)
  const second = cleanFrame('Ada', LEDS, next)

  // No trailer to wait for, so the second magic is not eaten as one.
  const good = parseAll(concat(first.frame, second.frame))
  assert.equal(good.frames.length, 2)
  assert.deepEqual(Array.from(good.frames[1]!.payload), Array.from(second.payload))

  // Ten bytes short: the parser cannot know, completes the payload with the
  // next frame's header and pixels, and DELIVERS it. That is the Adalight
  // format as Hyperion ships it, kept for stock sketches, and the reason the
  // extension defaults to Awa or Afx.
  const short = 10
  const truncated = first.frame.subarray(0, first.frame.length - short)
  const bad = parseAll(concat(truncated, second.frame))
  assert.equal(bad.frames.length, 1)
  assert.equal(bad.parser.stats.badChecksum, 0)
  const tail = Array.from(bad.frames[0]!.payload.subarray(first.payload.length - short))
  assert.deepEqual(tail, Array.from(second.frame.subarray(0, short)))
})

test('garbage between frames is skipped; only a garbage byte that looks like magic costs a resync', () => {
  const next = prng(73)
  const first = cleanFrame('Awa', LEDS, next)
  const second = cleanFrame('Afx', LEDS, next)

  // Noise that never spells 'A' is walked over without touching any counter.
  const noise = (length: number) => randomBytes(length, next).map((b) => (b === A ? 0x00 : b))
  const quiet = parseAll(concat(noise(50), first.frame, noise(7), second.frame, noise(200)))
  assert.deepEqual(quiet.frames.map((f) => f.kind), ['Awa', 'Afx'])
  assert.deepEqual(quiet.parser.stats, { frames: 2, resyncs: 0, badChecksum: 0, countMismatch: 0 })

  // 'A',0x00 -> one resync; 'A','A' -> one, staying armed; then 0x99 -> one more.
  const looksLikeMagic = new Uint8Array([0x00, A, 0x00, A, A, 0x99])
  const noisy = parseAll(concat(looksLikeMagic, first.frame, noise(20)))
  assert.equal(noisy.frames.length, 1)
  assert.deepEqual(noisy.parser.stats, { frames: 1, resyncs: 3, badChecksum: 0, countMismatch: 0 })
})

test('resyncs count every abandonment, of which count mismatches and bad checksums are the classified part', () => {
  const next = prng(79)
  const a = cleanFrame('Awa', LEDS, next)
  const b = cleanFrame('Awa', LEDS, next)
  const c = cleanFrame('Awa', LEDS, next)
  const badHeader = a.frame.slice()
  flip(badHeader, 5)
  const badPayload = b.frame.slice()
  flip(badPayload, HEADER_SIZE + 7)

  const { frames, parser } = parseAll(concat(new Uint8Array([A, A]), badHeader, badPayload, c.frame))
  assert.equal(frames.length, 1)
  assert.deepEqual(parser.stats, { frames: 1, resyncs: 4, badChecksum: 1, countMismatch: 1 })
  assert.ok(parser.stats.resyncs >= parser.stats.badChecksum + parser.stats.countMismatch)
})

test('the delivered payload is a copy: neither the pushed chunk nor a later frame can change it', () => {
  const next = prng(83)
  const first = randomBytes(LEDS * 3, next)
  const second = randomBytes(LEDS * 3, next)
  const chunk = concat(encodeAwa(first), encodeAwa(second))

  const parser = new FrameParser()
  const frames = parser.push(chunk)
  chunk.fill(0)
  assert.deepEqual(Array.from(frames[0]!.payload), Array.from(first))
  assert.deepEqual(Array.from(frames[1]!.payload), Array.from(second))
  assert.notEqual(frames[0]!.payload.buffer, frames[1]!.payload.buffer)

  // The parser's scratch is reused; a frame handed out earlier must not see it.
  const third = randomBytes(LEDS * 3, next)
  parser.push(encodeAwa(third))
  assert.deepEqual(Array.from(frames[1]!.payload), Array.from(second))
})

test('reset() returns to hunting for magic without losing the statistics', () => {
  const next = prng(89)
  const { frame, payload } = cleanFrame('Awa', LEDS, next)
  const parser = new FrameParser()
  assert.deepEqual(parser.push(frame.subarray(0, 100)), [])
  parser.reset()
  // The remainder of the abandoned frame is now garbage; the next frame parses.
  const frames = parser.push(concat(frame.subarray(100), frame))
  assert.equal(frames.length, 1)
  assert.deepEqual(Array.from(frames[0]!.payload), Array.from(payload))
  assert.equal(parser.stats.frames, 1)
})

// ---------------------------------------------------------------------------
// Encoder contract
// ---------------------------------------------------------------------------

test('encoders reject payloads that are empty, off-stride, or too many LEDs, and calibration outside a byte', () => {
  assert.throws(() => encodeAda(new Uint8Array(0)), RangeError)
  assert.throws(() => encodeAda(new Uint8Array(4)), RangeError)
  assert.throws(() => encodeAwa(new Uint8Array(5)), RangeError)
  assert.throws(() => encodeAfx(new Uint8Array(3)), RangeError)
  assert.throws(() => encodeAfx(new Uint8Array(9)), RangeError)
  assert.throws(() => encodeAda(new Uint8Array((MAX_LEDS + 1) * 3)), RangeError)
  assert.throws(() => encodeAfx(new Uint8Array((MAX_LEDS + 1) * 6)), RangeError)
  assert.doesNotThrow(() => encodeAwa(new Uint8Array(MAX_LEDS * 3)))

  const rgb = new Uint8Array(3)
  assert.throws(() => encodeAwa(rgb, { limit: 256, red: 0, green: 0, blue: 0 }), RangeError)
  assert.throws(() => encodeAwa(rgb, { limit: 0, red: -1, green: 0, blue: 0 }), RangeError)
  assert.throws(() => encodeAwa(rgb, { limit: 0, red: 0, green: 1.5, blue: 0 }), RangeError)
  assert.throws(() => encodeAwa(rgb, { limit: 0, red: 0, green: 0, blue: NaN }), RangeError)
  assert.doesNotThrow(() => encodeAwa(rgb, { limit: 0, red: 255, green: 0, blue: 255 }))
})

test('an exactly sized output buffer comes back as itself, a larger one as a right-sized view, a smaller one is refused', () => {
  const next = prng(97)
  const payload = randomBytes(LEDS * 3, next)
  const size = frameSize('Awa', LEDS)

  const exact = new Uint8Array(size)
  assert.equal(encodeAwa(payload, undefined, exact), exact)
  assert.deepEqual(Array.from(exact), Array.from(encodeAwa(payload)))

  const larger = new Uint8Array(size + 100)
  const view = encodeAwa(payload, undefined, larger)
  assert.equal(view.length, size)
  assert.equal(view.buffer, larger.buffer)
  assert.deepEqual(Array.from(view), Array.from(encodeAwa(payload)))

  assert.throws(() => encodeAwa(payload, undefined, new Uint8Array(size - 1)), RangeError)
  assert.throws(() => encodeAda(payload, new Uint8Array(HEADER_SIZE + payload.length - 1)), RangeError)
  assert.throws(() => encodeAfx(randomBytes(LEDS * 6, next), new Uint8Array(10)), RangeError)

  // The same buffer serves frame after frame with no allocation in between.
  for (let i = 0; i < 5; i++) {
    const p = randomBytes(LEDS * 3, next)
    assert.equal(encodeAwa(p, undefined, exact), exact)
    const { frames } = parseAll(exact)
    assert.deepEqual(Array.from(frames[0]!.payload), Array.from(p))
  }
})

test('a payload encoded straight into the frame buffer is framed in place', () => {
  const next = prng(101)
  const colors = allocLedColors(LEDS)
  for (let i = 0; i < colors.length; i++) colors[i] = next()

  const out = new Uint8Array(frameSize('Afx', LEDS))
  const body = out.subarray(HEADER_SIZE, HEADER_SIZE + LEDS * 6)
  encodeLinear16(colors, body)
  assert.equal(encodeAfx(body, out), out)

  const { frames } = parseAll(out)
  assert.equal(frames.length, 1)
  assert.deepEqual(Array.from(frames[0]!.payload), Array.from(encodeLinear16(colors)))
})
