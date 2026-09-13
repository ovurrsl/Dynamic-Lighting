import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createPattern,
  isPatternKind,
  parsePatternSpec,
  PATTERN_KINDS,
  RAMP_STEPS,
  WIZARD_COLORS
} from '#lib/engine/patterns'
import { srgbToLinear } from '#lib/light'
import { allocLedColors } from '#lib/engine/types'

/** A clock we drive by hand: every assertion below is about a specific instant. */
function stopwatch (): { now: () => number, set: (ms: number) => void } {
  let t = 0
  return { now: () => t, set: (ms) => { t = ms } }
}

const lit = (out: Float32Array): number[] => {
  const on: number[] = []
  for (let i = 0; i < out.length / 3; i++) {
    if ((out[i * 3] ?? 0) > 0 || (out[i * 3 + 1] ?? 0) > 0 || (out[i * 3 + 2] ?? 0) > 0) on.push(i)
  }
  return on
}

test('the walk lights exactly one LED, and it is the one the clock says', () => {
  const clock = stopwatch()
  const out = allocLedColors(108)
  // 5 LEDs per second: index 0 for the first 200 ms, 1 for the next, and so on.
  const pattern = createPattern({ kind: 'walk', ledsPerSecond: 5 }, 108, clock.now)

  for (const [ms, expected] of [[0, 0], [199, 0], [200, 1], [999, 4], [1000, 5], [1400, 7]] as const) {
    clock.set(ms)
    pattern.render(out, clock.now())
    assert.deepEqual(lit(out), [expected], `at ${ms} ms`)
  }
})

test('the walk wraps at the end rather than running off the strip', () => {
  const clock = stopwatch()
  const out = allocLedColors(10)
  const pattern = createPattern({ kind: 'walk', ledsPerSecond: 10 }, 10, clock.now)
  clock.set(1000) // exactly one lap
  pattern.render(out, clock.now())
  assert.deepEqual(lit(out), [0])
  clock.set(1100)
  pattern.render(out, clock.now())
  assert.deepEqual(lit(out), [1])
})

test('the walk is full white, not a dim one', () => {
  // The user is looking for a single LED on a desk, possibly in daylight.
  const clock = stopwatch()
  const out = allocLedColors(4)
  createPattern({ kind: 'walk' }, 4, clock.now).render(out, 0)
  assert.deepEqual([...out.slice(0, 3)], [1, 1, 1])
})

test('solid fills every LED, and the wizard colours are one channel at full scale', () => {
  const clock = stopwatch()
  const out = allocLedColors(3)
  createPattern({ kind: 'solid', color: WIZARD_COLORS.red }, 3, clock.now).render(out, 0)
  assert.deepEqual([...out], [1, 0, 0, 1, 0, 0, 1, 0, 0])

  createPattern({ kind: 'solid', color: WIZARD_COLORS.green }, 3, clock.now).render(out, 0)
  assert.deepEqual([...out], [0, 1, 0, 0, 1, 0, 0, 1, 0])

  // Full scale matters: the wizard asks the user to name a colour, and a dim
  // red against a dim green is exactly the comparison that must not be close.
  for (const colour of Object.values(WIZARD_COLORS)) {
    assert.equal(Math.max(colour.r, colour.g, colour.b), 1)
    assert.equal(colour.r + colour.g + colour.b, 1)
  }
})

test('solid defaults to white', () => {
  const out = allocLedColors(2)
  createPattern({ kind: 'solid' }, 2, () => 0).render(out, 0)
  assert.deepEqual([...out], [1, 1, 1, 1, 1, 1])
})

test('the ramp is monotonic, spans black to white, and steps evenly in sRGB', () => {
  const out = allocLedColors(RAMP_STEPS)
  createPattern({ kind: 'ramp' }, RAMP_STEPS, () => 0).render(out, 0)

  const values = Array.from({ length: RAMP_STEPS }, (_, i) => out[i * 3] ?? -1)
  assert.equal(values[0], 0)
  assert.equal(values[RAMP_STEPS - 1], 1)
  for (let i = 1; i < values.length; i++) {
    assert.ok((values[i] ?? 0) > (values[i - 1] ?? 0), `step ${i} did not rise`)
  }
  // Even in sRGB, NOT in linear: the fault this looks for is a crushed low end,
  // and to see it the steps have to be evenly spaced to the eye.
  for (let i = 0; i < RAMP_STEPS; i++) {
    assert.ok(Math.abs((values[i] ?? 0) - srgbToLinear(i / (RAMP_STEPS - 1))) < 1e-6, `step ${i}`)
  }
  // Which is to say: NOT a straight line in linear light. Spelled out because a
  // future "simplification" to i/20 would look tidier and break the pattern.
  assert.ok(Math.abs((values[10] ?? 0) - 0.5) > 0.2, 'the middle step must not be linear-half')
})

