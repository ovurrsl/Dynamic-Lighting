import assert from 'node:assert/strict'
import test from 'node:test'

import { REFERENCE_LAYOUT, classicLayout } from '#lib/engine/layout'
import {
  CLUSTER_SEEDS,
  KMEANS_CONVERGENCE,
  KMEANS_MAX_ITERATIONS,
  LARGE_REGION_PIXELS,
  SAMPLE_MODES,
  createSampler,
  type SampleMode,
  type Sampler,
  type SamplerOptions
} from '#lib/engine/sample'
import { NO_BORDER, allocLedColors, type LedRect, type LinearGrid } from '#lib/engine/types'

// A 16:9 grid small enough to reason about by hand. The reference layout's
// top LEDs are 64/35 = 1.83 columns wide, so neighbours alternate between one
// and two columns; the 12% depth is round(4.32) = 4 rows and the 8% depth
// round(5.12) = 5 columns.
const W = 64
const H = 36
const RECTS = classicLayout(REFERENCE_LAYOUT)
const LEDS = RECTS.length
const { top, right, bottom } = REFERENCE_LAYOUT
const TOP = range(0, top)
const RIGHT = range(top, top + right)
const BOTTOM = range(top + right, top + right + bottom)
const LEFT = range(top + right + bottom, LEDS)
/** One LED that sees the whole grid: exact proportions for the histogram and cluster tests. */
const FULL_FRAME: LedRect[] = [{ xMin: 0, xMax: 1, yMin: 0, yMax: 1 }]
const PER_LED_MODES: SampleMode[] = ['mean', 'meanSquared', 'dominant', 'dominantAdvanced']
const f = Math.fround

type Rgb = readonly [number, number, number]

function range (from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, i) => from + i)
}

function grid (width: number, height: number, paint: (x: number, y: number) => Rgb): LinearGrid {
  const data = new Float32Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y)
      const at = (y * width + x) * 3
      data[at] = r
      data[at + 1] = g
      data[at + 2] = b
    }
  }
  return { width, height, data }
}

const solid = (r: number, g: number, b: number, width = W, height = H): LinearGrid => grid(width, height, () => [r, g, b])

function led (out: Float32Array, i: number): [number, number, number] {
  return [out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!]
}

function assertLed (out: Float32Array, i: number, expected: Rgb, eps = 1e-6, what = `LED ${i}`): void {
  const actual = led(out, i)
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(actual[c]! - expected[c]!) <= eps, `${what} channel ${c}: ${actual[c]} vs ${expected[c]}`)
  }
}

function sampler (layout: readonly LedRect[], width = W, height = H, extra: Partial<SamplerOptions> = {}): Sampler {
  return createSampler({ layout, width, height, ...extra })
}

function sampleAll (s: Sampler, g: LinearGrid, mode: SampleMode): Float32Array {
  return s.sample(g, allocLedColors(s.count), mode)
}

interface Box { x0: number, x1: number, y0: number, y1: number }

/**
 * The pixel box of a rectangle at a border by Hyperion's arithmetic
 * (ImageToLedsMap.cpp:58-77), and the mean of the grid over it addressed by
 * (x, y) rather than by offset. The reference agrees with the sampler on WHICH
 * pixels a LED owns and can only disagree on how they are read.
 */
function pixelBox (rect: LedRect, width: number, height: number, leftRight: number, topBottom: number): Box {
  const activeW = width - 2 * leftRight
  const activeH = height - 2 * topBottom
  let x0 = leftRight + Math.round(activeW * rect.xMin)
  let x1 = leftRight + Math.round(activeW * rect.xMax)
  let y0 = topBottom + Math.round(activeH * rect.yMin)
  let y1 = topBottom + Math.round(activeH * rect.yMax)
  x0 = Math.min(x0, leftRight + activeW - 1)
  if (x0 === x1) x1++
  y0 = Math.min(y0, topBottom + activeH - 1)
  if (y0 === y1) y1++
  return { x0, x1: Math.min(x1, leftRight + activeW), y0, y1: Math.min(y1, topBottom + activeH) }
}

function boxMean (g: LinearGrid, box: Box): Rgb {
  const sum = [0, 0, 0]
  let n = 0
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const at = (y * g.width + x) * 3
      for (let c = 0; c < 3; c++) sum[c]! += g.data[at + c]!
      n++
    }
  }
  return [sum[0]! / n, sum[1]! / n, sum[2]! / n]
}

// ---------------------------------------------------------------------------
// The map.
// ---------------------------------------------------------------------------

test('a uniform grid gives every LED that colour in every mode', () => {
  const s = sampler(RECTS)
  const g = solid(0.2, 0.5, 0.8)
  for (const mode of SAMPLE_MODES) {
    const out = sampleAll(s, g, mode)
    for (let i = 0; i < LEDS; i++) assertLed(out, i, [f(0.2), f(0.5), f(0.8)], 1e-6, `${mode} LED ${i}`)
  }
})

test('left half red, right half blue: left-edge LEDs red, right-edge blue, and the top edge crosses over by position', () => {
  const g = grid(W, H, (x) => (x < W / 2 ? [1, 0, 0] : [0, 0, 1]))
  const out = sampleAll(sampler(RECTS), g, 'mean')

  for (const i of LEFT) assert.deepEqual(led(out, i), [1, 0, 0], `left LED ${i}`)
  for (const i of RIGHT) assert.deepEqual(led(out, i), [0, 0, 1], `right LED ${i}`)

  // Top LED 17 spans [17/35, 18/35) = columns round(31.09)..round(32.91) =
  // 31 and 32, one on each side of the seam.
  for (const i of TOP.slice(0, 17)) assert.deepEqual(led(out, i), [1, 0, 0], `top LED ${i}`)
  assert.deepEqual(led(out, 17), [0.5, 0, 0.5])
  for (const i of TOP.slice(18)) assert.deepEqual(led(out, i), [0, 0, 1], `top LED ${i}`)
  for (let i = 1; i < top; i++) {
    assert.ok(led(out, i)[0] <= led(out, i - 1)[0], `red falls along the top edge at LED ${i}`)
    assert.ok(led(out, i)[2] >= led(out, i - 1)[2], `blue rises along the top edge at LED ${i}`)
  }
})

