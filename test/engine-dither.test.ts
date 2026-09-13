import assert from 'node:assert/strict'
import test from 'node:test'

import { LEVELS_16BIT, LEVELS_8BIT, createDither, type Dither, type DitherOutput } from '#lib/engine/dither'
import { REFERENCE_LAYOUT, ledCount } from '#lib/engine/layout'
import { allocLedColors, fillLedColors, type LedColors } from '#lib/engine/types'
import { encodeLinear16, encodeLinear8 } from '#lib/light'

const LEDS = ledCount(REFERENCE_LAYOUT)
const BOTH_DEPTHS = [LEVELS_8BIT, LEVELS_16BIT] as const

const outputFor = (levels: number, channels: number): DitherOutput =>
  levels > 255 ? new Uint16Array(channels) : new Uint8Array(channels)

/**
 * Deterministic pseudo-random targets (mulberry32). `Math.random` would make a
 * failure unreproducible, which for a bound that must hold on every frame is
 * the same as not testing it.
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

function randomFrame (count: number, next: () => number): LedColors {
  const colors = allocLedColors(count)
  for (let i = 0; i < colors.length; i++) colors[i] = next()
  return colors
}

/**
 * Hyperion's formula verbatim (LinearColorSmoothing.cpp:306-324 with
 * `clampRounded`, cpp:23-25): no input clamp, no representation deadband. The
 * tests for our two departures run this as a control, so that each of them is
 * shown to fail on the original behaviour rather than to pass by accident.
 */
function hyperionDither (scaled: number, residual: number, levels: number): { code: number, residual: number } {
  const f = scaled + residual
  let code = Math.round(f)
  if (code < 0) code = 0
  else if (code > levels) code = levels
  return { code, residual: f - code }
}

test('with no residual the first frame is exactly the plain encoder rounding', () => {
  const next = prng(1)
  const colors = randomFrame(LEDS, next)

  const bytes = encodeLinear8(colors)
  const out8 = createDither(LEDS, LEVELS_8BIT).apply(colors, new Uint8Array(LEDS * 3))
  assert.deepEqual(Array.from(out8), Array.from(bytes))

  // `encodeLinear16` is big-endian bytes; the 16-bit dither is one code per channel.
  const wire = encodeLinear16(colors)
  const out16 = createDither(LEDS, LEVELS_16BIT).apply(colors, new Uint16Array(LEDS * 3))
  for (let i = 0; i < LEDS * 3; i++) {
    assert.equal(out16[i], ((wire[2 * i] as number) << 8) | (wire[2 * i + 1] as number), `channel ${i}`)
  }

  // Returns the buffer it wrote, so the link can chain it into a send.
  const buffer = new Uint8Array(LEDS * 3)
  assert.equal(createDither(LEDS, LEVELS_8BIT).apply(colors, buffer), buffer)
})

test('the time average of the output equals the target to within one code at both bit depths', () => {
  // Two LEDs, six distinct targets: each channel must integrate on its own.
  const targets = [0.3, 10.4 / 255, 1 / 3, 0.7071, 0.999, 1 / 65535 * 7.5]
  const colors = new Float32Array(targets)
  const N = 1000

  for (const levels of BOTH_DEPTHS) {
    const dither = createDither(2, levels)
    const out = outputFor(levels, colors.length)
    const sum = new Float64Array(colors.length)
    for (let frame = 0; frame < N; frame++) {
      dither.apply(colors, out)
      for (let c = 0; c < sum.length; c++) sum[c] = (sum[c] as number) + (out[c] as number)
    }

    for (let c = 0; c < colors.length; c++) {
      const mean = (sum[c] as number) / N
      const scaled = (colors[c] as number) * levels
      // Telescoping: sum(out) = N * scaled + r_0 - r_N with |r| <= 0.5, so the
      // mean is within 1/N code of the target - far inside the one-code bound
      // the plan asks for. The deadband can move `scaled` by at most `eps`.
      const eps = levels * 2 ** -23
      assert.ok(Math.abs(mean - scaled) <= 1 / N + eps + 1e-9,
        `${levels} levels, channel ${c}: mean ${mean} vs target ${scaled}`)
      assert.ok(Math.abs(mean / levels - (colors[c] as number)) <= 1 / levels)
    }
  }
})

test('the residual never leaves [-0.5, 0.5) over ten thousand frames of random targets', () => {
  for (const levels of BOTH_DEPTHS) {
    const dither = createDither(LEDS, levels)
    const out = outputFor(levels, LEDS * 3)
    const next = prng(levels)
    const residual = dither.residuals()
    // Checked after every frame, not just at the end: a residual that wandered
    // out and back would be an error that was spent on the wrong frame. A plain
    // comparison keeps six million checks cheap; the assert is only on failure.
    for (let frame = 0; frame < 10_000; frame++) {
      dither.apply(randomFrame(LEDS, next), out)
      for (let c = 0; c < residual.length; c++) {
        const r = residual[c] as number
        if (!(r >= -0.5 - 1e-12 && r < 0.5 + 1e-12)) {
          assert.fail(`${levels} levels, frame ${frame}, channel ${c}: residual ${r}`)
        }
      }
    }
  }
})

