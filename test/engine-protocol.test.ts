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
    // Past the whole magic, not just its first byte: the calibrated magic is
    // 'AwA', whose third byte is the 'A' this search must not reject.
    if (frame.indexOf(A, 3) === -1) return { payload, frame }
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

// ---------------------------------------------------------------------------
// Adversarial: appended by review. Every test here tries to make the module
// misbehave at a boundary the spec makes reachable; the ones that pass stay as
// regression coverage.
// ---------------------------------------------------------------------------

/** Kind, count, payload and calibration of a frame, for cross-run comparison. */
function fingerprint (frame: Frame): string {
  const calibration = frame.calibration === undefined
    ? '-'
    : `${frame.calibration.limit},${frame.calibration.red},${frame.calibration.green},${frame.calibration.blue}`
  return `${frame.kind}:${frame.count}:${calibration}:${Array.from(frame.payload).join(',')}`
}

/** A value that differs from `b` and is never 'A', so a corruption costs exactly one fallback. */
function notThisAndNotMagic (b: number): number {
  return b === 0 ? 1 : 0
}

test('count zero cannot be expressed: count bytes 0,0 are one LED, and every one of the 255 wrong check bytes is a count mismatch', () => {
  // Wire N-1 = 0 is N = 1. A firmware that read the bytes as N would wait for
  // zero pixels and deliver an empty frame; a parser that agrees with the
  // encoder cannot even represent that.
  const oneLed = parseAll(new Uint8Array([A, 0x64, 0x61, 0x00, 0x00, 0x55, 9, 8, 7]))
  assert.equal(oneLed.frames.length, 1)
  assert.equal(oneLed.frames[0]!.count, 1)
  assert.deepEqual(Array.from(oneLed.frames[0]!.payload), [9, 8, 7])

  const next = prng(103)
  const follow = cleanFrame('Awa', 4, next)
  for (const [hi, lo] of [[0x00, 0x00], [0x00, 0x6b], [0x01, 0x00], [0xff, 0xff], [0x12, 0x34]] as const) {
    const right = hi ^ lo ^ 0x55
    for (let chk = 0; chk < 256; chk++) {
      const header = new Uint8Array([A, 0x77, 0x61, hi, lo, chk])
      const { frames, parser } = parseAll(concat(header, follow.frame))
      if (chk === right) {
        // The right byte commits the parser to a payload it will never fully
        // get here (the follow-up frame is far shorter for most counts), so
        // the only thing to assert is that no mismatch was counted.
        assert.equal(parser.stats.countMismatch, 0, `hi ${hi} lo ${lo} chk ${chk}`)
        continue
      }
      assert.equal(frames.length, 1, `hi ${hi} lo ${lo} chk ${chk}`)
      assert.deepEqual(Array.from(frames[0]!.payload), Array.from(follow.payload))
      // A wrong check byte that is 'A' is re-armed as magic, so the frame's
      // own 'A' then fails MAGIC1: two fallbacks, still one mismatch.
      const resyncs = chk === A ? 2 : 1
      assert.deepEqual(parser.stats, { frames: 1, resyncs, badChecksum: 0, countMismatch: 1 }, `hi ${hi} lo ${lo} chk ${chk}`)
    }
  }
})

test("a legitimate 'A' in the count bytes or the check byte is not taken for magic", () => {
  // hi ^ lo ^ 0x55 == 0x41 when hi ^ lo == 0x14; lo == 0x41 at N = 66;
  // hi == 0x41 at N = 0x4100 + 1; both at N = 0x4141 + 1 with check 0x55.
  const cases: Array<[number, number[]]> = [
    [21, [0x00, 0x14, A]],
    [66, [0x00, A, A ^ 0x55]],
    [0x4100 + 1, [A, 0x00, A ^ 0x55]],
    [0x4141 + 1, [A, A, 0x55]]
  ]
  const next = prng(107)
  for (const [count, tail] of cases) {
    for (const kind of ['Ada', 'Awa', 'Afx'] as const) {
      const payload = randomBytes(count * BYTES_PER_LED[kind], next)
      const frame = kind === 'Ada' ? encodeAda(payload) : kind === 'Awa' ? encodeAwa(payload) : encodeAfx(payload)
      assert.deepEqual(Array.from(frame.subarray(3, HEADER_SIZE)), tail, `${kind} x${count}`)
      const { frames, parser } = parseAll(concat(frame, frame))
      assert.equal(frames.length, 2, `${kind} x${count}`)
      assert.equal(frames[1]!.count, count)
      assert.deepEqual(Array.from(frames[1]!.payload), Array.from(payload))
      assert.deepEqual(parser.stats, { frames: 2, resyncs: 0, badChecksum: 0, countMismatch: 0 }, `${kind} x${count}`)
    }
  }
})