test('a border insets every rectangle past the bars; clearing it, or an unknown border, restores the full frame', () => {
  const bars = { leftRight: 4, topBottom: 2 }
  const g = grid(W, H, (x, y) =>
    (x < bars.leftRight || x >= W - bars.leftRight || y < bars.topBottom || y >= H - bars.topBottom ? [0, 0, 0] : [1, 1, 1]))
  const s = sampler(RECTS)

  // Left LED 98 reads rows 17-18 and columns 0..4: four columns of bar and
  // one of picture.
  const midLeft = 98
  assert.deepEqual(led(sampleAll(s, g, 'mean'), midLeft), [f(0.2), f(0.2), f(0.2)])

  assert.equal(s.setBorder({ unknown: false, ...bars }), true)
  assert.deepEqual(s.border(), { unknown: false, ...bars })
  const inset = sampleAll(s, g, 'mean')
  for (let i = 0; i < LEDS; i++) assert.deepEqual(led(inset, i), [1, 1, 1], `LED ${i} with the bars cut off`)

  // The same border again is the no-op a caller can afford every frame.
  assert.equal(s.setBorder({ unknown: false, ...bars }), false)

  assert.equal(s.setBorder(NO_BORDER), true)
  assert.deepEqual(led(sampleAll(s, g, 'mean'), midLeft), [f(0.2), f(0.2), f(0.2)])

  // ImageProcessor.h:264-268: unknown means no border, whatever it carries.
  assert.equal(s.setBorder({ unknown: true, ...bars }), false)
  assert.deepEqual(s.border(), NO_BORDER)
  assert.deepEqual(led(sampleAll(s, g, 'mean'), midLeft), [f(0.2), f(0.2), f(0.2)])
})

test('rows are addressed with the full grid width even when a left/right border is in force (Hyperion defect #1)', () => {
  // Every pixel carries its own column in red and its own row in green, so a
  // read from the wrong place is a different colour.
  const g = grid(W, H, (x, y) => [x / (W - 1), y / (H - 1), 0.25])
  const border = { unknown: false, leftRight: 4, topBottom: 0 }
  const s = sampler(RECTS)
  s.setBorder(border)
  const out = sampleAll(s, g, 'mean')

  for (let i = 0; i < LEDS; i++) {
    assertLed(out, i, boxMean(g, pixelBox(RECTS[i]!, W, H, border.leftRight, border.topBottom)), 1e-6)
  }

  // What Hyperion reads for the same boxes: `y * actualWidth + x`
  // (ImageToLedsMap.cpp:96) into a buffer whose rows are `width` long, so
  // with 56 for 64 every row lands 8 columns early and, by the bottom of the
  // frame, four rows too high. The bottom edge is the clearest: rows 32..35
  // become rows 28..31, a ninth of the green ramp away.
  const activeW = W - 2 * border.leftRight
  for (const i of BOTTOM) {
    const box = pixelBox(RECTS[i]!, W, H, border.leftRight, border.topBottom)
    let green = 0
    let n = 0
    for (let y = box.y0; y < box.y1; y++) {
      for (let x = box.x0; x < box.x1; x++) {
        const offset = y * activeW + x
        green += g.data[(Math.floor(offset / W) * W + (offset % W)) * 3 + 1]!
        n++
      }
    }
    assert.ok(Math.abs(green / n - led(out, i)[1]) > 0.1, `bottom LED ${i}: Hyperion's stride would read a different row`)
  }
})

test('a rectangle without area maps to no pixels and samples black; a sliver still gets one pixel', () => {
  const layout: LedRect[] = [
    { xMin: 0.3, xMax: 0.3, yMin: 0, yMax: 1 },
    // round(32.0) == round(32.00064) collapses and is opened by one (cpp:64-72).
    { xMin: 0.5, xMax: 0.5 + 1e-5, yMin: 0.5, yMax: 0.5 + 1e-5 },
    // round(63.94) = 64 is past the last column; pulled back onto it.
    { xMin: 0.999, xMax: 1, yMin: 0.999, yMax: 1 },
    ...FULL_FRAME
  ]
  const s = sampler(layout)
  assert.equal(s.pixelIndices(0).length, 0)
  assert.deepEqual(Array.from(s.pixelIndices(1)), [18 * W + 32])
  assert.deepEqual(Array.from(s.pixelIndices(2)), [35 * W + 63])

  const g = grid(W, H, (x, y) => (x === 32 && y === 18 ? [0.2, 0.4, 0.6] : x === 63 && y === 35 ? [0.1, 0.2, 0.3] : [1, 1, 1]))
  for (const mode of PER_LED_MODES) {
    const out = sampleAll(s, g, mode)
    assert.deepEqual(led(out, 0), [0, 0, 0], `${mode} on no pixels`)
    assertLed(out, 1, [f(0.2), f(0.4), f(0.6)], 1e-6, `${mode} on the one-pixel sliver`)
    assertLed(out, 2, [f(0.1), f(0.2), f(0.3)], 1e-6, `${mode} on the corner pixel`)
  }
})

test('a region over 1600 pixels is read at every second pixel and the sampler says so, unless a reduction was chosen (Hyperion defect #10)', () => {
  // The whole 64x36 frame on one LED: 2304 pixels.
  const s = sampler(FULL_FRAME)
  assert.equal(s.warnings.length, 1)
  assert.match(s.warnings[0]!, /1 LED region/)
  assert.match(s.warnings[0]!, new RegExp(String(LARGE_REGION_PIXELS)))
  assert.match(s.warnings[0]!, /LED 0/)
  assert.equal(s.pixelIndices(0).length, (W / 2) * (H / 2))
  for (const index of s.pixelIndices(0)) assert.ok(index % 2 === 0 && Math.floor(index / W) % 2 === 0, `pixel ${index} is at even coordinates`)

  // A flat region still averages exactly.
  assertLed(sampleAll(s, solid(0.3, 0.6, 0.9), 'mean'), 0, [f(0.3), f(0.6), f(0.9)])
  // And this is what the warning is about: on a checkerboard every read
  // pixel is a white one, so the LED sees 1.0 where the region holds 0.5.
  const checker = grid(W, H, (x, y) => ((x + y) % 2 === 0 ? [1, 1, 1] : [0, 0, 0]))
  assert.deepEqual(led(sampleAll(s, checker, 'mean'), 0), [1, 1, 1])

  // Asking for the reduction yourself reads the same pixels without the warning.
  const chosen = sampler(FULL_FRAME, W, H, { reducedPixelSetFactor: 1 })
  assert.deepEqual(chosen.warnings, [])
  assert.deepEqual(Array.from(chosen.pixelIndices(0)), Array.from(s.pixelIndices(0)))

  // The reference layout has nothing near the limit.
  assert.deepEqual(sampler(RECTS).warnings, [])

  // A border that shrinks the region under the limit ends the skipping, and
  // the warnings follow the rebuild.
  s.setBorder({ unknown: false, leftRight: 16, topBottom: 8 })
  assert.deepEqual(s.warnings, [])
  assert.equal(s.pixelIndices(0).length, (W - 32) * (H - 16))
  s.setBorder(NO_BORDER)
  assert.equal(s.warnings.length, 1)
})