test('a ramp longer than 21 LEDs still shows 21 steps, in order', () => {
  const out = allocLedColors(108)
  createPattern({ kind: 'ramp' }, 108, () => 0).render(out, 0)
  const values = Array.from({ length: 108 }, (_, i) => out[i * 3] ?? -1)
  assert.equal(new Set(values).size, RAMP_STEPS)
  for (let i = 1; i < values.length; i++) {
    assert.ok((values[i] ?? 0) >= (values[i - 1] ?? 0), `LED ${i} went backwards`)
  }
  assert.equal(values[107], 1)
})

test('flash is hard on and hard off, at the rate asked for', () => {
  const clock = stopwatch()
  const out = allocLedColors(2)
  const pattern = createPattern({ kind: 'flash', hz: 1 }, 2, clock.now)
  for (const [ms, on] of [[0, true], [499, true], [500, false], [999, false], [1000, true]] as const) {
    clock.set(ms)
    pattern.render(out, clock.now())
    assert.equal(out[0], on ? 1 : 0, `at ${ms} ms`)
    // No intermediate values anywhere: a 240 fps camera counts edges, and a
    // ramped edge is an edge nobody can count.
    assert.ok(out[0] === 0 || out[0] === 1)
  }
})

test('off is black on every channel', () => {
  const out = allocLedColors(5)
  out.fill(1)
  createPattern({ kind: 'off' }, 5, () => 0).render(out, 0)
  assert.deepEqual([...out], new Array(15).fill(0))
})

test('a clock that runs backwards does not produce a negative index', () => {
  // performance.now() should be monotonic, but the pattern is handed whatever
  // the caller passes, and a negative elapsed would index out of the strip.
  const out = allocLedColors(8)
  const pattern = createPattern({ kind: 'walk' }, 8, () => 5000)
  pattern.render(out, 0)
  assert.deepEqual(lit(out), [0])
})

test('every kind is constructible, and an unknown one is refused', () => {
  const out = allocLedColors(4)
  for (const kind of PATTERN_KINDS) {
    assert.ok(isPatternKind(kind))
    createPattern({ kind }, 4, () => 0).render(out, 0)
  }
  // @ts-expect-error the guard exists for values arriving over a message port
  assert.throws(() => createPattern({ kind: 'rainbow' }, 4, () => 0), /unknown kind/)
  assert.ok(!isPatternKind('rainbow'))
  assert.ok(!isPatternKind(undefined))
})

test('bad arguments are refused at construction, not silently absorbed', () => {
  assert.throws(() => createPattern({ kind: 'walk' }, 0, () => 0), /positive integer/)
  assert.throws(() => createPattern({ kind: 'walk' }, 2.5, () => 0), /positive integer/)
  assert.throws(() => createPattern({ kind: 'walk', ledsPerSecond: 0 }, 4, () => 0), /ledsPerSecond/)
  assert.throws(() => createPattern({ kind: 'flash', hz: -1 }, 4, () => 0), /hz/)
})

test('a buffer too small for the strip throws rather than writing part of a frame', () => {
  const pattern = createPattern({ kind: 'solid' }, 8, () => 0)
  assert.throws(() => pattern.render(allocLedColors(7), 0), /needs 24/)
})

test('a spec from the wire is validated, not trusted', () => {
  assert.deepEqual(parsePatternSpec({ kind: 'walk' }), { kind: 'walk' })
  assert.deepEqual(
    parsePatternSpec({ kind: 'solid', color: { r: 1, g: 0, b: 0 }, ledsPerSecond: 3 }),
    { kind: 'solid', color: { r: 1, g: 0, b: 0 }, ledsPerSecond: 3 }
  )
  // Unknown fields are dropped rather than carried through: the spec that
  // reaches createPattern is the one this function built.
  assert.deepEqual(parsePatternSpec({ kind: 'off', nonsense: true }), { kind: 'off' })

  for (const bad of [
    null, undefined, 'walk', 42,
    { kind: 'rainbow' },
    { kind: 'walk', ledsPerSecond: 0 },
    { kind: 'walk', ledsPerSecond: 'fast' },
    { kind: 'flash', hz: Number.NaN },
    { kind: 'solid', color: { r: 1, g: 0 } },
    { kind: 'solid', color: { r: 2, g: 0, b: 0 } },
    { kind: 'solid', color: { r: -0.1, g: 0, b: 0 } },
    { kind: 'solid', color: 'red' }
  ]) {
    assert.throws(() => parsePatternSpec(bad), `accepted ${JSON.stringify(bad)}`)
  }
})
