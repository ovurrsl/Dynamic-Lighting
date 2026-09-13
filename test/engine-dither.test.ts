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
  // The task brief illustrated this as "10,10,11,10,10,11", which would
  // average 10.333; the plan carries the real sequence and this test pins it.
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
  dither.apply(big, out)
  // The hot path must not allocate per frame; the buffer identity is the proof.
  assert.equal(dither.residuals(), before)
  // Three frames of 10.4: 10 (+0.4), 11 (-0.2), 10 (+0.2). A fourth with that
  // residual carried would be 10.6 -> 11; two frames would have left -0.2 and
  // hidden the difference.
  // (10.4/255 is not float32-exact, so the residual is 0.2 to a few 1e-6.)
  assert.ok(before.every((r) => Math.abs(r - 0.2) < 1e-4), `residuals ${Array.from(before.slice(0, 3)).join(', ')}`)

  const small = fillLedColors(allocLedColors(4), 10.4 / 255, 10.4 / 255, 10.4 / 255)
  const smallOut = new Uint8Array(12)
  dither.apply(small, smallOut)
  assert.equal(dither.count, 4)
  assert.equal(dither.residuals().length, 12)
  assert.notEqual(dither.residuals(), before)
  // The first small frame started from zero residual: 10, not the 11 that the
  // carried-over 0.2 would have produced.
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

// ---------------------------------------------------------------------------
// Review: adversarial coverage. Everything below tries to make the dither
// misbehave. Two of these reproduced findings against the module as first
// written (a refused frame that had already resized the residuals, a realm-
// bound output width check); the fixes landed with them.
// ---------------------------------------------------------------------------

/**
 * The formula this module runs, per channel, in the same double-precision
 * operations and the same order, WITHOUT the deadband. Used as an oracle on
 * targets whose fractional part is kept away from every integer, where the
 * deadband can never fire and the two must agree bit for bit - which is what
 * turns "the codes look plausible" into "channel i was computed from channel
 * i's own residual and nothing else".
 */
function referenceChannel (v: number, residual: number, levels: number): { code: number, residual: number } {
  const f = v * levels + residual
  const code = Math.round(f)
  return { code, residual: f - code }
}

test('per-frame target churn: every channel matches an independent oracle bit for bit and its running sum telescopes', () => {
  for (const levels of BOTH_DEPTHS) {
    const next = prng(0xc0ffee + levels)
    const dither = createDither(LEDS, levels)
    const out = outputFor(levels, LEDS * 3)
    const colors = allocLedColors(LEDS)
    const ref = new Float64Array(LEDS * 3)
    const sumOut = new Float64Array(LEDS * 3)
    const sumTarget = new Float64Array(LEDS * 3)
    const N = 3000

    for (let frame = 0; frame < N; frame++) {
      // A new target on every channel every frame, with the fractional part in
      // [0.1, 0.9] so the deadband (eps ~ 8e-3 codes at 16-bit) stays out of
      // the oracle's way even after float32 rounding of the value.
      for (let c = 0; c < colors.length; c++) {
        const k = Math.floor(next() * levels)
        colors[c] = (k + 0.1 + 0.8 * next()) / levels
      }
      dither.apply(colors, out)
      const residual = dither.residuals()
      for (let c = 0; c < colors.length; c++) {
        const v = colors[c] as number
        const expect = referenceChannel(v, ref[c] as number, levels)
        ref[c] = expect.residual
        if (out[c] !== expect.code || residual[c] !== expect.residual) {
          assert.fail(`${levels} levels, frame ${frame}, channel ${c}: code ${out[c]} residual ${residual[c]}, oracle ${expect.code} / ${expect.residual}`)
        }
        sumOut[c] = (sumOut[c] as number) + (out[c] as number)
        sumTarget[c] = (sumTarget[c] as number) + v * levels
      }
    }
    // Telescoping: sum(out) - sum(target) = r_0 - r_N, and r_0 = 0, so the
    // light actually sent never differs from the light asked for by more than
    // half a code, however wildly the target moved.
    for (let c = 0; c < colors.length; c++) {
      const drift = (sumOut[c] as number) - (sumTarget[c] as number)
      assert.ok(Math.abs(drift) <= 0.5 + 1e-6, `${levels} levels, channel ${c}: sent ${drift} codes more than asked over ${N} frames`)
    }
  }
})

