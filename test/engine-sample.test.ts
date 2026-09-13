import assert from 'node:assert/strict'
import test from 'node:test'

import { REFERENCE_LAYOUT, classicLayout, ledCount } from '#lib/engine/layout'
import { createSampler, resolveRegions, type LedRegion } from '#lib/engine/sample'
import { NO_BORDER, type Border, type LedRect, type LinearGrid } from '#lib/engine/types'
import { srgbToLinear } from '#lib/light'

/** The capture grid the plan settled on: 128x72, ~3.7 cells per top LED. */
const W = 128
const H = 72
const RECTS = classicLayout(REFERENCE_LAYOUT)
const LEDS = ledCount(REFERENCE_LAYOUT)
const { top, right, bottom } = REFERENCE_LAYOUT

function grid (width: number, height: number, paint: (x: number, y: number) => readonly [number, number, number]): LinearGrid {
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

const solid = (r: number, g: number, b: number) => grid(W, H, () => [r, g, b])

function led (colors: Float32Array, i: number): [number, number, number] {
  return [colors[i * 3] as number, colors[i * 3 + 1] as number, colors[i * 3 + 2] as number]
}

test('a uniform grid reads as that colour on every LED, exactly', () => {
  const sampler = createSampler(RECTS, { width: W, height: H })
  const out = sampler.sample(solid(0.25, 0.5, 0.75))
  assert.equal(out.length, LEDS * 3)
  for (let i = 0; i < LEDS; i++) assert.deepEqual(led(out, i), [0.25, 0.5, 0.75], `LED ${i}`)
})

test('the reference layout on 128x72 tiles each edge without gaps and every LED sees a few cells', () => {
  const regions = createSampler(RECTS, { width: W, height: H }).regions()
  assert.equal(regions.length, LEDS)
  const depthTB = Math.round(H * REFERENCE_LAYOUT.depthTopBottom) // 9
  const depthLR = Math.round(W * REFERENCE_LAYOUT.depthLeftRight) // 10
  assert.equal(depthTB, 9)
  assert.equal(depthLR, 10)

  // Top, left to right: columns tile 0..128, three or four wide, rows 0..9.
  for (let j = 0; j < top; j++) {
    const r = regions[j] as LedRegion
    assert.equal(r.y0, 0)
    assert.equal(r.y1, depthTB)
    assert.ok(r.x1 - r.x0 >= 3 && r.x1 - r.x0 <= 4, `top LED ${j} is ${r.x1 - r.x0} wide`)
    if (j > 0) assert.equal(r.x0, (regions[j - 1] as LedRegion).x1, `top LED ${j} starts where ${j - 1} ends`)
  }
  assert.equal((regions[0] as LedRegion).x0, 0)
  assert.equal((regions[top - 1] as LedRegion).x1, W)

  // Right, top to bottom: rows tile 0..72, columns 118..128.
  for (let j = 0; j < right; j++) {
    const r = regions[top + j] as LedRegion
    assert.equal(r.x0, W - depthLR)
    assert.equal(r.x1, W)
    assert.ok(r.y1 - r.y0 >= 3 && r.y1 - r.y0 <= 4, `right LED ${j} is ${r.y1 - r.y0} tall`)
    if (j > 0) assert.equal(r.y0, (regions[top + j - 1] as LedRegion).y1)
  }
  assert.equal((regions[top] as LedRegion).y0, 0)
  assert.equal((regions[top + right - 1] as LedRegion).y1, H)

  // Bottom runs right to left, left runs bottom to top; the ends must meet.
  assert.equal((regions[top + right] as LedRegion).x1, W)
  assert.equal((regions[top + right + bottom - 1] as LedRegion).x0, 0)
  assert.equal((regions[top + right + bottom] as LedRegion).y1, H)
  assert.equal((regions[LEDS - 1] as LedRegion).y0, 0)
  for (let j = 0; j < bottom; j++) {
    const r = regions[top + right + j] as LedRegion
    assert.equal(r.y0, H - depthTB)
    assert.equal(r.y1, H)
  }
})

test('each LED reads the centre of its own rectangle, with and without a side border (Hyperion defect #1)', () => {
  // Every cell carries its own position, so a region's mean is its centre.
  const positions = grid(W, H, (x, y) => [(x + 0.5) / W, (y + 0.5) / H, 0])
  const borders: Array<Readonly<Border>> = [
    NO_BORDER,
    { unknown: false, topBottom: 4, leftRight: 10 }
  ]

  for (const border of borders) {
    const sampler = createSampler(RECTS, { width: W, height: H, border })
    const out = sampler.sample(positions)
    const actualWidth = W - 2 * border.leftRight
    const actualHeight = H - 2 * border.topBottom
    for (let i = 0; i < LEDS; i++) {
      const rect = RECTS[i] as LedRect
      const [cx, cy] = led(out, i)
      const expectedX = (border.leftRight + actualWidth * (rect.xMin + rect.xMax) / 2) / W
      const expectedY = (border.topBottom + actualHeight * (rect.yMin + rect.yMax) / 2) / H
      // Each edge rounds to a cell, so the centre can be off by half a cell.
      assert.ok(Math.abs(cx - expectedX) <= 0.75 / W, `LED ${i} x ${cx} vs ${expectedX} (border ${border.leftRight})`)
      assert.ok(Math.abs(cy - expectedY) <= 0.75 / H, `LED ${i} y ${cy} vs ${expectedY} (border ${border.topBottom})`)
    }
  }
  // Hyperion addresses pixels as `y * actualWidth + x` (ImageToLedsMap.cpp:96).
  // With leftRight = 10 that drifts every row by 20 columns, which the x
  // assertions above would catch on any LED below the first row.
})

test('averaging happens in linear light: a black-and-white checkerboard reads mid-grey in light', () => {
  const whole: LedRect[] = [{ xMin: 0, xMax: 1, yMin: 0, yMax: 1 }]
  const checker = grid(W, H, (x, y) => ((x + y) % 2 === 0 ? [1, 1, 1] : [0, 0, 0]))
  const out = createSampler(whole, { width: W, height: H }).sample(checker)
  assert.deepEqual(led(out, 0), [0.5, 0.5, 0.5])
  // The same board averaged as sRGB bytes would also come out "0.5" - but that
  // 0.5 is an encoded value, and the light it stands for is 0.214. Hyperion's
  // default `mean` does exactly that, and the plan names it as the source of
  // its luminance pumping. The grid here is linear, so 0.5 means half the light.
  assert.ok(srgbToLinear(0.5) < 0.22)
})

test('a letterbox inset lifts the top and bottom LEDs off the black bars', () => {
  const bars = 9
  const film = grid(W, H, (_x, y) => (y < bars || y >= H - bars ? [0, 0, 0] : [1, 0, 0]))
  const sampler = createSampler(RECTS, { width: W, height: H })

  // Without the inset the top region (rows 0..9) is the bar itself.
  const before = sampler.sample(film)
  for (let j = 0; j < top; j++) assert.deepEqual(led(before, j), [0, 0, 0], `top LED ${j} before`)
  for (let j = 0; j < bottom; j++) assert.deepEqual(led(before, top + right + j), [0, 0, 0], `bottom LED ${j} before`)

  const untouched = sampler.regions()
  assert.equal(sampler.setBorder({ unknown: false, topBottom: bars, leftRight: 0 }), true)
  assert.notEqual(sampler.regions(), untouched)
  const after = sampler.sample(film)
  for (let j = 0; j < top; j++) assert.deepEqual(led(after, j), [1, 0, 0], `top LED ${j} after`)
  for (let j = 0; j < bottom; j++) assert.deepEqual(led(after, top + right + j), [1, 0, 0], `bottom LED ${j} after`)
  // The side LEDs are inset too, so none of them sees a bar either.
  for (let i = 0; i < LEDS; i++) assert.deepEqual(led(after, i), [1, 0, 0], `LED ${i} after`)

  // An equal border is a no-op the caller can afford every frame.
  const rebuilt = sampler.regions()
  assert.equal(sampler.setBorder({ unknown: false, topBottom: bars, leftRight: 0 }), false)
  assert.equal(sampler.regions(), rebuilt)
})

test('an unknown border insets nothing, whatever sizes it carries', () => {
  const sampler = createSampler(RECTS, { width: W, height: H })
  const plain = sampler.regions()
  assert.equal(sampler.setBorder({ unknown: true, topBottom: 0, leftRight: 0 }), false)
  assert.equal(sampler.regions(), plain)
  assert.equal(sampler.setBorder({ unknown: true, topBottom: 20, leftRight: 20 }), false)
  assert.equal(sampler.regions(), plain)
  assert.equal(sampler.border().unknown, true)
})

test('a rectangle without area reads black; a sliver still gets one cell', () => {
  const rects: LedRect[] = [
    { xMin: 0, xMax: 0, yMin: 0, yMax: 0 },
    { xMin: 0.5, xMax: 0.5 + 1e-5, yMin: 0.5, yMax: 0.5 + 1e-5 },
    { xMin: 0.999, xMax: 1, yMin: 0.999, yMax: 1 }
  ]
  const regions = resolveRegions(rects, W, H)
  assert.deepEqual(Array.from(regions.subarray(0, 4)), [0, 0, 0, 0])
  // round(64.0) == round(64.00128) collapses; opened by one (cpp:64-72).
  assert.deepEqual(Array.from(regions.subarray(4, 8)), [64, 65, 36, 37])
  // round(127.87) = 128 is past the last column; pulled back to 127.
  assert.deepEqual(Array.from(regions.subarray(8, 12)), [127, 128, 71, 72])

  const marker = grid(W, H, (x, y) => (x === 64 && y === 36 ? [0.2, 0.4, 0.6] : [1, 1, 1]))
  const out = createSampler(rects, { width: W, height: H }).sample(marker)
  assert.deepEqual(led(out, 0), [0, 0, 0])
  assert.deepEqual(led(out, 1), [Math.fround(0.2), Math.fround(0.4), Math.fround(0.6)])
  assert.deepEqual(led(out, 2), [1, 1, 1])
})

test('edges round to the nearest cell the way Hyperion does (qRound, half away from zero)', () => {
  const rects: LedRect[] = [
    { xMin: 0.125, xMax: 0.135, yMin: 0, yMax: 0.5 }, // 12.5 -> 13, 13.5 -> 14
    { xMin: 0.121, xMax: 0.123, yMin: 0, yMax: 0.5 } //  12.1 -> 12, 12.3 -> 12 -> opened to 13
  ]
  const regions = resolveRegions(rects, 100, 10)
  assert.deepEqual(Array.from(regions.subarray(0, 4)), [13, 14, 0, 5])
  assert.deepEqual(Array.from(regions.subarray(4, 8)), [12, 13, 0, 5])
})

test('the sum is exact enough that a 254.9 region is not truncated to 254', () => {
  // Hyperion's calcMeanColor divides integers and casts to uint8, so eleven
  // 255s and one 254 come out as 254. Floats keep the 0.917.
  const rect: LedRect[] = [{ xMin: 0, xMax: 1, yMin: 0, yMax: 1 }]
  const nearly = grid(12, 1, (x) => (x === 0 ? [254 / 255, 0, 0] : [1, 0, 0]))
  const out = createSampler(rect, { width: 12, height: 1 }).sample(nearly)
  const expected = (11 + Math.fround(254 / 255)) / 12
  assert.ok(Math.abs((out[0] as number) - expected) < 1e-7)
  assert.ok((out[0] as number) * 255 > 254.9)
})

test('samples into a caller buffer and returns it', () => {
  const sampler = createSampler(RECTS, { width: W, height: H })
  const out = new Float32Array(LEDS * 3)
  assert.equal(sampler.sample(solid(0.5, 0.5, 0.5), out), out)
  assert.ok(out.every((v) => v === 0.5))
})

test('rejects a grid of another size, a short buffer, an impossible border and rectangles off the unit square', () => {
  const sampler = createSampler(RECTS, { width: W, height: H })
  assert.throws(() => sampler.sample(grid(64, 36, () => [0, 0, 0])), RangeError)
  assert.throws(() => sampler.sample({ width: W, height: H, data: new Float32Array(W * H * 3 - 1) }), RangeError)
  assert.throws(() => sampler.sample(solid(0, 0, 0), new Float32Array(LEDS * 3 - 1)), RangeError)
  // A border that leaves no picture is a detector bug (cpp:30-31 asserts).
  assert.throws(() => sampler.setBorder({ unknown: false, topBottom: 36, leftRight: 0 }), RangeError)
  assert.throws(() => sampler.setBorder({ unknown: false, topBottom: 0, leftRight: 64 }), RangeError)
  assert.throws(() => sampler.setBorder({ unknown: false, topBottom: -1, leftRight: 0 }), RangeError)
  assert.throws(() => sampler.setBorder({ unknown: false, topBottom: 1.5, leftRight: 0 }), RangeError)
  assert.throws(() => createSampler([{ xMin: -0.1, xMax: 0.5, yMin: 0, yMax: 1 }], { width: W, height: H }), RangeError)
  assert.throws(() => createSampler([{ xMin: 0, xMax: 1.5, yMin: 0, yMax: 1 }], { width: W, height: H }), RangeError)
  assert.throws(() => createSampler([{ xMin: 0, xMax: 1, yMin: Number.NaN, yMax: 1 }], { width: W, height: H }), RangeError)
  assert.throws(() => createSampler(RECTS, { width: 0, height: H }), RangeError)
  assert.throws(() => createSampler(RECTS, { width: W, height: 7.5 }), RangeError)
})