test('reducedPixelSetFactor 3 reads every 4th pixel on both axes and still averages a flat region exactly', () => {
  const s = sampler(FULL_FRAME, W, H, { reducedPixelSetFactor: 3 })
  assert.deepEqual(s.warnings, [])
  assert.equal(s.pixelIndices(0).length, (W / 4) * (H / 4))
  for (const index of s.pixelIndices(0)) assert.ok(index % 4 === 0 && Math.floor(index / W) % 4 === 0, `pixel ${index} is on the 4x4 lattice`)

  assertLed(sampleAll(s, solid(0.3, 0.6, 0.9), 'mean'), 0, [f(0.3), f(0.6), f(0.9)])
  // Colour only the lattice: the LED sees exactly that colour, nothing else.
  const lattice = grid(W, H, (x, y) => (x % 4 === 0 && y % 4 === 0 ? [0.3, 0.6, 0.9] : [0, 0, 0]))
  assertLed(sampleAll(s, lattice, 'mean'), 0, [f(0.3), f(0.6), f(0.9)])
})

// ---------------------------------------------------------------------------
// The reductions.
// ---------------------------------------------------------------------------

test('mean and meanSquared of a half-black, half-white region are 0.5 and sqrt(0.5)', () => {
  const g = grid(W, H, (x) => (x < W / 2 ? [0, 0, 0] : [1, 1, 1]))
  // Sixteen columns of each on one LED, so the pixel-skip guard does not
  // change the proportions.
  const s = sampler(FULL_FRAME, W, H, { reducedPixelSetFactor: 1 })
  assert.deepEqual(led(sampleAll(s, g, 'mean'), 0), [0.5, 0.5, 0.5])
  assertLed(sampleAll(s, g, 'meanSquared'), 0, [Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2])
})

test("'meanSquared' and 'unicolorMean' each do what their name says (Hyperion dispatches cases 1 and 2 swapped, defect #2)", () => {
  const g = grid(W, H, (x) => (x < W / 2 ? [0, 0, 0] : [1, 1, 1]))
  const s = sampler(RECTS)

  // Per-LED RMS: black on the left, white on the right, sqrt(1/2) on the seam.
  const rms = sampleAll(s, g, 'meanSquared')
  for (const i of LEFT) assert.deepEqual(led(rms, i), [0, 0, 0], `left LED ${i}`)
  for (const i of RIGHT) assert.deepEqual(led(rms, i), [1, 1, 1], `right LED ${i}`)
  assertLed(rms, 17, [Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2])

  // The uniform mean is the whole frame's 0.5 on every LED. Under the swap
  // 'meanSquared' would return this and 'unicolorMean' the array above.
  const uni = sampleAll(s, g, 'unicolorMean')
  for (let i = 0; i < LEDS; i++) assert.deepEqual(led(uni, i), [0.5, 0.5, 0.5], `LED ${i}`)
})

test('the float mean keeps what Hyperion\'s byte division truncates', () => {
  // Eleven 255s and one 254 are 254.92; `uint8_t(cumm / pixelNum)`
  // (ImageToLedsMap.h:433) makes that 254.
  const g = grid(12, 1, (x) => (x === 0 ? [254 / 255, 0, 0] : [1, 0, 0]))
  const out = sampleAll(sampler(FULL_FRAME, 12, 1), g, 'mean')
  assert.ok(Math.abs(out[0]! - (11 + f(254 / 255)) / 12) < 1e-7)
  assert.ok(out[0]! * 255 > 254.9)
})

test('dominant returns the modal colour of a 70/30 split, exactly', () => {
  const a: Rgb = [0.3, 0.6, 0.1]
  const b: Rgb = [0.9, 0.2, 0.4]
  const s = sampler(FULL_FRAME, 10, 10)
  const mostlyA = grid(10, 10, (_x, y) => (y < 7 ? a : b))
  const mostlyB = grid(10, 10, (_x, y) => (y < 3 ? a : b))
  for (const mode of ['dominant', 'unicolorDominant'] as const) {
    assert.deepEqual(led(sampleAll(s, mostlyA, mode), 0), [f(0.3), f(0.6), f(0.1)], mode)
    assert.deepEqual(led(sampleAll(s, mostlyB, mode), 0), [f(0.9), f(0.2), f(0.4)], mode)
  }
})

test('dominant pools near-identical shades, so dithered flat content beats a smaller solid patch (Hyperion keys on the exact byte value)', () => {
  // 40 pixels of one grey, 35 of a grey one 8-bit step away, 45 of red. On
  // exact keys (ImageToLedsMap.h:586) red is the largest single value and
  // wins; on 5-bit keys the two greys share a bin and their 75 votes win.
  const a1: Rgb = [0.5, 0.5, 0.5]
  const a2: Rgb = [0.51, 0.505, 0.5]
  const red: Rgb = [0.9, 0.1, 0.1]
  const g = grid(12, 10, (x, y) => {
    const i = y * 12 + x
    return i < 40 ? a1 : i < 75 ? a2 : red
  })
  const out = sampleAll(sampler(FULL_FRAME, 12, 10), g, 'dominant')
  const pooled: Rgb = [(40 * f(0.5) + 35 * f(0.51)) / 75, (40 * f(0.5) + 35 * f(0.505)) / 75, 0.5]
  assertLed(out, 0, pooled)
  assert.ok(out[0]! < 0.6, 'not the red patch')
})