test('NaN, both infinities, negative zero, a subnormal and one-ULP overshoots all land in range with a clean residual', () => {
  for (const levels of BOTH_DEPTHS) {
    const colors = new Float32Array([
      Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      -0, 1e-40, Math.fround(1 + 2 ** -23),
      -1e-40, Number.MAX_VALUE, -Number.MAX_VALUE
    ])
    const dither = createDither(3, levels)
    const out = outputFor(levels, 9)
    for (let frame = 0; frame < 100; frame++) {
      dither.apply(colors, out)
      assert.deepEqual(Array.from(out), [0, levels, 0, 0, 0, levels, 0, levels, 0], `${levels} levels, frame ${frame}`)
      for (const r of dither.residuals()) {
        // Not just "in range": the residual of a clamped or zeroed input must be
        // exactly zero, or it would be spent on the next real frame.
        assert.ok(Object.is(r, 0) || Object.is(r, -0), `${levels} levels, frame ${frame}: residual ${r}`)
      }
    }
  }
})

test('the dark end is spread evenly, not bursty: a 0.04-code target lights exactly one frame in every 25', () => {
  // The 8-bit compatibility path is where this module earns its keep - 255
  // levels of linear light band badly in the dark, and a bias light lives in
  // the dark. Error diffusion of a constant is a Bresenham line: the on-frames
  // are as evenly spaced as integers allow, gaps differing by at most one.
  const cases: Array<{ codes: number, gaps: number[] }> = [
    { codes: 0.04, gaps: [25] },          // one `1` every 25 frames, exactly
    { codes: 0.004, gaps: [250] },        // one every 250 - the eye still integrates
    { codes: 0.3, gaps: [3, 4] },
    { codes: 10.4, gaps: [2, 3] }         // the 11s in the plan's own example
  ]
  for (const { codes, gaps } of cases) {
    const colors = fillLedColors(allocLedColors(1), codes / 255, codes / 255, codes / 255)
    const dither = createDither(1, LEVELS_8BIT)
    const out = new Uint8Array(3)
    const high = Math.ceil(codes)
    const onFrames: number[] = []
    const N = 25_000
    let sum = 0
    for (let frame = 0; frame < N; frame++) {
      dither.apply(colors, out)
      const code = out[0] as number
      assert.ok(code === high || code === high - 1, `${codes}: frame ${frame} sent ${code}`)
      if (code === high) onFrames.push(frame)
      sum += code
    }
    const seen = new Set(onFrames.slice(1).map((f, i) => f - (onFrames[i] as number)))
    assert.deepEqual([...seen].sort((a, b) => a - b), gaps, `${codes} codes: gaps between on-frames`)
    assert.ok(Math.abs(sum / N - codes) <= 1 / N + 1e-6, `${codes} codes: mean ${sum / N}`)
  }
})