test("a legitimate 'A' in the first or second trailer byte is accepted without a resync, and the third is never 'A' on the wire", () => {
  const f1 = findPayload(9, 109, (r) => r.f1 === A && r.f2 !== A)
  const f2 = findPayload(9, 113, (r) => r.f2 === A && r.f1 !== A)
  const both = findPayload(12, 127, (r) => r.f1 === A && r.f2 === A)
  for (const payload of [f1, f2, both]) {
    const frame = encodeAwa(payload)
    // Back to back with a second frame: the trailer's 'A' is immediately
    // followed by a real magic 'A', the one arrangement that would show a
    // parser peeking at trailer bytes as magic.
    const { frames, parser } = parseAll(concat(frame, frame))
    assert.equal(frames.length, 2)
    assert.deepEqual(Array.from(frames[0]!.payload), Array.from(payload))
    assert.deepEqual(Array.from(frames[1]!.payload), Array.from(payload))
    assert.deepEqual(parser.stats, { frames: 2, resyncs: 0, badChecksum: 0, countMismatch: 0 })
  }
  assert.equal(fletcherAwa(both)[0], A)
  assert.equal(fletcherAwa(both)[1], A)

  const next = prng(131)
  let escaped = 0
  for (let round = 0; round < 20_000; round++) {
    const payload = randomBytes(3 + Math.floor(next() * 30) * 3, next)
    const wire = fletcherAwa(payload)
    assert.notEqual(wire[2], A)
    if (referenceFletcher(payload).rawExt === A) {
      escaped++
      assert.equal(wire[2], 0xaa)
    }
  }
  assert.ok(escaped > 0, 'the search must have met a raw 0x41 to prove the escape')
})

test('each trailer byte corrupted on its own drops the frame exactly once, and the next frame is recovered', () => {
  const next = prng(137)
  const first = cleanFrame('Awa', LEDS, next)
  const second = cleanFrame('Afx', LEDS, next)
  const calibrated = cleanFrame('Awa', LEDS, next, { limit: 3, red: 5, green: 7, blue: 9 })
  for (const { frame } of [first, calibrated]) {
    for (let k = 1; k <= TRAILER_SIZE; k++) {
      const damaged = frame.slice()
      const at = damaged.length - k
      damaged[at] = notThisAndNotMagic(damaged[at] as number)
      const { frames, parser } = parseAll(concat(damaged, second.frame))
      assert.equal(frames.length, 1, `trailer byte -${k}`)
      assert.equal(frames[0]!.kind, 'Afx')
      assert.deepEqual(Array.from(frames[0]!.payload), Array.from(second.payload))
      assert.deepEqual(parser.stats, { frames: 1, resyncs: 1, badChecksum: 1, countMismatch: 0 }, `trailer byte -${k}`)
    }
  }
})

test("a check byte or trailer byte corrupted INTO 'A' becomes the next frame's magic: its remaining bytes complete a frame", () => {
  // The resync rule in its purest form. The failing byte is 'A'; what follows
  // is a frame minus its own leading 'A'. Dropping the failing byte would lose
  // that frame; re-evaluating it recovers it.
  const next = prng(139)
  const first = cleanFrame('Awa', LEDS, next)
  const second = cleanFrame('Awa', LEDS, next)
  const headless = second.frame.subarray(1)

  const badCheck = first.frame.slice(0, HEADER_SIZE)
  assert.notEqual(badCheck[5], A, 'precondition')
  badCheck[5] = A
  const viaCheck = parseAll(concat(badCheck, headless))
  assert.equal(viaCheck.frames.length, 1)
  assert.deepEqual(Array.from(viaCheck.frames[0]!.payload), Array.from(second.payload))
  assert.deepEqual(viaCheck.parser.stats, { frames: 1, resyncs: 1, badChecksum: 0, countMismatch: 1 })

  for (let k = 1; k <= TRAILER_SIZE; k++) {
    const damaged = first.frame.slice(0, first.frame.length - k + 1)
    const at = damaged.length - 1
    assert.notEqual(damaged[at], A, 'precondition: cleanFrame has no A past the magic')
    damaged[at] = A
    const { frames, parser } = parseAll(concat(damaged, headless))
    assert.equal(frames.length, 1, `trailer byte ${k}`)
    assert.deepEqual(Array.from(frames[0]!.payload), Array.from(second.payload))
    assert.deepEqual(parser.stats, { frames: 1, resyncs: 1, badChecksum: 1, countMismatch: 0 }, `trailer byte ${k}`)
  }
})

