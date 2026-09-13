import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ADJUSTMENT_DEFAULTS,
  CUBE_CORNERS,
  IDENTITY_CORNERS,
  backlightFloor,
  brightnessScalars,
  cornerWeights,
  createAdjustment,
  kelvinToLinearRgb,
  kelvinToSrgb,
  linearToOklab,
  oklabGain,
  oklabToLinear,
  parseLedSelector,
  type AdjustmentProfile
} from '#lib/engine/adjust'
import { REFERENCE_LAYOUT, ledCount } from '#lib/engine/layout'
import { allocLedColors, fillLedColors, type LedColors, type LinearRgb } from '#lib/engine/types'
import { srgbToLinear } from '#lib/light'

const COUNT = ledCount(REFERENCE_LAYOUT)

/** mulberry32: a tiny seeded PRNG so "random colours" are the same colours every run. */
function prng (seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomFrame (seed: number, count = COUNT): LedColors {
  const rnd = prng(seed)
  const frame = allocLedColors(count)
  for (let i = 0; i < frame.length; i++) frame[i] = rnd()
  return frame
}

const solid = (r: number, g: number, b: number, count = 1): LedColors =>
  fillLedColors(allocLedColors(count), r, g, b)

const near = (actual: number, expected: number, tolerance: number, message?: string): void =>
  assert.ok(Math.abs(actual - expected) <= tolerance, message ?? `expected ${actual} within ${tolerance} of ${expected}`)

const frameNear = (actual: LedColors, expected: LedColors, tolerance: number, message?: string): void => {
  assert.equal(actual.length, expected.length)
  for (let i = 0; i < actual.length; i++) near(actual[i]!, expected[i]!, tolerance, `${message ?? 'frame'}: channel ${i}`)
}

/** Runs one colour through a single-LED chain and returns the triple. */
function through (profile: Omit<AdjustmentProfile, 'leds'>, r: number, g: number, b: number, backlight = true): LinearRgb {
  const adjustment = createAdjustment([{ leds: '*', ...profile }], 1)
  adjustment.setBacklightEnabled(backlight)
  const frame = adjustment.apply(solid(r, g, b))
  return { r: frame[0]!, g: frame[1]!, b: frame[2]! }
}

// ---------------------------------------------------------------------------
// The chain as a whole
// ---------------------------------------------------------------------------

test('the default profile is a numerical no-op on random colours', () => {
  const input = randomFrame(1)
  const expected = input.slice()

  createAdjustment([{ leds: '*' }], COUNT).apply(input)
  frameNear(input, expected, 0, 'bare profile')

  // The same with every default spelled out, so the defaults constant and the
  // identity detection agree with each other.
  const explicit: AdjustmentProfile = { leds: '*', ...ADJUSTMENT_DEFAULTS, ...IDENTITY_CORNERS }
  createAdjustment([explicit], COUNT).apply(input)
  frameNear(input, expected, 0, 'explicit defaults')
})

test('the eight corner weights sum to one and rebuild the input from the identity corners', () => {
  const rnd = prng(2)
  for (let n = 0; n < 1000; n++) {
    const r = rnd()
    const g = rnd()
    const b = rnd()
    const w = cornerWeights(r, g, b)
    assert.equal(w.length, 8)
    let sum = 0
    const rebuilt = { r: 0, g: 0, b: 0 }
    CUBE_CORNERS.forEach((name, k) => {
      const weight = w[k]!
      assert.ok(weight >= 0 && weight <= 1, `${name} weight ${weight} out of range`)
      sum += weight
      rebuilt.r += weight * IDENTITY_CORNERS[name].r
      rebuilt.g += weight * IDENTITY_CORNERS[name].g
      rebuilt.b += weight * IDENTITY_CORNERS[name].b
    })
    near(sum, 1, 1e-12, `weights of (${r}, ${g}, ${b}) sum to ${sum}`)
    near(rebuilt.r, r, 1e-12)
    near(rebuilt.g, g, 1e-12)
    near(rebuilt.b, b, 1e-12)
  }
  // The corners themselves are one-hot.
  assert.deepEqual([...cornerWeights(0, 0, 0)], [1, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual([...cornerWeights(1, 1, 1)], [0, 0, 0, 0, 0, 0, 0, 1])
  assert.deepEqual([...cornerWeights(0, 1, 1)], [0, 0, 0, 0, 1, 0, 0, 0])
})

test('calibrating the red corner to (1, 0.1, 0) sends pure red exactly there and leaves pure blue alone', () => {
  const profile = { red: { r: 1, g: 0.1, b: 0 } }
  const red = through(profile, 1, 0, 0)
  assert.equal(red.r, 1)
  assert.equal(red.g, Math.fround(0.1))
  assert.equal(red.b, 0)

  const blue = through(profile, 0, 0, 1)
  assert.deepEqual(blue, { r: 0, g: 0, b: 1 })

  // Half red follows the calibrated corner half-way (trilinear, not a lookup).
  const half = through(profile, 0.5, 0, 0)
  near(half.r, 0.5, 1e-7)
  near(half.g, 0.05, 1e-7)
  assert.equal(half.b, 0)
})

test('a hot corner whose sum would wrap in Hyperion uint8 addition clamps to full scale here', () => {
  // Red corner driven at 160%: the user's red channel is weak. Input (1, 0.5, 0)
  // sits half-way between the red and yellow corners.
  const hotRed = { r: 1.6, g: 0, b: 0 }
  const w = cornerWeights(1, 0.5, 0)
  const unclamped = w[1]! * hotRed.r + w[6]! * IDENTITY_CORNERS.yellow.r
  near(unclamped, 1.3, 1e-12, 'the raw sum must exceed full scale for the test to mean anything')

  const out = through({ red: hotRed }, 1, 0.5, 0)
  assert.equal(out.r, 1, 'clamped to full scale')
  assert.equal(out.g, 0.5)
  assert.equal(out.b, 0)
  // MultiColorAdjustment.cpp:157 adds the contributions into a uint8: 1.3 of
  // full scale becomes 0.3 of it and the brightest region goes dark.
  const hyperionWrap = unclamped % 1
  assert.ok(Math.abs(out.r - hyperionWrap) > 0.5, `must not wrap to ${hyperionWrap}`)
})

test('taper defaults to 1.0; Hyperion\'s 2.2 applied in linear light crushes mid-grey sixfold', () => {
  const midGrey = srgbToLinear(128 / 255) // 0.2159: the correct light level of sRGB mid-grey

  // Default: the light level is delivered as decoded. A profile that inherited
  // Hyperion's schema default of 2.2 would fail this line.
  near(through({}, midGrey, midGrey, midGrey).r, midGrey, 1e-7)
  near(through({ taper: 1 }, midGrey, midGrey, midGrey).r, midGrey, 1e-7)

  // 2.2 on linear: 0.2159 ^ 2.2 = 0.0343, a 6.3x darkening.
  const tapered = through({ taper: 2.2 }, midGrey, midGrey, midGrey).r
  near(tapered, 0.0343, 5e-4)
  assert.ok(tapered < midGrey / 6, `${tapered} is not a sixfold crush of ${midGrey}`)

  // And that is what Hyperion's LUT does to the light output too: byte 128
  // becomes byte 55 (RgbTransform.cpp:65 + truncating cast), which is 0.0382
  // linear. The two agree to within 15% because sRGB is itself roughly a 2.2
  // power - i.e. 2.2 here is the same artistic crush, not a decode of
  // anything. Hence the default of 1.0.
  const hyperionByte = Math.floor((128 / 255) ** 2.2 * 255)
  assert.equal(hyperionByte, 55)
  const hyperionLight = srgbToLinear(hyperionByte / 255)
  near(hyperionLight, 0.0382, 5e-4)
  near(tapered / hyperionLight, 1, 0.15)

  // The knob's intended range barely moves mid-grey.
  const gentle = through({ taper: 1.3 }, midGrey, midGrey, midGrey).r
  near(gentle, midGrey ** 1.3, 1e-6)
  assert.ok(gentle > midGrey / 2)
})

// ---------------------------------------------------------------------------
// Stage 1 - Oklab
// ---------------------------------------------------------------------------

test('Oklab round trip is the identity to 1e-6', () => {
  const rnd = prng(3)
  const samples: LinearRgb[] = [
    { r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 },
    { r: 1, g: 0, b: 0 }, { r: 0, g: 1, b: 0 }, { r: 0, g: 0, b: 1 },
    { r: 0, g: 1, b: 1 }, { r: 1, g: 0, b: 1 }, { r: 1, g: 1, b: 0 }
  ]
  for (let n = 0; n < 2000; n++) samples.push({ r: rnd(), g: rnd(), b: rnd() })
  for (const c of samples) {
    const back = oklabToLinear(linearToOklab(c))
    near(back.r, c.r, 1e-6, `r of ${JSON.stringify(c)}`)
    near(back.g, c.g, 1e-6, `g of ${JSON.stringify(c)}`)
    near(back.b, c.b, 1e-6, `b of ${JSON.stringify(c)}`)
  }
  // Anchors from Ottosson's tables: white is L=1 with no chroma, black is 0.
  const white = linearToOklab({ r: 1, g: 1, b: 1 })
  near(white.L, 1, 1e-6)
  near(white.a, 0, 1e-6)
  near(white.b, 0, 1e-6)
  assert.deepEqual(linearToOklab({ r: 0, g: 0, b: 0 }), { L: 0, a: 0, b: 0 })
})

test('saturation gain 0 gives a neutral at the same lightness', () => {
  const rnd = prng(4)
  for (let n = 0; n < 200; n++) {
    const c = { r: rnd(), g: rnd(), b: rnd() }
    const out = through({ saturationGain: 0 }, c.r, c.g, c.b)
    near(out.r, out.g, 1e-6, 'r == g')
    near(out.g, out.b, 1e-6, 'g == b')
    near(linearToOklab(out).L, linearToOklab(c).L, 1e-6, 'lightness kept')
  }
})

test('brightness gain scales Oklab lightness and the inverse is clamped where the gamut ends', () => {
  // A colour that stays inside sRGB at half its lightness with its chroma
  // kept; a more saturated one would hit the clamp below and re-measure high.
  const c = { r: 0.5, g: 0.4, b: 0.3 }
  const before = linearToOklab(c)
  const rawHalf = oklabToLinear({ L: before.L * 0.5, a: before.a, b: before.b })
  assert.ok([rawHalf.r, rawHalf.g, rawHalf.b].every((v) => v >= 0 && v <= 1), 'precondition: in gamut')

  const dimmed = through({ brightnessGain: 0.5 }, c.r, c.g, c.b)
  const after = linearToOklab(dimmed)
  near(after.L, before.L * 0.5, 1e-6)
  // Chroma and hue kept: a and b are untouched by a lightness gain.
  near(after.a, before.a, 1e-6)
  near(after.b, before.b, 1e-6)

  // Pure red at triple chroma leaves the sRGB gamut: the unclamped inverse has
  // negative channels (ColorSys.cpp:80's reason for clamping) and the stage
  // must clamp rather than let them through.
  const lab = linearToOklab({ r: 1, g: 0, b: 0 })
  const raw = oklabToLinear({ L: lab.L, a: lab.a * 3, b: lab.b * 3 })
  assert.ok(raw.g < 0 || raw.b < 0, `expected an out-of-gamut component, got ${JSON.stringify(raw)}`)
  const out = new Float64Array(3)
  oklabGain(1, 0, 0, 3, 1, out)
  for (const v of out) assert.ok(v >= 0 && v <= 1, `clamped: ${v}`)
  const chained = through({ saturationGain: 3 }, 1, 0, 0)
  for (const v of [chained.r, chained.g, chained.b]) assert.ok(v >= 0 && v <= 1)

  // Gains of exactly 1 skip the stage: bit-identical, not merely close.
  const frame = randomFrame(5)
  const copy = frame.slice()
  createAdjustment([{ leds: '*', saturationGain: 1, brightnessGain: 1 }], COUNT).apply(frame)
  frameNear(frame, copy, 0)
})

// ---------------------------------------------------------------------------
// Stages 3-6 - brightness and corners
// ---------------------------------------------------------------------------

test('brightness 50 scales the coloured corners to a third but never the black floor; 0 is off', () => {
  assert.deepEqual(brightnessScalars(100, 0), { rgb: 1, cmy: 1, w: 1 })
  const half = brightnessScalars(50, 0)
  near(half.rgb, 1 / 3, 1e-12)
  // The hinge at 50 is continuous: both segments give B_in = 3.0 there.
  near(brightnessScalars(49.999, 0).rgb, 1 / 3, 1e-4)
  assert.deepEqual(brightnessScalars(0, 0), { rgb: 0, cmy: 0, w: 0 })

  const red = through({ brightness: 50 }, 1, 0, 0)
  near(red.r, 1 / 3, 1e-7)
  assert.equal(red.g, 0)

  // A calibrated black floor is what "off" looks like; MultiColorAdjustment.cpp:148
  // passes full brightness for the black corner alone so the slider never moves it.
  const floor = { r: 0.1, g: 0.1, b: 0.1 }
  const black = through({ brightness: 50, black: floor }, 0, 0, 0)
  near(black.r, 0.1, 1e-7, 'black floor must not be dimmed')
  near(black.g, 0.1, 1e-7)
  near(black.b, 0.1, 1e-7)

  const off = through({ brightness: 0 }, 1, 1, 1)
  assert.deepEqual(off, { r: 0, g: 0, b: 0 })
})

test('brightnessCompensation defaults to the schema value 0, not the C++ fallback 100', () => {
  assert.equal(ADJUSTMENT_DEFAULTS.brightnessCompensation, 0)
  // At the defaults white is still white. With utils/hyperion.h:77's fallback
  // of 100 every white would come out at a third (Fw = 3) and cyan at a half.
  assert.deepEqual(through({ brightness: 100 }, 1, 1, 1), { r: 1, g: 1, b: 1 })
  assert.deepEqual(through({}, 0, 1, 1), { r: 0, g: 1, b: 1 })

  const comp = brightnessScalars(100, 100)
  assert.equal(comp.rgb, 1)
  near(comp.cmy, 1 / 2, 1e-12)
  near(comp.w, 1 / 3, 1e-12)
  const white = through({ brightnessCompensation: 100 }, 1, 1, 1)
  near(white.r, 1 / 3, 1e-7)
  const cyan = through({ brightnessCompensation: 100 }, 0, 1, 1)
  near(cyan.g, 1 / 2, 1e-7)
  const red = through({ brightnessCompensation: 100 }, 1, 0, 0)
  assert.equal(red.r, 1, 'compensation never touches the rgb corners')
})

// ---------------------------------------------------------------------------
// Stage 7 - temperature
// ---------------------------------------------------------------------------

test('6600 K is the identity, 3000 K reddens, 10000 K blues, and Kelvin is clamped to 1000..40000', () => {
  assert.deepEqual(kelvinToSrgb(6600), { r: 1, g: 1, b: 1 })
  assert.deepEqual(kelvinToLinearRgb(6600), { r: 1, g: 1, b: 1 })
  assert.deepEqual(through({ temperature: 6600 }, 0.3, 0.6, 0.9), { r: Math.fround(0.3), g: Math.fround(0.6), b: Math.fround(0.9) })
  assert.equal(ADJUSTMENT_DEFAULTS.temperature, 6600)

  const warm = kelvinToLinearRgb(3000)
  assert.equal(warm.r, 1)
  assert.ok(warm.b < warm.g && warm.g < warm.r, `3000 K should be red-heavy, got ${JSON.stringify(warm)}`)
  const warmWhite = through({ temperature: 3000 }, 1, 1, 1)
  assert.ok(warmWhite.b < warmWhite.r)

  const cool = kelvinToLinearRgb(10000)
  assert.equal(cool.b, 1)
  assert.ok(cool.r < cool.g && cool.g < cool.b, `10000 K should be blue-heavy, got ${JSON.stringify(cool)}`)
  const coolWhite = through({ temperature: 10000 }, 1, 1, 1)
  assert.ok(coolWhite.r < coolWhite.b)

  // Clamped, as KelvinToRgb.h:19 clamps, so an absurd value is the nearest end.
  assert.deepEqual(kelvinToSrgb(500), kelvinToSrgb(1000))
  assert.deepEqual(kelvinToSrgb(100000), kelvinToSrgb(40000))
  assert.equal(kelvinToSrgb(1000).b, 0, 'the blue piece is 0 up to 1900 K')
  assert.throws(() => kelvinToSrgb(Number.NaN), RangeError)
})

test('the temperature multiplier is decoded to linear before it touches linear channels', () => {
  const encoded = kelvinToSrgb(3000)
  const linear = kelvinToLinearRgb(3000)
  // Sanity on the fit itself: Helland's blue at 3000 K is about 0.43 encoded.
  near(encoded.b, 0.431, 5e-3)
  near(linear.b, srgbToLinear(encoded.b), 1e-12)
  near(linear.b, 0.156, 5e-3)

  const out = through({ temperature: 3000 }, 1, 1, 1)
  near(out.b, linear.b, 1e-6, 'blue of white at 3000 K is the decoded multiplier')
  near(out.g, linear.g, 1e-6)
  // Hyperion's RgbTransform.cpp:216 multiplies by the encoded byte ratio; on
  // linear channels that leaves blue nearly three times too strong.
  assert.ok(Math.abs(out.b - encoded.b) > 0.2, `must not be the gamma-space multiply ${encoded.b}`)
  assert.ok(out.b < encoded.b)
})

// ---------------------------------------------------------------------------
// Stage 8 - backlight
// ---------------------------------------------------------------------------

test('threshold 50 is Hyperion byte 85, decoded to linear light', () => {
  assert.equal(backlightFloor(0), 0)
  assert.equal(backlightFloor(100), 1)
  near(backlightFloor(50), srgbToLinear(85 / 255), 1e-12)
  // Not the linear third a naive port would give: the floor is a light level a
  // Hyperion user tuned by eye, and 1/3 would be three times brighter.
  assert.ok(backlightFloor(50) < 0.1)
  // Monotonic and clamped.
  assert.ok(backlightFloor(10) < backlightFloor(20) && backlightFloor(20) < backlightFloor(50))
  assert.equal(backlightFloor(-5), 0)
  assert.equal(backlightFloor(150), 1)
})

test('the backlight floor lifts a dark colour and leaves a bright one alone', () => {
  const floor = backlightFloor(50)
  const dark = through({ backlightThreshold: 50 }, 0.01, 0.01, 0.01)
  near(dark.r, floor, 1e-7)
  near(dark.g, floor, 1e-7)
  near(dark.b, floor, 1e-7)

  const bright = through({ backlightThreshold: 50 }, 0.5, 0.5, 0.5)
  assert.deepEqual(bright, { r: 0.5, g: 0.5, b: 0.5 })

  // The gate is on the channel SUM (RgbTransform.cpp:183-184): one channel
  // above the floor does not save a colour whose sum is below three floors.
  const justUnder = through({ backlightThreshold: 50 }, 3 * floor * 0.99, 0, 0)
  near(justUnder.r, floor, 1e-7, 'plain backlight snaps to grey')
  const justOver = through({ backlightThreshold: 50 }, 3 * floor * 1.01, 0, 0)
  near(justOver.r, 3 * floor * 1.01, 1e-7)
  assert.equal(justOver.g, 0)

  // Threshold 0 is no floor at all: black stays black.
  assert.deepEqual(through({}, 0, 0, 0), { r: 0, g: 0, b: 0 })
})

test('a coloured backlight keeps the hue; a plain one snaps to grey', () => {
  const floor = backlightFloor(50)
  const plain = through({ backlightThreshold: 50, backlightColored: false }, 0.2, 0, 0)
  near(plain.r, floor, 1e-7)
  near(plain.g, floor, 1e-7)
  near(plain.b, floor, 1e-7)

  const coloured = through({ backlightThreshold: 50, backlightColored: true }, 0.2, 0, 0)
  near(coloured.r, 0.2, 1e-7, 'a channel above the floor is kept')
  near(coloured.g, floor, 1e-7)
  near(coloured.b, floor, 1e-7)
})

test('the backlight floor is off for solid colours and effects via setBacklightEnabled', () => {
  const adjustment = createAdjustment([{ leds: '*', backlightThreshold: 50 }], 1)
  assert.equal(adjustment.backlightEnabled(), true, 'on by default, as RgbTransform::init sets it')

  adjustment.setBacklightEnabled(false)
  assert.equal(adjustment.backlightEnabled(), false)
  const black = adjustment.apply(solid(0, 0, 0))
  assert.deepEqual([...black], [0, 0, 0], 'black must be black while a solid colour shows')

  adjustment.setBacklightEnabled(true)
  const lifted = adjustment.apply(solid(0, 0, 0))
  near(lifted[0]!, backlightFloor(50), 1e-7)
})

test('the floor is applied after the temperature tint, so the floor itself is never tinted', () => {
  const floor = backlightFloor(50)
  const out = through({ backlightThreshold: 50, temperature: 3000 }, 0, 0, 0)
  near(out.r, floor, 1e-7)
  near(out.g, floor, 1e-7)
  near(out.b, floor, 1e-7)
})

// ---------------------------------------------------------------------------
// Per-LED profiles and the selector
// ---------------------------------------------------------------------------

test('LED selector: *, a range, a single index and a mixed list', () => {
  assert.deepEqual(parseLedSelector('*', 5), [0, 1, 2, 3, 4])
  assert.deepEqual(parseLedSelector('0-24', 108), Array.from({ length: 25 }, (_, i) => i))
  assert.deepEqual(parseLedSelector('3', 108), [3])
  assert.deepEqual(parseLedSelector('0-2, 7, 9-10', 108), [0, 1, 2, 7, 9, 10])
  assert.deepEqual(parseLedSelector('  0-2,7 ,9-10 ', 108), [0, 1, 2, 7, 9, 10], 'whitespace is free')
  assert.deepEqual(parseLedSelector('5, 5-6, 5', 108), [5, 6], 'duplicates collapse')
  assert.deepEqual(parseLedSelector('107', 108), [107], 'the last LED is addressable')
})

test('LED selector rejects descending ranges, indices past the strip and garbage', () => {
  assert.throws(() => parseLedSelector('5-2', 108), RangeError)
  assert.throws(() => parseLedSelector('108', 108), RangeError)
  assert.throws(() => parseLedSelector('100-108', 108), RangeError)
  assert.throws(() => parseLedSelector('0-4, 200', 108), RangeError)
  for (const bad of ['', 'abc', '1-', '-1', '1-2-3', '1;2', '1..3', '3 4', '*,1']) {
    assert.throws(() => parseLedSelector(bad, 108), SyntaxError, `"${bad}" must be rejected`)
  }
  assert.throws(() => createAdjustment([{ leds: '5-2' }], 10), RangeError)
})

test('single indices come from their own token, whichever profile they sit in', () => {
  // utils/hyperion.h:172 reads ledIndexList[i] (the profile index) in the
  // single-index branch. Profile 0 with '3, 5' would assign LED 3 twice and
  // never LED 5; profile 1 with '7' would read token 1 of a one-token list.
  const adjustment = createAdjustment([
    { leds: '3, 5', blue: { r: 0, g: 0, b: 0.5 } },
    { leds: '7', blue: { r: 0, g: 0, b: 0.25 } }
  ], 10)
  const frame = adjustment.apply(solid(0, 0, 1, 10))
  const blueOf = (led: number): number => frame[led * 3 + 2]!
  assert.equal(blueOf(3), 0.5)
  assert.equal(blueOf(5), 0.5, 'the second single index of a list is honoured')
  assert.equal(blueOf(7), 0.25, 'a single index in the second profile lands on that LED')
  for (const led of [0, 1, 2, 4, 6, 8, 9]) assert.equal(blueOf(led), 1, `LED ${led} is not selected`)
})

test('a LED no profile selects passes through untouched and is reported', () => {
  const adjustment = createAdjustment([{ leds: '0-1, 4', red: { r: 0.5, g: 0, b: 0 } }], 6)
  assert.deepEqual([...adjustment.unassigned], [2, 3, 5])
  assert.equal(adjustment.count, 6)

  const frame = adjustment.apply(solid(1, 0, 0, 6))
  const redOf = (led: number): number => frame[led * 3]!
  assert.equal(redOf(0), 0.5)
  assert.equal(redOf(1), 0.5)
  assert.equal(redOf(4), 0.5)
  for (const led of [2, 3, 5]) assert.equal(redOf(led), 1, `LED ${led} must be untouched`)

  assert.deepEqual([...createAdjustment([{ leds: '*' }], 3).unassigned], [])
  assert.deepEqual([...createAdjustment([], 3).unassigned], [0, 1, 2])
})

test('a later profile wins on an overlapping LED', () => {
  const adjustment = createAdjustment([
    { leds: '*', blue: { r: 0, g: 0, b: 0.5 } },
    { leds: '2', blue: { r: 0, g: 0, b: 0.25 } }
  ], 4)
  const frame = adjustment.apply(solid(0, 0, 1, 4))
  assert.deepEqual([frame[2], frame[5], frame[8], frame[11]], [0.5, 0.5, 0.25, 0.5])
})

test('a frame of another size is adjusted on the overlap only', () => {
  const adjustment = createAdjustment([{ leds: '*', blue: { r: 0, g: 0, b: 0.5 } }], 4)
  const longer = adjustment.apply(solid(0, 0, 1, 6))
  assert.deepEqual([longer[2], longer[5], longer[8], longer[11]], [0.5, 0.5, 0.5, 0.5])
  assert.deepEqual([longer[14], longer[17]], [1, 1], 'LEDs beyond the table are left alone')
  const shorter = adjustment.apply(solid(0, 0, 1, 2))
  assert.deepEqual([shorter[2], shorter[5]], [0.5, 0.5])
})

test('invalid profile values are rejected when the table is built, not per frame', () => {
  assert.throws(() => createAdjustment([{ leds: '*' }], 0), RangeError)
  assert.throws(() => createAdjustment([{ leds: '*' }], 1.5), RangeError)
  assert.throws(() => createAdjustment([{ leds: '*', brightness: 101 }], 1), RangeError)
  assert.throws(() => createAdjustment([{ leds: '*', brightness: -1 }], 1), RangeError)
  assert.throws(() => createAdjustment([{ leds: '*', brightnessCompensation: 101 }], 1), RangeError)
  assert.throws(() => createAdjustment([{ leds: '*', taper: 0 }], 1), RangeError)
  assert.throws(() => createAdjustment([{ leds: '*', saturationGain: Number.NaN }], 1), RangeError)
  assert.throws(() => createAdjustment([{ leds: '*', brightnessGain: -0.5 }], 1), RangeError)
  assert.throws(() => createAdjustment([{ leds: '*', backlightThreshold: 101 }], 1), RangeError)
  assert.throws(() => createAdjustment([{ leds: '*', temperature: Number.POSITIVE_INFINITY }], 1), RangeError)
  assert.throws(() => createAdjustment([{ leds: '*', red: { r: -0.1, g: 0, b: 0 } }], 1), RangeError)
  // A hot corner is allowed; see the clamp test.
  assert.doesNotThrow(() => createAdjustment([{ leds: '*', red: { r: 1.5, g: 0, b: 0 } }], 1))
})