test('dominantAdvanced keeps iterating while the centroids still move, instead of stopping when the movement merely repeats (Hyperion defect #6)', () => {
  // Two clusters seeded at black and green (accuracyLevel 1), pixels on the
  // green axis only. Eleven columns: six black, two at 0.45, two at 0.5, one
  // at 0.8. By hand, with c0/c1 the centroids and ties going to c0:
  //
  //   iteration 1  c0 = mean(0 x6, 0.45 x2, 0.5 x2) = 0.19   c1 = 0.8
  //                largest move 0.2  (c1: 1.0 -> 0.8)
  //   iteration 2  boundary 0.495: the 0.5s cross to c1
  //                c0 = mean(0 x6, 0.45 x2) = 0.1125         c1 = 0.6
  //                largest move 0.2  (c1: 0.8 -> 0.6)
  //
  // Hyperion tests |0.2 - 0.2| < 1 and stops here (ImageToLedsMap.h:717)
  // with the two 0.45s still in the dark cluster, and reports the dominant
  // colour of a mostly-black region as the grey 0.1125 - sRGB 95, a lit LED.
  //
  //   iteration 3  boundary 0.356: the 0.45s cross to c1
  //                c0 = 0                                     c1 = 0.54
  //   iteration 4  nothing crosses; largest move 0; stop.
  //
  // The dark cluster holds 6 of 11 pixels, so the answer is black.
  const g = grid(11, 4, (x) => [0, x < 6 ? 0 : x < 8 ? 0.45 : x < 10 ? 0.5 : 0.8, 0])
  const s = sampler(FULL_FRAME, 11, 4, { accuracyLevel: 1 })
  assert.deepEqual(led(sampleAll(s, g, 'dominantAdvanced'), 0), [0, 0, 0])
  assert.deepEqual(led(sampleAll(s, g, 'unicolorDominantAdvanced'), 0), [0, 0, 0])
  assert.ok(KMEANS_CONVERGENCE < 0.2, 'the equal steps are far above the stopping threshold')
})

test('dominantAdvanced settles on alternating noise within the iteration cap and returns a colour inside the content', () => {
  // A fixed LCG picks one of four palette colours per pixel: nothing flat,
  // nothing periodic, every LED region a different mix.
  const palette: Rgb[] = [[0.9, 0.1, 0.1], [0.1, 0.8, 0.2], [0.1, 0.2, 0.9], [0.05, 0.05, 0.05]]
  let seed = 12345
  const g = grid(W, H, () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return palette[seed >>> 30]!
  })
  const lo = [0, 1, 2].map((c) => Math.min(...palette.map((p) => p[c]!)))
  const hi = [0, 1, 2].map((c) => Math.max(...palette.map((p) => p[c]!)))
  const s = sampler(RECTS)
  for (const mode of ['dominantAdvanced', 'unicolorDominantAdvanced'] as const) {
    const out = sampleAll(s, g, mode)
    for (let i = 0; i < LEDS; i++) {
      const [r, gg, b] = led(out, i)
      for (const [c, v] of [r, gg, b].entries()) {
        assert.ok(Number.isFinite(v) && v >= lo[c]! - 1e-6 && v <= hi[c]! + 1e-6, `${mode} LED ${i} channel ${c} = ${v}`)
      }
    }
  }
})

test('accuracyLevel outside 0..4 is clamped and reported, not logged', () => {
  const stripes: Rgb[] = [[0.9, 0.1, 0.1], [0.1, 0.8, 0.2], [0.1, 0.2, 0.9], [0.9, 0.9, 0.1], [0.6, 0.6, 0.6]]
  const g = grid(10, 10, (_x, y) => stripes[Math.floor(y / 2)]!)

  const high = sampler(FULL_FRAME, 10, 10, { accuracyLevel: 7 })
  assert.equal(high.warnings.length, 1)
  assert.match(high.warnings[0]!, /accuracyLevel 7/)
  assert.match(high.warnings[0]!, /4/)
  const max = sampler(FULL_FRAME, 10, 10, { accuracyLevel: 4 })
  assert.deepEqual(max.warnings, [])
  assert.deepEqual(led(sampleAll(high, g, 'dominantAdvanced'), 0), led(sampleAll(max, g, 'dominantAdvanced'), 0))

  const low = sampler(FULL_FRAME, 10, 10, { accuracyLevel: -1 })
  assert.equal(low.warnings.length, 1)
  assert.match(low.warnings[0]!, /accuracyLevel -1/)
  // Level 0 is one cluster, which is the plain mean.
  const one = sampler(FULL_FRAME, 10, 10, { accuracyLevel: 0 })
  assert.deepEqual(led(sampleAll(low, g, 'dominantAdvanced'), 0), led(sampleAll(one, g, 'dominantAdvanced'), 0))
  assert.deepEqual(led(sampleAll(one, g, 'dominantAdvanced'), 0), led(sampleAll(one, g, 'mean'), 0))
  assert.notDeepEqual(led(sampleAll(max, g, 'dominantAdvanced'), 0), led(sampleAll(one, g, 'mean'), 0))
})

test('unicolor modes fill all 108 LEDs with the whole-grid value, border or not', () => {
  const s = sampler(RECTS)
  const ramp = grid(W, H, (x, y) => [x / (W - 1), y / (H - 1), 0.5])
  const whole = boxMean(ramp, { x0: 0, x1: W, y0: 0, y1: H })

  const mean = sampleAll(s, ramp, 'unicolorMean')
  for (let i = 0; i < LEDS; i++) assertLed(mean, i, whole)
  // ImageToLedsMap.h:449-476 walks the whole image, border or not.
  s.setBorder({ unknown: false, leftRight: 8, topBottom: 4 })
  assert.deepEqual(sampleAll(s, ramp, 'unicolorMean'), mean)
  s.setBorder(NO_BORDER)

  const split = grid(W, H, (x, y) => (y * W + x < 0.7 * W * H ? [0.3, 0.6, 0.1] : [0.9, 0.2, 0.4]))
  const modal = sampleAll(s, split, 'unicolorDominant')
  assert.deepEqual(led(modal, 0), [f(0.3), f(0.6), f(0.1)])
  for (let i = 1; i < LEDS; i++) assert.deepEqual(led(modal, i), led(modal, 0), `LED ${i}`)

  const clustered = sampleAll(s, split, 'unicolorDominantAdvanced')
  assertLed(clustered, 0, [f(0.3), f(0.6), f(0.1)])
  for (let i = 1; i < LEDS; i++) assert.deepEqual(led(clustered, i), led(clustered, 0), `LED ${i}`)
})

// ---------------------------------------------------------------------------
// Contract.
// ---------------------------------------------------------------------------

test('sample writes into and returns the caller\'s buffer', () => {
  const s = sampler(RECTS)
  const out = allocLedColors(LEDS)
  assert.equal(s.sample(solid(0.5, 0.5, 0.5), out, 'mean'), out)
  assert.ok(out.every((v) => v === 0.5))
})