test('every second and third magic byte value: the accepted ones proceed, every other costs one fallback, and the frame after is always recovered', () => {
  const next = prng(149)
  const first = cleanFrame('Awa', LEDS, next)
  const second = cleanFrame('Awa', LEDS, next)
  const stream = concat(first.frame, second.frame)

  // After 'A': 'd', 'w', 'f' open a kind. 'w' then swallows the frame's own
  // 'A' as the calibration flag (documented cost); 'd' and 'f' reject it and
  // re-arm. Anything else falls back on that byte, 'A' itself staying armed
  // so the frame's 'A' then fails MAGIC1 too.
  for (let b = 0; b < 256; b++) {
    const { frames, parser } = parseAll(concat(new Uint8Array([A, b]), stream))
    const expected = b === 0x77
      ? { frames: 1, resyncs: 1, badChecksum: 0, countMismatch: 1 }
      : b === 0x64 || b === 0x66
        ? { frames: 2, resyncs: 1, badChecksum: 0, countMismatch: 0 }
        : b === A
          ? { frames: 2, resyncs: 2, badChecksum: 0, countMismatch: 0 }
          : { frames: 2, resyncs: 1, badChecksum: 0, countMismatch: 0 }
    assert.deepEqual(parser.stats, expected, `second byte ${b}`)
    assert.deepEqual(Array.from(frames.at(-1)!.payload), Array.from(second.payload), `second byte ${b}`)
  }

  // After 'Ad' / 'Af' / 'Aw': the one (or, for 'Aw', two) closing bytes take
  // the frame's 'A','w','a' as hi, lo, check and lose the first frame to a
  // count mismatch; every other byte falls back and both frames parse.
  for (const [m1, accepted] of [[0x64, [0x61]], [0x66, [0x78]], [0x77, [0x61, A]]] as const) {
    for (let b = 0; b < 256; b++) {
      const { frames, parser } = parseAll(concat(new Uint8Array([A, m1, b]), stream))
      const expected = (accepted as readonly number[]).includes(b)
        ? { frames: 1, resyncs: 1, badChecksum: 0, countMismatch: 1 }
        : b === A
          ? { frames: 2, resyncs: 2, badChecksum: 0, countMismatch: 0 }
          : { frames: 2, resyncs: 1, badChecksum: 0, countMismatch: 0 }
      assert.deepEqual(parser.stats, expected, `magic ${m1} third byte ${b}`)
      assert.deepEqual(Array.from(frames.at(-1)!.payload), Array.from(second.payload), `magic ${m1} third byte ${b}`)
    }
  }
})

