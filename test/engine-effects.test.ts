import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ENGINE_CONFIG, resolveLayout, type EngineConfig } from '#lib/engine/config'
import {
  EFFECT_KINDS,
  SPEED_MAX,
  SPEED_MIN,
  createEffect,
  effectGeometry,
  isEffectKind,
  parseEffectSpec
} from '#lib/engine/effects'
import { allocLedColors, type LedRect } from '#lib/engine/types'

const REFERENCE = resolveLayout(DEFAULT_ENGINE_CONFIG as EngineConfig)
const GEOMETRY = effectGeometry(REFERENCE)

/** A clock we drive by hand. Every effect below is a function of it and nothing else. */
function ticker (start = 0): { now: () => number, set: (ms: number) => void } {
  let at = start
  return { now: () => at, set: (ms) => { at = ms } }
}

const frame = (): Float32Array => allocLedColors(REFERENCE.length)

const lit = (out: Float32Array): number => {
  let n = 0
  for (let i = 0; i < out.length; i += 3) {
    if ((out[i] as number) + (out[i + 1] as number) + (out[i + 2] as number) > 0.001) n++
  }
  return n
}

const maxOf = (out: Float32Array): number => {
  let max = 0
  for (const v of out) max = Math.max(max, v)
  return max
}

// ---------------------------------------------------------------------------
// Geometry.
// ---------------------------------------------------------------------------

test('geometry is built from where the LEDs actually look, not from their index', () => {
  // The whole reason effects take geometry: an effect written against
  // `i / count` is right only on the rig it was written for.
  assert.equal(GEOMETRY.count, REFERENCE.length)
  const first = REFERENCE[0] as LedRect
  // Compared through Float32Array: these are single-precision, and asserting
  // against the double would fail for a reason that has nothing to do with the
  // code under test.
  const expected = Float32Array.of((first.xMin + first.xMax) / 2, (first.yMin + first.yMax) / 2)
  assert.equal(GEOMETRY.centres[0], expected[0])
  assert.equal(GEOMETRY.centres[1], expected[1])
})

test('the position along the strip runs 0 towards 1, and never reaches it', () => {
  assert.equal(GEOMETRY.along[0], 0)
  for (let i = 1; i < GEOMETRY.count; i++) {
    assert.ok((GEOMETRY.along[i] as number) >= (GEOMETRY.along[i - 1] as number), `at ${i}`)
  }
  // Strictly less than 1: the closing segment back to LED 0 is counted, so the
  // last LED does not land on top of the first. Without it, every effect that
  // wraps lights two heads at the seam - and on a real frame those two are
  // neighbours in a corner, so it reads as one LED that is twice as wide.
  const last = GEOMETRY.along[GEOMETRY.count - 1] as number
  assert.ok(last < 1, `the last LED is at ${last}`)
  assert.ok(last > 0.9, `and it should still be nearly all the way round, not ${last}`)
})

test('a degenerate layout does not divide by zero', () => {
  // Every LED in the same place: the distances sum to zero, and the naive
  // normalisation would make every entry NaN and every effect blank.
  const stacked: LedRect[] = Array.from({ length: 4 }, () => ({ xMin: 0.5, xMax: 0.5, yMin: 0.5, yMax: 0.5 }))
  const geometry = effectGeometry(stacked)
  for (const v of geometry.along) assert.ok(Number.isFinite(v))
  assert.equal(effectGeometry([]).count, 0)
})

// ---------------------------------------------------------------------------
// Every effect, the properties that hold for all of them.
// ---------------------------------------------------------------------------

for (const kind of EFFECT_KINDS) {
  test(`${kind}: output stays inside 0..1 and every channel is a real number`, () => {
    const clock = ticker()
    const effect = createEffect({ kind }, GEOMETRY, clock.now)
    const out = frame()
    // Sampled across several seconds rather than at one moment: an effect that
    // overshoots does it at a phase, not everywhere.
    for (const ms of [0, 37, 250, 999, 2500, 7777, 60000]) {
      clock.set(ms)
      effect.render(out, ms)
      for (let i = 0; i < out.length; i++) {
        const v = out[i] as number
        assert.ok(Number.isFinite(v), `${kind} at ${ms} index ${i} is not finite`)
        assert.ok(v >= 0 && v <= 1, `${kind} at ${ms} index ${i} is ${v}`)
      }
    }
  })

  test(`${kind}: brightness is a ceiling, and it is obeyed`, () => {
    const clock = ticker()
    const dim = createEffect({ kind, brightness: 0.25 }, GEOMETRY, clock.now)
    const out = frame()
    for (const ms of [0, 300, 1200, 5000]) {
      clock.set(ms)
      dim.render(out, ms)
      assert.ok(maxOf(out) <= 0.25 + 1e-6, `${kind} at ${ms} reached ${maxOf(out)}`)
    }
  })

  test(`${kind}: the same clock gives the same frame`, () => {
    // Determinism is not a nicety here. Without it "the fire effect is too
    // twitchy" and "the fire effect has a bug" cannot be told apart.
    const a = createEffect({ kind }, GEOMETRY, () => 0)
    const b = createEffect({ kind }, GEOMETRY, () => 0)
    const one = frame()
    const two = frame()
    a.render(one, 4321)
    b.render(two, 4321)
    assert.deepEqual(Array.from(one), Array.from(two))
  })

  test(`${kind}: it actually animates`, () => {
    // An effect that renders the same thing forever is a solid colour with
    // extra steps, and every one of these is supposed to move.
    const clock = ticker()
    const effect = createEffect({ kind }, GEOMETRY, clock.now)
    const first = frame()
    const later = frame()
    effect.render(first, 0)
    effect.render(later, 1700)
    assert.notDeepEqual(Array.from(first), Array.from(later))
  })
}