test('a target of 10.4/255 is sent as the five-frame pattern 10,11,10,11,10', () => {
  // Error diffusion of 10.4: residual 0 -> 10 (0.4) -> 11 (-0.2) -> 10 (0.2)
  // -> 11 (-0.4) -> 10 (0.0), then again. Two 11s per five frames is 10.4.
  // The plan's "10,10,11,10,10,11" illustrates the idea; that sequence would
  // average 10.333, and this test pins the sequence the algorithm produces.
  const colors = fillLedColors(allocLedColors(1), 10.4 / 255, 10.4 / 255, 10.4 / 255)
  const dither = createDither(1, LEVELS_8BIT)
  const out = new Uint8Array(3)
  const period = [10, 11, 10, 11, 10]

  const seen: number[] = []
  for (let frame = 0; frame < 1000; frame++) {
    dither.apply(colors, out)
    seen.push(out[0] as number)
    assert.equal(out[1], out[0])
    assert.equal(out[2], out[0])
  }
  assert.deepEqual(seen.slice(0, 20), [...period, ...period, ...period, ...period])
  for (let start = 0; start + 5 <= seen.length; start += 5) {
    const window = seen.slice(start, start + 5)
    assert.equal(window.reduce((a, b) => a + b, 0), 52, `frames ${start}..${start + 4}: ${window.join(',')}`)
  }
})

test('an integer-exact target never flickers, however long it is held', () => {
  // 8-bit: 128/255 has the largest float32 representation error of any 8-bit
  // code (about 7.6e-6 of a code), enough to accumulate to a rogue 129 after
  // ~66 000 frames of the raw formula - nine minutes at 120 Hz on a static
  // colour. Held for 100 000 frames here.
  {
    const colors = fillLedColors(allocLedColors(LEDS), 128 / 255, 128 / 255, 128 / 255)
    const dither = createDither(LEDS, LEVELS_8BIT)
    const out = new Uint8Array(LEDS * 3)
    for (let frame = 0; frame < 100_000; frame++) {
      dither.apply(colors, out)
      for (let c = 0; c < out.length; c++) {
        if (out[c] !== 128) assert.fail(`frame ${frame}, channel ${c}: sent ${out[c]} for an exact 128`)
      }
    }
    assert.ok(dither.residuals().every((r) => r === 0), 'an exact target leaves no residual')
  }

  // 16-bit: every code must go out as itself on the first frame ...
  const ledsOut = new Uint16Array(3)
  const one = allocLedColors(1)
  for (let k = 0; k <= LEVELS_16BIT; k++) {
    fillLedColors(one, k / LEVELS_16BIT, k / LEVELS_16BIT, k / LEVELS_16BIT)
    createDither(1, LEVELS_16BIT).apply(one, ledsOut)
    if (ledsOut[0] !== k) assert.fail(`code ${k} went out as ${ledsOut[0]}`)
  }

  // ... and the code with the worst float32 error must hold for thousands of
  // frames. The control shows the raw formula flickers on it within a few
  // hundred: that is the behaviour this test exists to exclude.
  let worst = { k: 0, error: 0 }
  for (let k = 0; k <= LEVELS_16BIT; k++) {
    const error = Math.abs(Math.fround(k / LEVELS_16BIT) * LEVELS_16BIT - k)
    if (error > worst.error) worst = { k, error }
  }
  assert.ok(worst.error > 1e-3, `expected a code with a large representation error, worst is ${worst.error}`)

  const scaled = Math.fround(worst.k / LEVELS_16BIT) * LEVELS_16BIT
  let control = { code: worst.k, residual: 0 }
  let controlFlickered = false
  for (let frame = 0; frame < 5000 && !controlFlickered; frame++) {
    control = hyperionDither(scaled, control.residual, LEVELS_16BIT)
    controlFlickered = control.code !== worst.k
  }
  assert.ok(controlFlickered, 'control: the raw formula must flicker on this code, or the test proves nothing')

  fillLedColors(one, worst.k / LEVELS_16BIT, worst.k / LEVELS_16BIT, worst.k / LEVELS_16BIT)
  const dither = createDither(1, LEVELS_16BIT)
  for (let frame = 0; frame < 5000; frame++) {
    dither.apply(one, ledsOut)
    if (ledsOut[0] !== worst.k) assert.fail(`frame ${frame}: sent ${ledsOut[0]} for an exact ${worst.k}`)
  }
})