test('the frames and statistics are the same whatever the chunking: every split point, random chunking, one byte at a time, and views at an offset', () => {
  const next = prng(151)
  const calibration: Calibration = { limit: 250, red: 1, green: 128, blue: 255 }
  const a = cleanFrame('Awa', 40, next)
  const b = cleanFrame('Afx', 25, next)
  const c = cleanFrame('Awa', 30, next, calibration)
  const d = cleanFrame('Ada', 20, next)
  const badHeader = a.frame.slice()
  flip(badHeader, 4)
  const badPayload = b.frame.slice()
  flip(badPayload, HEADER_SIZE + 3)
  const truncated = c.frame.subarray(0, c.frame.length - 7)
  const noise = randomBytes(64, next).map((v) => (v === A ? 0x00 : v))
  // Stray 'A's, a bad header, a bad payload, a truncation that swallows the
  // start of the next frame, a trailer-less Ada, noise: every parser state
  // is entered and left at least once, so a split can land anywhere.
  const stream = concat(
    new Uint8Array([A, A, 0x00]), badHeader, a.frame, badPayload, b.frame, truncated, c.frame,
    noise, d.frame, new Uint8Array([A]), d.frame, noise, c.frame
  )

  const reference = parseAll(stream)
  const wanted = reference.frames.map(fingerprint)
  // a, b, the two d's and the final c: the bad header, the bad payload and
  // the frame the truncation collides with are the three losses. Fallbacks:
  // 'A','A',0x00 cost two, the three losses one each, the stray 'A' one.
  assert.deepEqual(reference.frames.map((f) => f.kind), ['Awa', 'Afx', 'Ada', 'Ada', 'Awa'])
  assert.deepEqual(reference.parser.stats, { frames: 5, resyncs: 6, badChecksum: 2, countMismatch: 1 })
  const check = (frames: Frame[], parser: FrameParser, label: string) => {
    assert.deepEqual(frames.map(fingerprint), wanted, label)
    assert.deepEqual(parser.stats, reference.parser.stats, label)
  }

  for (let split = 0; split <= stream.length; split++) {
    const parser = new FrameParser()
    const frames = [...parser.push(stream.subarray(0, split)), ...parser.push(stream.subarray(split))]
    check(frames, parser, `split ${split}`)
  }

  for (let seed = 0; seed < 40; seed++) {
    const size = prng(1000 + seed)
    const parser = new FrameParser()
    const frames: Frame[] = []
    let at = 0
    while (at < stream.length) {
      const take = 1 + Math.floor(size() * 50)
      frames.push(...parser.push(stream.subarray(at, at + take)))
      at += take
    }
    check(frames, parser, `random chunking ${seed}`)
  }

  const byteWise = new FrameParser()
  const single: Frame[] = []
  for (let i = 0; i < stream.length; i++) single.push(...byteWise.push(stream.subarray(i, i + 1)))
  check(single, byteWise, 'one byte per push')

  // Chunks that are views into a larger buffer with a non-zero byteOffset,
  // the way a serial read buffer hands out its bytes.
  const backing = new Uint8Array(stream.length + 37)
  backing.set(stream, 37)
  const offsetParser = new FrameParser()
  const offsetFrames: Frame[] = []
  for (let at = 0; at < stream.length; at += 13) {
    offsetFrames.push(...offsetParser.push(backing.subarray(37 + at, 37 + Math.min(at + 13, stream.length))))
  }
  check(offsetFrames, offsetParser, 'offset views')
  assert.deepEqual(offsetParser.push(new Uint8Array(0)), [])
})

test('the widest frame round-trips: 65536 LEDs of Afx, whole and in pieces, and the scratch that grew for it does not leak into a small frame after', () => {
  const next = prng(157)
  const payload = randomBytes(MAX_LEDS * 6, next)
  const frame = encodeAfx(payload)
  assert.equal(frame.length, frameSize('Afx', MAX_LEDS))
  assert.deepEqual(Array.from(frame.subarray(3, HEADER_SIZE)), [0xff, 0xff, 0x55])

  const whole = parseAll(frame)
  assert.equal(whole.frames.length, 1)
  assert.equal(whole.frames[0]!.count, MAX_LEDS)
  assert.equal(whole.frames[0]!.payload.length, MAX_LEDS * 6)
  assert.ok(whole.frames[0]!.payload.every((v, i) => v === payload[i]))

  const parser = new FrameParser()
  const pieces: Frame[] = []
  for (let at = 0; at < frame.length; at += 4096) pieces.push(...parser.push(frame.subarray(at, at + 4096)))
  assert.equal(pieces.length, 1)
  assert.ok(pieces[0]!.payload.every((v, i) => v === payload[i]))

  // A one-LED frame through the same parser: exactly three bytes back, none
  // of the 393 KB of scratch behind them.
  const small = parser.push(encodeAwa(new Uint8Array([1, 2, 3]), { limit: 4, red: 5, green: 6, blue: 7 }))
  assert.equal(small.length, 1)
  assert.deepEqual(Array.from(small[0]!.payload), [1, 2, 3])
  assert.deepEqual(small[0]!.calibration, { limit: 4, red: 5, green: 6, blue: 7 })
  assert.deepEqual(parser.stats, { frames: 2, resyncs: 0, badChecksum: 0, countMismatch: 0 })

  // The widest calibrated Awa frame, which is the one that grows the scratch
  // past a round multiple.
  const awa = randomBytes(MAX_LEDS * 3, next)
  const calibrated = parseAll(encodeAwa(awa, { limit: 255, red: 0, green: 255, blue: 0 }))
  assert.equal(calibrated.frames.length, 1)
  assert.equal(calibrated.frames[0]!.payload.length, MAX_LEDS * 3)
  assert.deepEqual(calibrated.frames[0]!.calibration, { limit: 255, red: 0, green: 255, blue: 0 })
})