test('rejects a grid of another size, a short buffer, a border that leaves no picture, rectangles off the unit square and unknown knobs', () => {
  const s = sampler(RECTS)
  const out = allocLedColors(LEDS)
  assert.throws(() => s.sample(solid(0, 0, 0, 32, 18), out, 'mean'), RangeError)
  assert.throws(() => s.sample({ width: W, height: H, data: new Float32Array(W * H * 3 - 1) }, out, 'mean'), RangeError)
  assert.throws(() => s.sample(solid(0, 0, 0), new Float32Array(LEDS * 3 - 1), 'mean'), RangeError)
  assert.throws(() => s.sample(solid(0, 0, 0), out, 'median' as SampleMode), RangeError)

  // ImageToLedsMap.cpp:31-32 asserts these in debug builds only.
  assert.throws(() => s.setBorder({ unknown: false, topBottom: 18, leftRight: 0 }), RangeError)
  assert.throws(() => s.setBorder({ unknown: false, topBottom: 0, leftRight: 32 }), RangeError)
  assert.throws(() => s.setBorder({ unknown: false, topBottom: -1, leftRight: 0 }), RangeError)
  assert.throws(() => s.setBorder({ unknown: false, topBottom: 1.5, leftRight: 0 }), RangeError)
  assert.throws(() => s.pixelIndices(LEDS), RangeError)

  assert.throws(() => sampler([{ xMin: -0.1, xMax: 0.5, yMin: 0, yMax: 1 }]), RangeError)
  assert.throws(() => sampler([{ xMin: 0, xMax: 1.5, yMin: 0, yMax: 1 }]), RangeError)
  assert.throws(() => sampler([{ xMin: 0, xMax: 1, yMin: Number.NaN, yMax: 1 }]), RangeError)
  assert.throws(() => sampler(RECTS, 0, H), RangeError)
  assert.throws(() => sampler(RECTS, W, 7.5), RangeError)
  assert.throws(() => sampler(RECTS, W, H, { reducedPixelSetFactor: 4 }), RangeError)
  assert.throws(() => sampler(RECTS, W, H, { reducedPixelSetFactor: 0.5 }), RangeError)
  assert.throws(() => sampler(RECTS, W, H, { accuracyLevel: 2.5 }), RangeError)
})

// ---------------------------------------------------------------------------
// Adversarial coverage: the edges the spec makes reachable.
// ---------------------------------------------------------------------------

/** The offsets of a pixel box read at `step` along both axes, row-major, as the map should hold them. */
function boxIndices (box: Box, width: number, step: number): number[] {
  const out: number[] = []
  for (let y = box.y0; y < box.y1; y += step) {
    for (let x = box.x0; x < box.x1; x += step) out.push(y * width + x)
  }
  return out
}

/** ImageToLedsMap.cpp:58-98 end to end, guard included: what one LED's index list must be. */
function referenceIndices (rect: LedRect, width: number, height: number, leftRight: number, topBottom: number, factor: number): number[] {
  if (rect.xMax - rect.xMin < 1e-6 || rect.yMax - rect.yMin < 1e-6) return []
  const box = pixelBox(rect, width, height, leftRight, topBottom)
  let step = factor + 1
  if (step === 1 && (box.y1 - box.y0) * (box.x1 - box.x0) > LARGE_REGION_PIXELS) step = 2
  return boxIndices(box, width, step)
}

function meanOf (g: LinearGrid, indices: readonly number[]): Rgb {
  const sum = [0, 0, 0]
  for (const i of indices) {
    for (let c = 0; c < 3; c++) sum[c]! += g.data[i * 3 + c]!
  }
  return [sum[0]! / indices.length, sum[1]! / indices.length, sum[2]! / indices.length]
}

function pixelsOf (g: LinearGrid): Rgb[] {
  const out: Rgb[] = []
  for (let i = 0; i < g.width * g.height; i++) out.push([g.data[i * 3]!, g.data[i * 3 + 1]!, g.data[i * 3 + 2]!])
  return out
}

/**
 * Lloyd's k-means exactly as the module describes its own: fixed seeds,
 * squared Euclidean with ties to the lower cluster, populated centroids move
 * to their mean, stop when the largest move is under KMEANS_CONVERGENCE or
 * at `cap` iterations, answer the most-populated cluster (first wins a tie).
 * Written from the description, not the code, so it can disagree.
 */
function referenceKMeans (pixels: readonly Rgb[], k: number, cap: number): { colour: Rgb, iterations: number } {
  const c: [number, number, number][] = CLUSTER_SEEDS.slice(0, k).map((s) => [s.r, s.g, s.b])
  let members: number[] = []
  let iterations = 0
  while (iterations < cap) {
    const sums = c.map((): [number, number, number] => [0, 0, 0])
    members = c.map(() => 0)
    for (const p of pixels) {
      let best = 0
      let bestDistance = Number.POSITIVE_INFINITY
      for (let j = 0; j < k; j++) {
        const d = (p[0] - c[j]![0]) ** 2 + (p[1] - c[j]![1]) ** 2 + (p[2] - c[j]![2]) ** 2
        if (d < bestDistance) {
          bestDistance = d
          best = j
        }
      }
      sums[best]![0] += p[0]
      sums[best]![1] += p[1]
      sums[best]![2] += p[2]
      members[best]!++
    }
    let maxMove = 0
    for (let j = 0; j < k; j++) {
      const n = members[j]!
      if (n === 0) continue
      const next: [number, number, number] = [sums[j]![0] / n, sums[j]![1] / n, sums[j]![2] / n]
      maxMove = Math.max(maxMove, Math.hypot(next[0] - c[j]![0], next[1] - c[j]![1], next[2] - c[j]![2]))
      c[j] = next
    }
    iterations++
    if (maxMove < KMEANS_CONVERGENCE) break
  }
  let dominant = 0
  for (let j = 1; j < k; j++) if (members[j]! > members[dominant]!) dominant = j
  return { colour: c[dominant]!, iterations }
}

test('a border on every side insets every LED to the reference box, with and without a pixel skip', () => {
  // Column in red, row in green, and a blue that is not a function of either
  // alone, so no wrong read of any kind averages to the right answer.
  const ramp = grid(W, H, (x, y) => [x / (W - 1), y / (H - 1), ((x * 7 + y * 13) % 17) / 16])
  const border = { leftRight: 5, topBottom: 3 }
  for (const factor of [0, 2]) {
    const s = sampler(RECTS, W, H, { reducedPixelSetFactor: factor })
    assert.equal(s.setBorder({ unknown: false, ...border }), true)
    const out = sampleAll(s, ramp, 'mean')
    for (let i = 0; i < LEDS; i++) {
      const expected = referenceIndices(RECTS[i]!, W, H, border.leftRight, border.topBottom, factor)
      assert.ok(expected.length > 0, `LED ${i} keeps at least one pixel`)
      assert.deepEqual(Array.from(s.pixelIndices(i)), expected, `LED ${i} indices at factor ${factor}`)
      for (const p of expected) {
        const x = p % W
        const y = Math.floor(p / W)
        assert.ok(x >= border.leftRight && x < W - border.leftRight && y >= border.topBottom && y < H - border.topBottom, `LED ${i} reads (${x}, ${y}) in a bar`)
      }
      assertLed(out, i, meanOf(ramp, expected), 1e-6, `LED ${i} at factor ${factor}`)
    }
  }
})

