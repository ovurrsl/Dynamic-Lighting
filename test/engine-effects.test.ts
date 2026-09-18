import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ENGINE_CONFIG, resolveLayout, type EngineConfig } from '#lib/engine/config'
import {
  COLOURED_EFFECTS,
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

/** Per-LED brightness, for the effects whose shape is about which LEDs are lit. */
function levelsOf (out: Float32Array): number[] {
  const levels: number[] = []
  for (let i = 0; i < out.length; i += 3) {
    levels.push(Math.max(out[i] as number, out[i + 1] as number, out[i + 2] as number))
  }
  return levels
}

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

// ---------------------------------------------------------------------------
// The four added to fill the categories the first seven left out.
// ---------------------------------------------------------------------------

test('twinkle lights some LEDs and not others, and not all at once', () => {
  // The failure this pins: one shared period makes the whole strip pulse
  // together, which is `breathe` and not twinkle.
  const geometry = GEOMETRY
  const effect = createEffect({ kind: 'twinkle' }, geometry, () => 0)
  const out = allocLedColors(geometry.count)

  let sawSpread = false
  for (const at of [0, 400, 900, 1700, 2600]) {
    effect.render(out, at)
    const levels = levelsOf(out)
    const bright = levels.filter((v) => v > 0.5).length
    const dark = levels.filter((v) => v < 0.05).length
    if (bright > 0 && dark > 0) sawSpread = true
  }
  assert.ok(sawSpread, 'at some instant some LEDs are lit and others are dark')
})

test('fire varies across the strip, not just over time - the property that tells it apart from candle', () => {
  // candle already covers "one flame flickering everywhere at once". If fire
  // only did that too it would not be a second effect, just a recolour.
  const geometry = GEOMETRY
  const effect = createEffect({ kind: 'fire' }, geometry, () => 0)
  const out = allocLedColors(geometry.count)

  let sawSpread = false
  for (const at of [0, 200, 900, 1700, 3300]) {
    effect.render(out, at)
    const levels = levelsOf(out)
    if (Math.max(...levels) - Math.min(...levels) > 0.15) sawSpread = true
  }
  assert.ok(sawSpread, 'at some instant the strip has both hotter and cooler LEDs')
})

test('fire never turns green or blue-dominant - it is a heat ramp, not a hue wheel', () => {
  // A plasma-style hue sweep passes through every colour; a fire has to look
  // like fire at every instant, which rules out reusing `hue()` for this one.
  const geometry = GEOMETRY
  const effect = createEffect({ kind: 'fire' }, geometry, () => 0)
  const out = allocLedColors(geometry.count)

  for (const at of [0, 500, 1500, 4000, 9000]) {
    effect.render(out, at)
    for (let i = 0; i < out.length; i += 3) {
      const r = out[i] as number
      const g = out[i + 1] as number
      const b = out[i + 2] as number
      assert.ok(g <= r + 1e-6, `fire at ${at} had green (${g}) exceed red (${r})`)
      assert.ok(b <= g + 1e-6, `fire at ${at} had blue (${b}) exceed green (${g})`)
    }
  }
})

test('twinkle repeats exactly, because it is seeded', () => {
  // Otherwise "the twinkle looks wrong" and "the twinkle has a bug" cannot be
  // told apart.
  const geometry = GEOMETRY
  const a = createEffect({ kind: 'twinkle' }, geometry, () => 0)
  const b = createEffect({ kind: 'twinkle' }, geometry, () => 0)
  const outA = allocLedColors(geometry.count)
  const outB = allocLedColors(geometry.count)
  a.render(outA, 1234)
  b.render(outB, 1234)
  assert.deepEqual([...outA], [...outB])
})

test('scan follows the SCREEN, not the wire, and bounces rather than wrapping', () => {
  // The difference from the comet is the whole reason it exists: a comet goes
  // round the frame, a scan crosses it. And a bar that reappears on the far
  // side reads as a glitch, because nothing physical does that.
  const geometry = GEOMETRY
  const effect = createEffect({ kind: 'scan' }, geometry, () => 0)
  const out = allocLedColors(geometry.count)

  const brightestX = (ms: number): number => {
    effect.render(out, ms)
    const levels = levelsOf(out)
    let best = 0
    for (let i = 1; i < levels.length; i++) if ((levels[i] as number) > (levels[best] as number)) best = i
    return geometry.centres[best * 2] as number
  }

  // One full sweep takes 1/0.4 = 2.5 s out and 2.5 s back.
  const left = brightestX(100)
  const middle = brightestX(1250)
  const right = brightestX(2400)
  assert.ok(left < middle && middle < right, `it should travel rightwards: ${left} ${middle} ${right}`)
  // On the way back it must pass through the middle again rather than jumping.
  const back = brightestX(3700)
  assert.ok(back < right, 'and come back rather than restarting on the left')
})

test('wipe has an EDGE: at any instant the strip holds two colours, not a gradient', () => {
  const geometry = GEOMETRY
  const effect = createEffect({ kind: 'wipe' }, geometry, () => 0)
  const out = allocLedColors(geometry.count)
  effect.render(out, 2000)

  const seen = new Set<string>()
  for (let i = 0; i < geometry.count; i++) {
    seen.add([...out.slice(i * 3, i * 3 + 3)].map((v) => v.toFixed(4)).join(','))
  }
  assert.equal(seen.size, 2, `two colours and a hard edge, saw ${seen.size}`)
})

test('chase is spaced by LED, not by distance', () => {
  // The look depends on even spacing ON THE STRIP; spacing it in space would
  // break the pattern exactly where two edges have different densities.
  const geometry = GEOMETRY
  const effect = createEffect({ kind: 'chase' }, geometry, () => 0)
  const out = allocLedColors(geometry.count)
  effect.render(out, 0)

  const lit = levelsOf(out).map((v, i) => (v > 0.5 ? i : -1)).filter((i) => i >= 0)
  assert.ok(lit.length > 0, 'something is lit')
  for (let i = 1; i < lit.length; i++) {
    assert.equal((lit[i] as number) - (lit[i - 1] as number), 3, 'every third LED, exactly')
  }
})

test('every listed effect renders without allocating a surprise', () => {
  // A kind in the list that the renderer does not handle would leave the buffer
  // untouched, which on a strip is "the effect did nothing".
  const geometry = GEOMETRY
  const out = allocLedColors(geometry.count)
  for (const kind of EFFECT_KINDS) {
    out.fill(-1)
    createEffect({ kind }, geometry, () => 0).render(out, 500)
    assert.ok([...out].every((v) => v >= 0 && v <= 1), `${kind} wrote valid linear light`)
  }
})

test('COLOURED_EFFECTS is exactly the set whose frames change with spec.color', () => {
  // The panel shows a colour picker for these and only these. The list used to
  // live in the card as a hand copy of three names while six effects read the
  // colour, so twinkle, scan and chase ran in the default orange with no way
  // to change it. Derived here from the renderers themselves.
  const reads: string[] = []
  for (const kind of EFFECT_KINDS) {
    const red = createEffect({ kind, color: { r: 255, g: 0, b: 0 } }, GEOMETRY, () => 0)
    const blue = createEffect({ kind, color: { r: 0, g: 0, b: 255 } }, GEOMETRY, () => 0)
    const a = frame()
    const b = frame()
    let differs = false
    for (const ms of [0, 300, 1200, 5000, 9000]) {
      red.render(a, ms)
      blue.render(b, ms)
      for (let i = 0; i < a.length; i++) if (Math.abs((a[i] as number) - (b[i] as number)) > 1e-6) differs = true
    }
    if (differs) reads.push(kind)
  }
  assert.deepEqual([...reads].sort(), [...COLOURED_EFFECTS].sort())
})