test("payload bytes are opaque: an all-'A' payload and a whole frame embedded inside a payload are carried without a resync", () => {
  const allMagic = new Uint8Array(LEDS * 3).fill(A)
  const { frames, parser } = parseAll(concat(encodeAwa(allMagic), encodeAfx(new Uint8Array(LEDS * 6).fill(A))))
  assert.equal(frames.length, 2)
  assert.ok(frames[0]!.payload.every((v) => v === A))
  assert.ok(frames[1]!.payload.every((v) => v === A))
  assert.deepEqual(parser.stats, { frames: 2, resyncs: 0, badChecksum: 0, countMismatch: 0 })

  const next = prng(163)
  const inner = encodeAwa(randomBytes(9, next), { limit: 1, red: 2, green: 3, blue: 4 })
  const padding = new Uint8Array((3 - (inner.length % 3)) % 3)
  const outerPayload = concat(inner, padding)
  const outer = parseAll(encodeAfx(concat(outerPayload, new Uint8Array((6 - (outerPayload.length % 6)) % 6))))
  assert.equal(outer.frames.length, 1)
  assert.equal(outer.frames[0]!.kind, 'Afx')
  assert.equal(outer.frames[0]!.calibration, undefined)
  assert.deepEqual(outer.parser.stats, { frames: 1, resyncs: 0, badChecksum: 0, countMismatch: 0 })
})

test('a megabyte of noise neither throws nor leaves the parser stuck, and the statistics invariant holds throughout', () => {
  const next = prng(167)
  const noise = randomBytes(1 << 20, next)
  const parser = new FrameParser()
  let at = 0
  while (at < noise.length) {
    const take = 1 + Math.floor(next() * 64)
    for (const frame of parser.push(noise.subarray(at, at + take))) {
      // Noise may by chance spell a frame; whatever is delivered must still be
      // self-consistent.
      assert.equal(frame.payload.length, frame.count * BYTES_PER_LED[frame.kind])
      assert.ok(frame.count >= 1 && frame.count <= MAX_LEDS)
    }
    at += take
    assert.ok(parser.stats.resyncs >= parser.stats.badChecksum + parser.stats.countMismatch)
  }
  assert.ok(parser.stats.resyncs > 1000, `noise this long must have tripped the magic often (${parser.stats.resyncs})`)

  // Whatever state the noise left the parser in, a valid frame stream must
  // come through once the noise has been flushed by at most one frame's worth
  // of bytes... unless the noise spelt a valid header with a huge count, which
  // is the documented stall (see the next test). With this seed it did not.
  const before = parser.stats.frames
  const { frame, payload } = cleanFrame('Awa', LEDS, next)
  const frames = [...parser.push(frame), ...parser.push(frame)]
  assert.ok(frames.length >= 1)
  assert.deepEqual(Array.from(frames.at(-1)!.payload), Array.from(payload))
  assert.equal(parser.stats.frames, before + frames.length)
})