test('the largest legal border leaves every LED at least one pixel of picture, and one more is refused', () => {
  const s = sampler(RECTS)
  const lr = (W - 1) >> 1 // 31: two columns of picture
  const tb = (H - 1) >> 1 // 17: two rows
  assert.equal(s.setBorder({ unknown: false, leftRight: lr, topBottom: tb }), true)
  const picture = new Set([tb * W + lr, tb * W + lr + 1, (tb + 1) * W + lr, (tb + 1) * W + lr + 1])
  for (let i = 0; i < LEDS; i++) {
    const idx = s.pixelIndices(i)
    assert.ok(idx.length >= 1, `LED ${i} has a pixel`)
    for (const p of idx) assert.ok(picture.has(p), `LED ${i} reads ${p}, outside the 2x2 picture`)
  }
  // Light the picture and nothing else: every LED is lit in every per-LED mode.
  const g = grid(W, H, (x, y) => (picture.has(y * W + x) ? [0.25 + 0.5 * (x - lr), 0.25 + 0.5 * (y - tb), 0.5] : [0, 0, 0]))
  for (const mode of PER_LED_MODES) {
    const out = sampleAll(s, g, mode)
    for (let i = 0; i < LEDS; i++) {
      const [r, gg, b] = led(out, i)
      assert.ok(r >= 0.25 && gg >= 0.25 && b === 0.5, `${mode} LED ${i} = ${r}, ${gg}, ${b}`)
    }
  }
  assert.throws(() => s.setBorder({ unknown: false, leftRight: lr + 1, topBottom: tb }), RangeError)
  assert.throws(() => s.setBorder({ unknown: false, leftRight: lr, topBottom: tb + 1 }), RangeError)
  // A refused border leaves the previous map in place.
  assert.deepEqual(s.border(), { unknown: false, leftRight: lr, topBottom: tb })
  for (const p of s.pixelIndices(0)) assert.ok(picture.has(p))

  // An odd grid with a one-pixel picture: all 108 LEDs read pixel (2, 1).
  const tiny = sampler(RECTS, 5, 3)
  assert.equal(tiny.setBorder({ unknown: false, leftRight: 2, topBottom: 1 }), true)
  for (let i = 0; i < LEDS; i++) assert.deepEqual(Array.from(tiny.pixelIndices(i)), [1 * 5 + 2], `LED ${i}`)
})

test('the large-region guard fires above 1600 pixels, not at 1600', () => {
  const checker = (w: number, h: number): LinearGrid => grid(w, h, (x, y) => ((x + y) % 2 === 0 ? [1, 1, 1] : [0, 0, 0]))

  const at = sampler(FULL_FRAME, 40, 40)
  assert.deepEqual(at.warnings, [])
  assert.equal(at.pixelIndices(0).length, LARGE_REGION_PIXELS)
  assert.deepEqual(led(sampleAll(at, checker(40, 40), 'mean'), 0), [0.5, 0.5, 0.5])

  const over = sampler(FULL_FRAME, 41, 40)
  assert.equal(over.warnings.length, 1)
  assert.deepEqual(Array.from(over.pixelIndices(0)), boxIndices({ x0: 0, x1: 41, y0: 0, y1: 40 }, 41, 2))
  assert.equal(over.pixelIndices(0).length, 21 * 20)
  assert.deepEqual(led(sampleAll(over, checker(41, 40), 'mean'), 0), [1, 1, 1])
})

test('an empty layout is a sampler of zero LEDs that every mode leaves alone', () => {
  const s = sampler([])
  assert.equal(s.count, 0)
  assert.deepEqual(s.warnings, [])
  const out = allocLedColors(0)
  for (const mode of SAMPLE_MODES) assert.equal(s.sample(solid(0.3, 0.6, 0.9), out, mode), out)
  assert.throws(() => s.pixelIndices(0), RangeError)
  assert.equal(s.setBorder({ unknown: false, leftRight: 4, topBottom: 2 }), true)
  for (const mode of SAMPLE_MODES) assert.equal(s.sample(solid(0.3, 0.6, 0.9), out, mode), out)
})

test('a 1x1 grid: one LED and all 108 LEDs read the single pixel in every mode', () => {
  const g = solid(0.2, 0.7, 0.4, 1, 1)
  for (const layout of [FULL_FRAME, RECTS]) {
    const s = sampler(layout, 1, 1)
    assert.deepEqual(s.warnings, [])
    for (let i = 0; i < s.count; i++) assert.deepEqual(Array.from(s.pixelIndices(i)), [0], `LED ${i}`)
    for (const mode of SAMPLE_MODES) {
      const out = sampleAll(s, g, mode)
      for (let i = 0; i < s.count; i++) assert.deepEqual(led(out, i), [f(0.2), f(0.7), f(0.4)], `${mode} LED ${i}`)
    }
    assert.throws(() => s.setBorder({ unknown: false, leftRight: 1, topBottom: 0 }), RangeError)
    assert.throws(() => s.setBorder({ unknown: false, leftRight: 0, topBottom: 1 }), RangeError)
    // An unknown border carries no insets, however wild the numbers it came with.
    assert.equal(s.setBorder({ unknown: true, leftRight: 99, topBottom: Number.NaN }), false)
  }
})

test('a NaN pixel reaches only the LEDs that read it and leaves nothing behind for the next frame', () => {
  const paint = (x: number, y: number): Rgb => [0.2 + 0.6 * (x / (W - 1)), 0.5, 0.2 + 0.6 * (y / (H - 1))]
  const clean = grid(W, H, paint)
  const poisoned = grid(W, H, (x, y) => (x === 0 && y === 0 ? [Number.NaN, Number.NaN, Number.NaN] : paint(x, y)))
  const s = sampler(RECTS)
  // The top-left corner belongs to the first top LED and the last left LED.
  const readers = range(0, LEDS).filter((i) => s.pixelIndices(i).includes(0))
  assert.deepEqual(readers, [0, LEDS - 1])
  for (const mode of PER_LED_MODES) {
    const expected = sampleAll(s, clean, mode)
    const out = sampleAll(s, poisoned, mode)
    for (let i = 0; i < LEDS; i++) {
      if (readers.includes(i)) continue
      assert.deepEqual(led(out, i), led(expected, i), `${mode} LED ${i}`)
    }
    assert.deepEqual(sampleAll(s, clean, mode), expected, `${mode}: the frame after is exact again`)
  }
})