test('reset clears the residuals so the next frame is a plain rounding again', () => {
  const colors = fillLedColors(allocLedColors(LEDS), 10.4 / 255, 0.3, 0.7071)
  const dither = createDither(LEDS, LEVELS_8BIT)
  const out = new Uint8Array(LEDS * 3)

  dither.apply(colors, out)
  dither.apply(colors, out)
  assert.ok(dither.residuals().some((r) => r !== 0), 'two frames of a fractional target leave a residual')

  dither.reset()
  assert.equal(dither.count, LEDS)
  assert.ok(dither.residuals().every((r) => r === 0))

  const fresh = createDither(LEDS, LEVELS_8BIT).apply(colors, new Uint8Array(LEDS * 3))
  assert.deepEqual(Array.from(dither.apply(colors, out)), Array.from(fresh))
})

test('a frame of another size reallocates and zeroes the residuals; the same size reuses the buffer', () => {
  const dither = createDither(LEDS, LEVELS_8BIT)
  const big = fillLedColors(allocLedColors(LEDS), 10.4 / 255, 10.4 / 255, 10.4 / 255)
  const out = new Uint8Array(LEDS * 3)

  const before = dither.residuals()
  dither.apply(big, out)
  dither.apply(big, out)
  // The hot path must not allocate per frame; the buffer identity is the proof.
  assert.equal(dither.residuals(), before)
  assert.ok(before.some((r) => r !== 0))

  const small = fillLedColors(allocLedColors(4), 10.4 / 255, 10.4 / 255, 10.4 / 255)
  const smallOut = new Uint8Array(12)
  dither.apply(small, smallOut)
  assert.equal(dither.count, 4)
  assert.equal(dither.residuals().length, 12)
  assert.notEqual(dither.residuals(), before)
  // The first small frame started from zero residual: 10, not the 11 that the
  // carried-over 0.4 from the big frames would have produced.
  assert.ok(smallOut.every((code) => code === 10))

  dither.reset(2)
  assert.equal(dither.count, 2)
  assert.equal(dither.residuals().length, 6)
  assert.ok(dither.residuals().every((r) => r === 0))
})

test('an out-of-range or NaN input cannot wind the residual up', () => {
  // Control: Hyperion clamps only the rounded code, so one frame of 1.5 leaves
  // half a full scale in the residual and the next in-range target is sent as
  // full white regardless. (Its mean cannot go out of range; ours could.)
  const overshoot = hyperionDither(1.5 * LEVELS_8BIT, 0, LEVELS_8BIT)
  assert.ok(overshoot.residual > 100, `control: raw formula residual ${overshoot.residual}`)
  assert.equal(hyperionDither(0.5 * LEVELS_8BIT, overshoot.residual, LEVELS_8BIT).code, 255)

  for (const levels of BOTH_DEPTHS) {
    const dither = createDither(1, levels)
    const out = outputFor(levels, 3)
    const bad = new Float32Array([1.5, -0.5, Number.NaN])
    for (let frame = 0; frame < 50; frame++) {
      dither.apply(bad, out)
      assert.deepEqual(Array.from(out), [levels, 0, 0])
      for (const r of dither.residuals()) assert.ok(Math.abs(r) <= 0.5 && !Number.isNaN(r), `residual ${r}`)
    }
    // Recovery is immediate: the very next in-range frame is within one code.
    dither.apply(new Float32Array([0.5, 0.5, 0.5]), out)
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs((out[c] as number) - 0.5 * levels) <= 1, `${levels} levels, channel ${c}: ${out[c]}`)
    }
  }
})

test('rejects an output that cannot hold the frame or the codes, and sizes that make no sense', () => {
  const colors = allocLedColors(LEDS)
  const sixteen: Dither = createDither(LEDS, LEVELS_16BIT)
  // 65535 into a Uint8Array would silently become 255 while the residual
  // believed the full code went out.
  assert.throws(() => sixteen.apply(colors, new Uint8Array(LEDS * 3)), RangeError)
  assert.throws(() => sixteen.apply(colors, new Uint16Array(LEDS * 3 - 1)), RangeError)
  assert.throws(() => createDither(LEDS, LEVELS_8BIT).apply(colors, new Uint8Array(LEDS * 3 - 1)), RangeError)
  assert.throws(() => createDither(LEDS, LEVELS_8BIT).apply(new Float32Array(4), new Uint8Array(4)), RangeError)

  assert.throws(() => createDither(0, LEVELS_8BIT), RangeError)
  assert.throws(() => createDither(1.5, LEVELS_8BIT), RangeError)
  assert.throws(() => createDither(LEDS, 0), RangeError)
  assert.throws(() => createDither(LEDS, 2.5), RangeError)
  assert.throws(() => createDither(LEDS, 65536), RangeError)
  assert.throws(() => createDither(LEDS, LEVELS_8BIT).reset(0), RangeError)

  // Any integer level count in range is fine: a 12-bit PWM firmware is 4095.
  const twelve = createDither(1, 4095)
  const out = twelve.apply(new Float32Array([1, 0.5, 0]), new Uint16Array(3))
  assert.deepEqual(Array.from(out), [4095, 2048, 0])
})