test('a garbage header that passes its own check commits the parser to the count it announces: six bytes cost 1181 reference-rig frames', () => {
  // 'Afx' with N-1 = 0xffff and a correct check byte is only six bytes of
  // noise, yet it announces 393216 payload bytes plus a trailer. Nothing in
  // the format lets the parser bail out early, so the 393219 bytes that
  // follow are swallowed whatever they are - here 1180.8 valid 333-byte Awa
  // frames, at 120 Hz about ten seconds of darkness from one glitch. Pinned
  // so the cost is visible; a parser ceiling on the count would bound it.
  const parser = new FrameParser()
  const lie = new Uint8Array([A, 0x66, 0x78, 0xff, 0xff, 0x55])
  assert.deepEqual(parser.push(lie), [])
  const next = prng(173)
  const swallowed = Math.ceil((MAX_LEDS * 6 + TRAILER_SIZE) / frameSize('Awa', LEDS))
  assert.equal(swallowed, 1181)
  let delivered = 0
  let firstDeliveredAt = -1
  for (let k = 0; k < 1200; k++) {
    const { frame } = cleanFrame('Awa', LEDS, next)
    const got = parser.push(frame)
    if (got.length > 0 && firstDeliveredAt < 0) firstDeliveredAt = k
    delivered += got.length
  }
  assert.equal(firstDeliveredAt, swallowed)
  assert.equal(delivered, 1200 - swallowed)
  assert.deepEqual(parser.stats, { frames: 1200 - swallowed, resyncs: 1, badChecksum: 1, countMismatch: 0 })
})

test("a swallowed trailer whose expected first byte is 'A' costs the colliding frame as well: the byte-by-byte compare's residual window", () => {
  // The frame that dies before its trailer has, with probability 1/255, a
  // payload whose fletcher1 is 0x41. The next frame's magic 'A' then MATCHES
  // as trailer byte one, its 'w' fails byte two, and the fallback re-evaluates
  // only the 'w' - the matched 'A' is not revisited, so that frame is lost
  // too. The one after is recovered. Pinned as the documented residual cost
  // of comparing byte by byte rather than as a defect.
  const next = prng(179)
  // Not cleanFrame(): its fletcher1 IS the one 'A' this frame must carry, so
  // the search wants exactly one 'A' past the magic, at the trailer.
  let unlucky: { payload: Uint8Array, frame: Uint8Array } | undefined
  while (unlucky === undefined) {
    const payload = randomBytes(LEDS * 3, next)
    const frame = encodeAwa(payload)
    if (frame.indexOf(A, 3) === frame.length - TRAILER_SIZE && frame.indexOf(A, frame.length - TRAILER_SIZE + 1) === -1) unlucky = { payload, frame }
  }
  assert.equal(fletcherAwa(unlucky.payload)[0], A)
  const second = cleanFrame('Awa', LEDS, next)
  const third = cleanFrame('Awa', LEDS, next)
  const truncated = unlucky.frame.subarray(0, unlucky.frame.length - TRAILER_SIZE)
  const { frames, parser } = parseAll(concat(truncated, second.frame, third.frame))
  assert.equal(frames.length, 1)
  assert.deepEqual(Array.from(frames[0]!.payload), Array.from(third.payload))
  assert.deepEqual(parser.stats, { frames: 1, resyncs: 1, badChecksum: 1, countMismatch: 0 })
})

test('the position counter diverges from an unbounded one at exactly byte 256, never before', () => {
  // 256 zero bytes contribute positions 0..255, which sum to 32640 = 128 * 255
  // = 0 (mod 255): the 257th byte is the first whose XOR partner differs
  // (0 vs 256). With b = 0xff: wrapped (0xff ^ 0) = 255 = 0; unbounded
  // (0xff ^ 256) = 511 = 1.
  const at256 = concat(new Uint8Array(256), new Uint8Array([0xff]))
  assert.deepEqual(fletcherAwa(at256), [0, 0, 0])
  assert.equal(referenceFletcher(at256, false).rawExt, 1)

  // One byte shorter and the last position is 255 on both counters.
  const at255 = concat(new Uint8Array(255), new Uint8Array([0xff]))
  assert.deepEqual(fletcherAwa(at255), referenceFletcher(at255, false).wire)
  assert.deepEqual(fletcherAwa(at255), [0, 0, (32385 + (0xff ^ 255)) % 255])

  // Two full wraps: 512 bytes, the counter is back at 0 for byte 512, and
  // the zero bytes before it contributed 2 * 32640 = 0 (mod 255). Unbounded,
  // positions 0..511 sum to 130816 = 1 (mod 255) and the last byte XORs 512:
  // (1 + 513) = 4 (mod 255).
  const at512 = concat(new Uint8Array(512), new Uint8Array([0x01]))
  assert.deepEqual(fletcherAwa(at512), [1, 1, 1])
  assert.equal(referenceFletcher(at512, false).rawExt, 4)
})