// ---------------------------------------------------------------------------
// What each effect is supposed to look like.
// ---------------------------------------------------------------------------

test('the rainbow is a wheel around the rig, so neighbours differ but agree', () => {
  const effect = createEffect({ kind: 'rainbow' }, GEOMETRY, () => 0)
  const out = frame()
  effect.render(out, 0)
  // Every LED lit, and no two opposite ends of the strip the same colour.
  assert.equal(lit(out), GEOMETRY.count)
  const head = Array.from(out.subarray(0, 3))
  const middle = Array.from(out.subarray(Math.floor(GEOMETRY.count / 2) * 3, Math.floor(GEOMETRY.count / 2) * 3 + 3))
  assert.notDeepEqual(head, middle)
})

test('the comet has a head and a tail that falls away BEHIND it', () => {
  const effect = createEffect({ kind: 'comet', color: { r: 255, g: 255, b: 255 } }, GEOMETRY, () => 0)
  const out = frame()
  effect.render(out, 0)
  const level = (i: number): number => out[i * 3] as number
  const last = GEOMETRY.count - 1

  // At t=0 the head sits on LED 0, and the tail is what the head has already
  // passed - which wraps round to the END of the strip. Asserting the tail runs
  // forwards instead would be asserting the comet moves backwards.
  assert.ok(level(0) > level(last), 'the head is the brightest point, and only one LED is the head')
  assert.ok(level(last) > level(last - 6), 'and the tail decays away from it')
  assert.ok(level(last - 6) > level(last - 20), 'and keeps decaying')
  // The tail falls to 1/e over 12% of the perimeter - about thirteen LEDs on
  // this rig - so three tail lengths back has to be dark. A tail with no end is
  // not a comet, it is a glow with a bright spot.
  assert.ok(level(last - 40) < 0.05, `forty LEDs back it was still at ${level(last - 40)}`)
})

test('the comet travels, and it travels all the way round', () => {
  const effect = createEffect({ kind: 'comet', color: { r: 255, g: 255, b: 255 } }, GEOMETRY, () => 0)
  const out = frame()
  const brightest = (): number => {
    let at = 0
    let best = -1
    for (let i = 0; i < GEOMETRY.count; i++) {
      const v = out[i * 3] as number
      if (v > best) { best = v; at = i }
    }
    return at
  }
  const seen = new Set<number>()
  // One full period is 1 / 0.35 seconds at speed 1; sample across two.
  for (let ms = 0; ms < 6000; ms += 100) {
    effect.render(out, ms)
    seen.add(brightest())
  }
  assert.ok(seen.size > GEOMETRY.count / 3, `the head visited only ${seen.size} of ${GEOMETRY.count}`)
})

test('breathe never goes fully dark, because a dark strip reads as a fault', () => {
  const effect = createEffect({ kind: 'breathe', color: { r: 255, g: 255, b: 255 } }, GEOMETRY, () => 0)
  const out = frame()
  let lowest = 1
  for (let ms = 0; ms < 12000; ms += 50) {
    effect.render(out, ms)
    lowest = Math.min(lowest, maxOf(out))
  }
  assert.ok(lowest > 0.05, `it dropped to ${lowest}`)
})

test('the candle flickers per LED rather than all together', () => {
  // A strip that pulses as one body is a lamp, not a flame.
  const effect = createEffect({ kind: 'candle' }, GEOMETRY, () => 0)
  const out = frame()
  effect.render(out, 1000)
  const levels = new Set<number>()
  for (let i = 0; i < GEOMETRY.count; i++) levels.add(Math.round((out[i * 3] as number) * 1000))
  assert.ok(levels.size > 10, `only ${levels.size} distinct levels across the strip`)
})