test('an exact half rounds up, so a half-code target averages exactly one half and a pinned -0.5 residual never drifts', () => {
  // levels = 1 is the degenerate dither: on or off. A target of exactly 0.5
  // (representable in float32, so no deadband) must alternate and average 0.5
  // - not stick on one side the way a truncating quantiser would.
  const one = createDither(1, 1)
  const out = new Uint8Array(3)
  const half = fillLedColors(allocLedColors(1), 0.5, 0.5, 0.5)
  const seen: number[] = []
  for (let frame = 0; frame < 10; frame++) { one.apply(half, out); seen.push(out[0] as number) }
  assert.deepEqual(seen, [1, 0, 1, 0, 1, 0, 1, 0, 1, 0])
  // ... which leaves the residual at exactly -0.5, the closed end of the bound.
  one.apply(half, out)
  assert.equal(one.residuals()[0], -0.5)

  // A -0.5 residual under a zero target is `f = -0.5` every frame: Math.round
  // gives -0, qRound would give -1 then clamp to 0. Either way the code is 0
  // and the residual stays put; the debt is paid on the first frame that has
  // anything to pay it with.
  const black = fillLedColors(allocLedColors(1), 0, 0, 0)
  for (let frame = 0; frame < 100; frame++) {
    one.apply(black, out)
    assert.equal(out[0], 0)
    assert.equal(one.residuals()[0], -0.5)
  }
  one.apply(half, out)
  assert.equal(out[0], 0, 'the owed half is settled by the first half-code frame')
  assert.equal(one.residuals()[0], 0)

  // levels = 2 with a third: 2/3 codes -> 1,0,1 repeating, mean exactly 2/3.
  const two = createDither(1, 2)
  const third = fillLedColors(allocLedColors(1), 1 / 3, 1 / 3, 1 / 3)
  let sum = 0
  for (let frame = 0; frame < 300; frame++) { two.apply(third, out); sum += out[0] as number }
  assert.equal(sum, 200)
})

test('the deadband swallows only what the input cannot express: three float32 ULPs above an exact code still dither', () => {
  // In [0.5, 1) a float32 ULP is 2^-24, i.e. 65535 * 2^-24 ~ 3.9e-3 codes at
  // 16 bits, and the deadband is 65535 * 2^-23: two of them. An exact code's
  // own representation error is at most half a ULP, so an offset of three ULPs
  // is unambiguously signal and must produce k+1 frames at the right rate,
  // while one ULP is indistinguishable from an exact code and is snapped.
  const ULP = 2 ** -24
  const out = new Uint16Array(3)
  for (const k of [32768, 40000, 49151, 65407]) {
    const base = Math.fround(k / LEVELS_16BIT)

    const three = Math.fround(base + 3 * ULP)
    const frac = three * LEVELS_16BIT - k
    assert.ok(frac > 0.009 && frac < 0.014, `k=${k}: three ULPs is ${frac} codes`)
    const dither = createDither(1, LEVELS_16BIT)
    const colors = fillLedColors(allocLedColors(1), three, three, three)
    const N = 4000
    let ups = 0
    for (let frame = 0; frame < N; frame++) {
      dither.apply(colors, out)
      if (out[0] === k + 1) ups++
      else assert.equal(out[0], k, `k=${k}, frame ${frame}`)
    }
    // Bresenham again: floor or ceil of N * frac.
    assert.ok(Math.abs(ups - N * frac) <= 1, `k=${k}: ${ups} k+1 frames in ${N}, expected ${N * frac}`)

    const single = Math.fround(base + ULP)
    const snapped = createDither(1, LEVELS_16BIT)
    fillLedColors(colors, single, single, single)
    for (let frame = 0; frame < N; frame++) {
      snapped.apply(colors, out)
      assert.equal(out[0], k, `k=${k} + 1 ULP, frame ${frame}: representation noise was dithered`)
    }
  }

  // At 8 bits the same boundary, measured from the top: 1 - 2^-24 (one ULP
  // below white) is exact white; 1 - 2^-23 (two ULPs) is 254.99997 and a
  // lone 254 is due after ~16 400 frames. That is the dither doing its job on
  // a value that is genuinely below white, and where such a value comes from
  // (a float32 IIR that stalls short of its target) is the smoother's concern,
  // not the quantiser's. Pinned so a wider deadband cannot creep in as a fix.
  const out8 = new Uint8Array(3)
  const oneUlpBelow = Math.fround(1 - 2 ** -24)
  const exact = createDither(1, LEVELS_8BIT)
  fillLedColors(allocLedColors(1), oneUlpBelow, oneUlpBelow, oneUlpBelow)
  const c8 = fillLedColors(allocLedColors(1), oneUlpBelow, oneUlpBelow, oneUlpBelow)
  for (let frame = 0; frame < 40_000; frame++) {
    exact.apply(c8, out8)
    assert.equal(out8[0], 255, `1 - 2^-24, frame ${frame}`)
  }
  const twoUlpBelow = Math.fround(1 - 2 ** -23)
  const genuine = createDither(1, LEVELS_8BIT)
  fillLedColors(c8, twoUlpBelow, twoUlpBelow, twoUlpBelow)
  let firstDip = -1
  for (let frame = 0; frame < 40_000 && firstDip < 0; frame++) {
    genuine.apply(c8, out8)
    if (out8[0] !== 255) firstDip = frame
  }
  assert.equal(firstDip, 16448, 'the first 254 lands exactly where 0.5 / (255 * 2^-23) says it should')
})