test('payload and output views at a non-zero byte offset are framed in place, and Node Buffers are accepted', () => {
  const next = prng(181)
  const colors = allocLedColors(LEDS)
  for (let i = 0; i < colors.length; i++) colors[i] = next()

  // A frame buffer that is itself a window into a bigger ring, as a serial
  // writer would keep.
  const ring = new Uint8Array(4096)
  const at = 1000
  const out = ring.subarray(at, at + frameSize('Awa', LEDS, true))
  const body = out.subarray(HEADER_SIZE, HEADER_SIZE + LEDS * 3)
  encodeLinear8(colors, body)
  const expected = encodeLinear8(colors)
  const calibration: Calibration = { limit: 9, red: 8, green: 7, blue: 6 }
  const frame = encodeAwa(body, calibration, out)
  assert.equal(frame, out)
  assert.deepEqual(Array.from(frame), Array.from(encodeAwa(expected, calibration)))
  assert.ok(ring.subarray(0, at).every((v) => v === 0) && ring.subarray(at + out.length).every((v) => v === 0), 'nothing outside the window was touched')

  const parsed = parseAll(frame)
  assert.equal(parsed.frames.length, 1)
  assert.deepEqual(Array.from(parsed.frames[0]!.payload), Array.from(expected))

  // Buffer is a Uint8Array subclass whose slice() aliases; the module must
  // not rely on slice() copying anything a caller handed in.
  const asBuffer = Buffer.from(expected)
  const fromBuffer = encodeAfx(Buffer.from(encodeLinear16(colors)), Buffer.alloc(frameSize('Afx', LEDS)))
  assert.deepEqual(Array.from(fromBuffer), Array.from(encodeAfx(encodeLinear16(colors))))
  const bufferFrame = encodeAwa(asBuffer)
  const parser = new FrameParser()
  const frames = parser.push(Buffer.from(bufferFrame))
  assert.equal(frames.length, 1)
  bufferFrame.fill(0)
  asBuffer.fill(0)
  assert.deepEqual(Array.from(frames[0]!.payload), Array.from(expected))
})

test('ten thousand frames through one parser and one output buffer: no drift in statistics, no stale bytes', () => {
  const next = prng(191)
  const exact = new Uint8Array(frameSize('Afx', LEDS))
  const colors = allocLedColors(LEDS)
  const parser = new FrameParser()
  let last: Uint8Array = new Uint8Array(0)
  for (let n = 0; n < 10_000; n++) {
    for (let i = 0; i < colors.length; i++) colors[i] = next()
    const body = encodeLinear16(colors, exact.subarray(HEADER_SIZE, HEADER_SIZE + LEDS * 6))
    assert.equal(encodeAfx(body, exact), exact)
    const frames = parser.push(exact)
    assert.equal(frames.length, 1)
    last = frames[0]!.payload
  }
  assert.deepEqual(parser.stats, { frames: 10_000, resyncs: 0, badChecksum: 0, countMismatch: 0 })
  assert.deepEqual(Array.from(last), Array.from(encodeLinear16(colors)))

  // Kinds alternating on the same parser, each with a stray 'A' between them:
  // one resync per stray, never a lost frame.
  const churn = new FrameParser()
  let delivered = 0
  for (let n = 0; n < 300; n++) {
    const kind = (['Ada', 'Awa', 'Afx'] as const)[n % 3]!
    const { frame } = cleanFrame(kind, 1 + (n % 7), next)
    delivered += churn.push(concat(frame, new Uint8Array([A]))).length
  }
  assert.equal(delivered, 300)
  // The last stray 'A' is still a live magic candidate: a fallback is counted
  // only once the byte after it disqualifies it.
  assert.deepEqual(churn.stats, { frames: 300, resyncs: 299, badChecksum: 0, countMismatch: 0 })
  assert.deepEqual(churn.push(new Uint8Array([0x00])), [])
  assert.equal(churn.stats.resyncs, 300)
})