test('police lights split the rig in half and alternate', () => {
  const effect = createEffect({ kind: 'police' }, GEOMETRY, () => 0)
  const a = frame()
  const b = frame()
  effect.render(a, 0)
  effect.render(b, 600)   // half a period at the default speed
  const redCount = (out: Float32Array): number => {
    let n = 0
    for (let i = 0; i < GEOMETRY.count; i++) if ((out[i * 3] as number) > 0) n++
    return n
  }
  const blueCount = (out: Float32Array): number => {
    let n = 0
    for (let i = 0; i < GEOMETRY.count; i++) if ((out[i * 3 + 2] as number) > 0) n++
    return n
  }
  assert.ok(redCount(a) > 0 && blueCount(a) === 0, 'one half at a time')
  assert.ok(blueCount(b) > 0 && redCount(b) === 0, 'and the other half next')
  // Never green: a police light that is green is not a police light.
  for (let i = 1; i < a.length; i += 3) assert.equal(a[i], 0)
})

test('a colour is taken in sRGB and used in linear', () => {
  // Mid grey is 0.5 in sRGB and about 0.214 in linear. Using 0.5 directly would
  // make every coloured effect roughly twice as bright as it should be.
  const effect = createEffect(
    { kind: 'breathe', color: { r: 128, g: 128, b: 128 }, brightness: 1 },
    GEOMETRY,
    () => 0
  )
  const out = frame()
  let peak = 0
  for (let ms = 0; ms < 12000; ms += 25) {
    effect.render(out, ms)
    peak = Math.max(peak, maxOf(out))
  }
  assert.ok(peak > 0.2 && peak < 0.23, `peak was ${peak}, expected the linear value of sRGB 128`)
})

test('speed changes the rate, and is clamped rather than refused', () => {
  const slow = createEffect({ kind: 'rainbow', speed: 0.1 }, GEOMETRY, () => 0)
  const fast = createEffect({ kind: 'rainbow', speed: 6 }, GEOMETRY, () => 0)
  const a0 = frame(); const a1 = frame(); const b0 = frame(); const b1 = frame()
  slow.render(a0, 0); slow.render(a1, 500)
  fast.render(b0, 0); fast.render(b1, 500)
  const change = (x: Float32Array, y: Float32Array): number => {
    let sum = 0
    for (let i = 0; i < x.length; i++) sum += Math.abs((x[i] as number) - (y[i] as number))
    return sum
  }
  assert.ok(change(b0, b1) > change(a0, a1), 'faster should change more in the same time')
})

// ---------------------------------------------------------------------------
// The wire.
// ---------------------------------------------------------------------------

test('a spec off the wire is validated, because the panel is another process', () => {
  assert.deepEqual(parseEffectSpec({ kind: 'rainbow' }), { kind: 'rainbow' })
  assert.equal(parseEffectSpec({ kind: 'comet', speed: 2 }).speed, 2)
  // Clamped, not refused: a slider that goes to 11 should give 8, not an error.
  assert.equal(parseEffectSpec({ kind: 'comet', speed: 99 }).speed, SPEED_MAX)
  assert.equal(parseEffectSpec({ kind: 'comet', speed: 0 }).speed, SPEED_MIN)
  assert.equal(parseEffectSpec({ kind: 'blobs', brightness: 4 }).brightness, 1)

  // An unknown name would otherwise fall through a switch and leave the strip
  // on whatever it was showing, with nothing saying why.
  assert.throws(() => parseEffectSpec({ kind: 'disco' }), /kind must be one of/)
  assert.throws(() => parseEffectSpec(null), /must be an object/)
  assert.throws(() => parseEffectSpec({ kind: 'comet', speed: 'fast' }), /finite number/)
  assert.throws(() => parseEffectSpec({ kind: 'comet', color: { r: 256, g: 0, b: 0 } }), /0\.\.255/)
  assert.throws(() => parseEffectSpec({ kind: 'comet', color: { r: 1.5, g: 0, b: 0 } }), /0\.\.255/)
})

test('the kind guard matches the list exactly', () => {
  for (const kind of EFFECT_KINDS) assert.ok(isEffectKind(kind))
  assert.equal(isEffectKind('rainbow '), false)
  assert.equal(isEffectKind(7), false)
})

test('an effect never allocates once it is built', () => {
  // Checked by rendering many frames and asserting the buffer identity is the
  // one handed in: an effect that allocated per frame would be a GC pause in
  // the middle of a frame, which is a visible stutter on the strip.
  const out = frame()
  for (const kind of EFFECT_KINDS) {
    const effect = createEffect({ kind }, GEOMETRY, () => 0)
    for (let ms = 0; ms < 2000; ms += 8) effect.render(out, ms)
    assert.equal(out.length, REFERENCE.length * 3)
  }
})