test('out-of-range floats: the mean is plain arithmetic and dominant pools everything past the ends into the end bins', () => {
  const s = sampler(FULL_FRAME, 10, 10)
  const hot: Rgb = [1.7, -0.5, 2]
  const warm: Rgb = [1.2, -2, 0.5]
  const g = grid(10, 10, (_x, y) => (y < 6 ? hot : warm))
  assertLed(sampleAll(s, g, 'mean'), 0, [0.6 * f(1.7) + 0.4 * f(1.2), 0.6 * f(-0.5) + 0.4 * f(-2), 0.6 * 2 + 0.4 * 0.5])
  // Red 1.7 and 1.2 share the top bin and green -0.5 and -2 the bottom one;
  // blue 2 (top bin) and 0.5 (bin 16) keep the two colours apart, so the
  // 60-pixel colour wins and comes back as it is, unclamped.
  assert.deepEqual(led(sampleAll(s, g, 'dominant'), 0), [f(1.7), f(-0.5), 2])
})

test('every rebuild equals the reference map for that border, through churn and through the buffer growing', () => {
  const layout: LedRect[] = [...FULL_FRAME, ...RECTS]
  const ramp = grid(W, H, (x, y) => [x / (W - 1), y / (H - 1), ((x * 5 + y * 3) % 11) / 10])
  const s = sampler(layout)
  const borders = [
    // FULL_FRAME: 32 x 20 = 640 pixels, more than the 576 the guard left at
    // construction, so the index buffer has to grow.
    { leftRight: 16, topBottom: 8 },
    { leftRight: 20, topBottom: 10 },
    { leftRight: 0, topBottom: 0 },
    // 62 x 34 = 2108: the guard again.
    { leftRight: 1, topBottom: 1 },
    // 40 x 36 = 1440: under the guard, 1440 pixels, another growth.
    { leftRight: 12, topBottom: 0 },
    { leftRight: 0, topBottom: 0 }
  ]
  for (let round = 0; round < 3; round++) {
    for (const b of borders) {
      s.setBorder({ unknown: false, ...b })
      const fresh = sampler(layout)
      fresh.setBorder({ unknown: false, ...b })
      assert.deepEqual(s.warnings, fresh.warnings, `warnings at ${JSON.stringify(b)}`)
      const out = sampleAll(s, ramp, 'mean')
      for (let i = 0; i < s.count; i++) {
        const expected = referenceIndices(layout[i]!, W, H, b.leftRight, b.topBottom, 0)
        assert.deepEqual(Array.from(s.pixelIndices(i)), expected, `LED ${i} at ${JSON.stringify(b)}`)
        assertLed(out, i, meanOf(ramp, expected), 1e-6, `LED ${i} at ${JSON.stringify(b)}`)
      }
      for (const mode of SAMPLE_MODES) assert.deepEqual(sampleAll(s, ramp, mode), sampleAll(fresh, ramp, mode), `${mode} at ${JSON.stringify(b)}`)
    }
  }
  // Toggling every frame is the caller's right.
  const a = sampleAll(s, ramp, 'mean')
  s.setBorder({ unknown: false, leftRight: 3, topBottom: 2 })
  const bb = sampleAll(s, ramp, 'mean')
  for (let i = 0; i < 500; i++) {
    assert.equal(s.setBorder(i % 2 === 0 ? NO_BORDER : { unknown: false, leftRight: 3, topBottom: 2 }), true)
  }
  assert.deepEqual(sampleAll(s, ramp, 'mean'), bb)
  s.setBorder(NO_BORDER)
  assert.deepEqual(sampleAll(s, ramp, 'mean'), a)
})

test('dominantAdvanced stops at the iteration cap on a chain that Lloyd\'s would keep walking', () => {
  // 400 black pixels pin the first centroid at black. The 24 greens are each
  // placed just above the boundary the previous capture leaves behind, so
  // every iteration moves the second centroid by more than 1/255 and takes
  // exactly one more of them: 25 iterations to converge, uncapped.
  const chain = [
    0.9, 0.475, 0.3972, 0.3198, 0.2786, 0.2495, 0.2279, 0.211, 0.1974, 0.1862, 0.1766, 0.1684,
    0.1613, 0.1549, 0.1493, 0.1443, 0.1397, 0.1355, 0.1317, 0.1282, 0.125, 0.1219, 0.1191, 0.1165
  ]
  const blacks = 400
  const w = 53
  const h = 8
  assert.equal(w * h, blacks + chain.length)
  const g = grid(w, h, (x, y) => {
    const i = y * w + x
    return i < blacks ? [0, 0, 0] : [0, chain[i - blacks]!, 0]
  })
  const pixels = pixelsOf(g)
  const uncapped = referenceKMeans(pixels, 2, Number.POSITIVE_INFINITY)
  assert.ok(uncapped.iterations > KMEANS_MAX_ITERATIONS, `needs ${uncapped.iterations} iterations uncapped`)
  const capped = referenceKMeans(pixels, 2, KMEANS_MAX_ITERATIONS)
  assert.ok(Math.abs(capped.colour[1] - uncapped.colour[1]) > 1e-4, 'the cap changes the answer, so the test can see it')

  const s = sampler(FULL_FRAME, w, h, { accuracyLevel: 1 })
  const out = sampleAll(s, g, 'dominantAdvanced')
  assertLed(out, 0, capped.colour, 1e-7, 'the state after exactly KMEANS_MAX_ITERATIONS')
  // The same chain through the other modes stays inside the content.
  for (const mode of ['dominant', 'mean', 'meanSquared', 'unicolorDominantAdvanced'] as const) {
    const [r, gg, b] = led(sampleAll(s, g, mode), 0)
    assert.ok(r === 0 && b === 0 && gg >= 0 && gg <= 0.9, `${mode} = ${r}, ${gg}, ${b}`)
  }
})