test('a count change zeroes the residual: three frames of 10.4 then a smaller frame sends 10, where a carried residual would send 11', () => {
  // The existing test above runs TWO big frames, after which the residual is
  // -0.2 and a carried-over residual would also have produced 10 - so it could
  // not tell zeroed from carried. Three frames leave +0.2, and 10.4 + 0.2
  // rounds to 11: the control below shows it.
  const big = fillLedColors(allocLedColors(LEDS), 10.4 / 255, 10.4 / 255, 10.4 / 255)
  const small = fillLedColors(allocLedColors(4), 10.4 / 255, 10.4 / 255, 10.4 / 255)
  const out = new Uint8Array(LEDS * 3)

  const control = createDither(4, LEVELS_8BIT)
  for (let frame = 0; frame < 3; frame++) control.apply(small, out)
  assert.ok(Math.abs((control.residuals()[0] as number) - 0.2) < 1e-6)
  control.apply(small, out)
  assert.equal(out[0], 11, 'control: a carried +0.2 residual makes the fourth frame an 11')

  const dither = createDither(LEDS, LEVELS_8BIT)
  for (let frame = 0; frame < 3; frame++) dither.apply(big, out)
  dither.apply(small, out)
  assert.deepEqual(Array.from(out.subarray(0, 12)), Array(12).fill(10))
  assert.ok(dither.residuals().every((r) => Math.abs(r - 0.4) < 1e-6), 'the small frame started from zero')
})

test('a huge frame is quantised in place without a per-frame allocation, and codes beyond the frame are left alone', () => {
  const count = 100_000
  const next = prng(7)
  const colors = randomFrame(count, next)
  const dither = createDither(1, LEVELS_16BIT)
  // Two spare codes past the end, pre-filled, must survive.
  const out = new Uint16Array(count * 3 + 2).fill(0xbeef)

  dither.apply(colors, out)
  const buffer = dither.residuals()
  assert.equal(dither.count, count)
  dither.apply(colors, out)
  assert.equal(dither.residuals(), buffer)
  for (let c = 0; c < count * 3; c++) {
    const code = out[c] as number
    if (code < 0 || code > LEVELS_16BIT) assert.fail(`channel ${c}: ${code}`)
  }
  assert.equal(out[count * 3], 0xbeef)
  assert.equal(out[count * 3 + 1], 0xbeef)

  // A view into a larger buffer is a valid frame: only its own length counts.
  const backing = new Float32Array(3 + 6 + 3)
  const view = backing.subarray(3, 9).fill(0.5)
  const outView = createDither(2, LEVELS_8BIT).apply(view, new Uint8Array(6))
  assert.deepEqual(Array.from(outView), [128, 128, 128, 128, 128, 128])
})

test('an empty frame and nonsense sizes are refused with a RangeError, never a silent no-op with a broken count', () => {
  // A count of zero has no residuals to speak of; the module refuses it at
  // construction and refuses an empty frame in `apply` the same way. (The
  // review notes that `encodeLinear8` accepts an empty frame as a no-op - the
  // two stages disagree on the degenerate case; the dither's choice is at
  // least loud.)
  const dither = createDither(1, LEVELS_8BIT)
  dither.apply(new Float32Array([0.3, 0.3, 0.3]), new Uint8Array(3))
  assert.throws(() => dither.apply(new Float32Array(0), new Uint8Array(0)), RangeError)
  assert.throws(() => dither.reset(Number.NaN), RangeError)
  assert.throws(() => dither.reset(Number.POSITIVE_INFINITY), RangeError)
  assert.throws(() => dither.reset(-1), RangeError)
  assert.throws(() => dither.reset(-0), RangeError)
  assert.throws(() => createDither(Number.NaN, LEVELS_8BIT), RangeError)
  assert.throws(() => createDither(1, Number.NaN), RangeError)
  assert.throws(() => createDither(1, Number.POSITIVE_INFINITY), RangeError)
  // A one-channel or two-channel frame is not a colour frame.
  assert.throws(() => dither.apply(new Float32Array(1), new Uint8Array(1)), RangeError)
  assert.throws(() => dither.apply(new Float32Array(2), new Uint8Array(2)), RangeError)
  // And after all of that the dither is still the 1-LED dither it was.
  assert.equal(dither.count, 1)
  // 0.3 in float32 is 0.30000001192, i.e. 76.500003 codes: rounds to 77 and
  // leaves -0.499997, not -0.5. The expectation is derived the same way.
  const scaled = Math.fround(0.3) * LEVELS_8BIT
  assert.equal(dither.residuals()[0], scaled - Math.round(scaled), 'the residual of the one good frame survived the refusals')
})

test('a refused frame leaves the count and the residuals exactly as they were', () => {
  // Validation must finish before any state changes. Today the count change
  // (reset) runs first, so a frame of a new size handed a too-short or
  // too-narrow output throws AFTER the dither has switched to the new count
  // and dropped the old residuals - no frame of that size was ever written.
  for (const levels of BOTH_DEPTHS) {
    const dither = createDither(4, levels)
    const four = fillLedColors(allocLedColors(4), 10.4 / 255, 10.4 / 255, 10.4 / 255)
    const out = outputFor(levels, 12)
    dither.apply(four, out)
    dither.apply(four, out)
    const buffer = dither.residuals()
    const before = Array.from(buffer)

    const two = fillLedColors(allocLedColors(2), 0.5, 0.5, 0.5)
    assert.throws(() => dither.apply(two, outputFor(levels, 3)), RangeError)
    assert.equal(dither.count, 4, `${levels} levels: count changed on a refused frame`)
    assert.equal(dither.residuals(), buffer, `${levels} levels: residuals reallocated on a refused frame`)
    assert.deepEqual(Array.from(dither.residuals()), before)

    if (levels > 255) {
      assert.throws(() => dither.apply(two, new Uint8Array(6)), RangeError)
      assert.equal(dither.count, 4, 'count changed on a frame refused for output width')
      assert.equal(dither.residuals(), buffer)
    }
  }
})

test('a wide enough output from another realm is accepted', async () => {
  // A typed array created in another realm (an iframe, a vm context) is a
  // Uint16Array in every way that matters - two bytes per element - but fails
  // `instanceof` in this one. `BYTES_PER_ELEMENT` is what the check is about.
  const vm = await import('node:vm')
  const foreign = vm.runInNewContext('new Uint16Array(3)') as Uint16Array
  assert.equal(foreign.BYTES_PER_ELEMENT, 2)
  assert.equal(foreign instanceof Uint16Array, false, 'precondition: the array really is foreign')
  const dither = createDither(1, LEVELS_16BIT)
  dither.apply(new Float32Array([1, 0.5, 0]), foreign)
  assert.deepEqual(Array.from(foreign), [65535, 32768, 0])
})