test('dominantAdvanced: a tie between seeds goes to the lower cluster, and content on the seeds converges without moving', () => {
  // Every pixel exactly as far from black as from green: cluster 0 takes all.
  const two = sampler(FULL_FRAME, 8, 8, { accuracyLevel: 1 })
  assert.deepEqual(led(sampleAll(two, solid(0, 0.5, 0, 8, 8), 'dominantAdvanced'), 0), [0, 0.5, 0])

  // Rows of the five seeds, yellow the widest.
  const seeds = CLUSTER_SEEDS.map((c): Rgb => [c.r, c.g, c.b])
  const g = grid(10, 10, (_x, y) => seeds[y < 2 ? 0 : y < 4 ? 1 : y < 6 ? 2 : y < 7 ? 3 : 4]!)
  const five = sampler(FULL_FRAME, 10, 10, { accuracyLevel: 4 })
  assert.deepEqual(led(sampleAll(five, g, 'dominantAdvanced'), 0), [1, 1, 0])
  // With three clusters yellow is as far from green as from white and goes
  // to green; red is nearest black. Green's cluster holds 30 yellow and 20
  // green pixels, more than any other, and its centroid is their mean.
  const three = sampler(FULL_FRAME, 10, 10, { accuracyLevel: 2 })
  assertLed(sampleAll(three, g, 'dominantAdvanced'), 0, [0.6, 1, 0])
  assert.deepEqual(led(sampleAll(three, g, 'dominantAdvanced'), 0), led(sampleAll(three, g, 'unicolorDominantAdvanced'), 0))
})

test('an inverted or sub-micro rectangle has no area, maps to no pixels and samples black without complaint', () => {
  const layout: LedRect[] = [
    { xMin: 0.6, xMax: 0.4, yMin: 0, yMax: 1 },
    { xMin: 0, xMax: 1, yMin: 0.9, yMax: 0.1 },
    { xMin: 0.5, xMax: 0.5 + 9e-7, yMin: 0, yMax: 1 },
    ...FULL_FRAME
  ]
  const s = sampler(layout)
  for (let i = 0; i < 3; i++) assert.equal(s.pixelIndices(i).length, 0, `LED ${i}`)
  const g = solid(0.4, 0.5, 0.6)
  for (const mode of PER_LED_MODES) {
    const out = sampleAll(s, g, mode)
    for (let i = 0; i < 3; i++) assert.deepEqual(led(out, i), [0, 0, 0], `${mode} LED ${i}`)
    assertLed(out, 3, [f(0.4), f(0.5), f(0.6)], 1e-6, mode)
  }
  // The unicolor modes never look at the map, so the empty LEDs light too.
  for (const mode of ['unicolorMean', 'unicolorDominant', 'unicolorDominantAdvanced'] as const) {
    const out = sampleAll(s, g, mode)
    for (let i = 0; i < 4; i++) assertLed(out, i, [f(0.4), f(0.5), f(0.6)], 1e-6, `${mode} LED ${i}`)
  }
})

test('a 1280x720 grid: the guard fires on every LED, names eight and counts the rest, and every LED still averages its stepped box', () => {
  const w = 1280
  const h = 720
  const s = sampler(RECTS, w, h)
  assert.equal(s.warnings.length, 1)
  assert.match(s.warnings[0]!, /108 LED region/)
  assert.match(s.warnings[0]!, /LED 0, 1, 2, 3, 4, 5, 6, 7 and 100 more/)
  // Column in red, row in green, a checkerboard in blue.
  const ramp = grid(w, h, (x, y) => [x / (w - 1), y / (h - 1), (x + y) % 2])
  const out = sampleAll(s, ramp, 'mean')
  for (let i = 0; i < LEDS; i++) {
    const expected = referenceIndices(RECTS[i]!, w, h, 0, 0, 0)
    assert.equal(s.pixelIndices(i).length, expected.length, `LED ${i} pixel count`)
    assertLed(out, i, meanOf(ramp, expected), 1e-6, `LED ${i}`)
    // Every second pixel on both axes sees one parity of the checkerboard
    // only: the bias the warning exists to disclose.
    const blue = led(out, i)[2]
    assert.ok(blue === 0 || blue === 1, `LED ${i} blue ${blue}`)
  }
  // The unicolor modes still walk all 921 600 pixels.
  assertLed(sampleAll(s, ramp, 'unicolorMean'), 0, [0.5, 0.5, 0.5], 1e-6)
  for (const mode of ['unicolorDominant', 'unicolorDominantAdvanced'] as const) {
    const [r, gg, b] = led(sampleAll(s, ramp, mode), 0)
    assert.ok(Number.isFinite(r) && Number.isFinite(gg) && Number.isFinite(b), mode)
  }
})

test('the accuracy warning survives every rebuild while the guard warning comes and goes', () => {
  const s = sampler(FULL_FRAME, W, H, { accuracyLevel: 9 })
  assert.equal(s.warnings.length, 2)
  assert.match(s.warnings[0]!, /accuracyLevel 9/)
  assert.match(s.warnings[1]!, new RegExp(String(LARGE_REGION_PIXELS)))
  const same = s.warnings
  s.setBorder({ unknown: false, leftRight: 16, topBottom: 8 })
  assert.equal(s.warnings, same, 'one array for the life of the sampler')
  assert.equal(s.warnings.length, 1)
  assert.match(s.warnings[0]!, /accuracyLevel 9/)
  s.setBorder(NO_BORDER)
  assert.equal(s.warnings.length, 2)
  assert.match(s.warnings[0]!, /accuracyLevel 9/)
})

test('a rectangle edge that lands on a half pixel rounds up, as qRound does', () => {
  const s = sampler([
    { xMin: 0, xMax: 0.25, yMin: 0, yMax: 1 },
    { xMin: 0.25, xMax: 1, yMin: 0, yMax: 1 },
    { xMin: 0.05, xMax: 0.15, yMin: 0, yMax: 1 }
  ], 10, 1)
  // 10 * 0.25 = 2.5 -> 3: the first LED owns columns 0..2 and the second 3..9.
  assert.deepEqual(Array.from(s.pixelIndices(0)), [0, 1, 2])
  assert.deepEqual(Array.from(s.pixelIndices(1)), [3, 4, 5, 6, 7, 8, 9])
  // 0.5 -> 1 and 1.5 -> 2: one column, the second.
  assert.deepEqual(Array.from(s.pixelIndices(2)), [1])
})

test('a longer grid buffer and a longer output buffer are accepted, and only count * 3 floats are written', () => {
  const s = sampler(RECTS)
  const g = solid(0.3, 0.6, 0.9)
  const data = new Float32Array(W * H * 3 + 5).fill(0.1)
  data.set(g.data)
  const bigger: LinearGrid = { width: W, height: H, data }
  const out = new Float32Array(LEDS * 3 + 3)
  for (const mode of SAMPLE_MODES) {
    out.fill(0.7)
    s.sample(bigger, out, mode)
    for (let i = 0; i < LEDS; i++) assert.deepEqual(led(out, i), [f(0.3), f(0.6), f(0.9)], `${mode} LED ${i}`)
    assert.deepEqual(Array.from(out.subarray(LEDS * 3)), [f(0.7), f(0.7), f(0.7)], `${mode} stays inside count * 3`)
  }
})
