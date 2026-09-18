import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CORNERS,
  DARK_RECT,
  LAYOUT_DEFAULTS,
  MATRIX_REFERENCE,
  NO_KEYSTONE,
  REFERENCE_LAYOUT,
  applyBlacklist,
  classicLayout,
  cornerIndex,
  ledCount,
  matrixLayout,
  matrixLedCount,
  type Corner,
  type Keystone
} from '#lib/engine/layout'
import type { LedRect } from '#lib/engine/types'

const EPS = 1e-9
const overlaps = (a: LedRect, b: LedRect): boolean =>
  a.xMin < b.xMax - EPS && b.xMin < a.xMax - EPS && a.yMin < b.yMax - EPS && b.yMin < a.yMax - EPS

test('the reference layout is 108 LEDs with the documented edge index ranges', () => {
  const rects = classicLayout(REFERENCE_LAYOUT)
  assert.equal(rects.length, 108)
  assert.equal(ledCount(REFERENCE_LAYOUT), 108)

  // Top edge 0-34 left->right along y=0; corner LED 0 is top-left.
  assert.deepEqual(rects[0], { xMin: 0, xMax: 1 / 35, yMin: 0, yMax: 0.12 })
  assert.ok(rects[34]!.xMax > 0.999 && rects[34]!.yMin === 0)
  // Right edge 35-53 top->bottom along x=1.
  assert.ok(rects[35]!.xMax === 1 && rects[35]!.yMin === 0)
  assert.ok(rects[53]!.yMax === 1)
  // Bottom edge 54-88 right->left along y=1.
  assert.ok(rects[54]!.xMax === 1 && rects[54]!.yMax === 1)
  assert.ok(rects[88]!.xMin === 0)
  // Left edge 89-107 bottom->top along x=0.
  assert.ok(rects[89]!.xMin === 0 && rects[89]!.yMax === 1)
  assert.ok(rects[107]!.yMin === 0)
})

test('within an edge the bands tile without overlapping; only the corner clusters are shared', () => {
  const rects = classicLayout(REFERENCE_LAYOUT)
  const { top, right, bottom, left, depthTopBottom, depthLeftRight } = REFERENCE_LAYOUT
  const edges = [
    [0, top],
    [top, top + right],
    [top + right, top + right + bottom],
    [top + right + bottom, top + right + bottom + left]
  ] as const

  // Same edge: strictly disjoint.
  for (const [from, to] of edges) {
    for (let i = from; i < to; i++) {
      for (let j = i + 1; j < to; j++) {
        assert.ok(!overlaps(rects[i]!, rects[j]!), `LED ${i} overlaps LED ${j} on the same edge`)
      }
    }
  }

  // Opposite edges: never.
  for (const [a, b] of [[0, 2], [1, 3]] as const) {
    const [aFrom, aTo] = edges[a]
    const [bFrom, bTo] = edges[b]
    for (let i = aFrom; i < aTo; i++) {
      for (let j = bFrom; j < bTo; j++) {
        assert.ok(!overlaps(rects[i]!, rects[j]!), `opposite edges overlap: LED ${i} and ${j}`)
      }
    }
  }

  // Adjacent edges: only inside the corner cluster. A side band is
  // depthLeftRight of the width, so it reaches ceil(depthLeftRight * top)
  // LEDs into the top edge, and a top band reaches ceil(depthTopBottom * right)
  // LEDs down a side. Anything overlapping further from the corner is a bug.
  const reachIntoTopOrBottom = Math.ceil(depthLeftRight * Math.max(top, bottom))
  const reachIntoSide = Math.ceil(depthTopBottom * Math.max(right, left))
  const reach = Math.max(reachIntoTopOrBottom, reachIntoSide)
  let cornerOverlaps = 0
  for (let e = 0; e < edges.length; e++) {
    const [aFrom, aTo] = edges[e]!
    const [bFrom, bTo] = edges[(e + 1) % edges.length]!
    for (let i = aFrom; i < aTo; i++) {
      for (let j = bFrom; j < bTo; j++) {
        if (!overlaps(rects[i]!, rects[j]!)) continue
        cornerOverlaps++
        assert.ok(aTo - i <= reach, `LED ${i} is ${aTo - i} from the corner, beyond the band reach ${reach}`)
        assert.ok(j - bFrom < reach, `LED ${j} is ${j - bFrom} from the corner, beyond the band reach ${reach}`)
      }
    }
  }
  assert.ok(cornerOverlaps >= 4, 'every corner must be shared by its two edges')

  for (const r of rects) {
    assert.ok(r.xMin >= 0 && r.xMax <= 1 && r.yMin >= 0 && r.yMax <= 1)
    assert.ok(r.xMax > r.xMin && r.yMax > r.yMin)
  }
})

test('start corner and direction rotate the sequence without changing the set of rectangles', () => {
  const canonical = classicLayout(REFERENCE_LAYOUT)
  const key = (r: LedRect) => [r.xMin, r.xMax, r.yMin, r.yMax].map((v) => v.toFixed(9)).join(',')
  const canonicalSet = new Set(canonical.map(key))

  const cases = [
    { start: 'top-right' as const, clockwise: true, firstIs: canonical[35]! },
    { start: 'bottom-right' as const, clockwise: true, firstIs: canonical[54]! },
    { start: 'bottom-left' as const, clockwise: true, firstIs: canonical[89]! },
    // Counter-clockwise from top-left runs down the left edge first: the LED
    // nearest that corner on the left edge is canonical index 107.
    { start: 'top-left' as const, clockwise: false, firstIs: canonical[107]! },
    { start: 'top-right' as const, clockwise: false, firstIs: canonical[34]! },
    { start: 'bottom-right' as const, clockwise: false, firstIs: canonical[53]! },
    { start: 'bottom-left' as const, clockwise: false, firstIs: canonical[88]! }
  ]

  for (const c of cases) {
    const rects = classicLayout({ ...REFERENCE_LAYOUT, start: c.start, clockwise: c.clockwise })
    assert.equal(rects.length, 108)
    assert.deepEqual(rects[0], c.firstIs, `${c.start} ${c.clockwise ? 'cw' : 'ccw'} starts at the wrong LED`)
    assert.deepEqual(new Set(rects.map(key)), canonicalSet, 'rotation must not invent or lose rectangles')
  }
})

test('rejects layouts that cannot be sampled', () => {
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, top: -1 }), RangeError)
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, top: 0, right: 0, bottom: 0, left: 0 }), RangeError)
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, depthTopBottom: 0 }), RangeError)
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, depthLeftRight: 0.6 }), RangeError)
})

// ---------------------------------------------------------------------------
// Kademe 2: the knobs that make the generator fit a monitor other than this one.
// ---------------------------------------------------------------------------

const CANONICAL = classicLayout(REFERENCE_LAYOUT)
const key = (r: LedRect): string => [r.xMin, r.xMax, r.yMin, r.yMax].map((v) => v.toFixed(9)).join(',')
const keys = (rects: readonly LedRect[]): string[] => rects.map(key)
const near = (actual: number, expected: number, message?: string): void =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} ${actual} vs ${expected}`)

test('every default is the layout we shipped: the new knobs are off unless set', () => {
  const spelled = classicLayout({
    ...REFERENCE_LAYOUT,
    offset: 0,
    overlap: 0,
    edgeGap: 0,
    aspectRatio: 16 / 9,
    keystone: NO_KEYSTONE,
    gap: { position: 0, length: 0 }
  })
  assert.deepEqual(keys(spelled), keys(CANONICAL))
  assert.deepEqual(LAYOUT_DEFAULTS, { offset: 0, overlap: 0, edgeGap: 0, aspectRatio: 16 / 9 })
})

test('offset moves the wire\'s first LED along the strip, and wraps in both directions', () => {
  const by = (offset: number): LedRect[] => classicLayout({ ...REFERENCE_LAYOUT, offset })
  assert.deepEqual(by(0)[0], CANONICAL[0])
  assert.deepEqual(by(17)[0], CANONICAL[17], 'seventeen LEDs into the top edge')
  assert.deepEqual(by(-1)[0], CANONICAL[107], 'one before the corner is the last LED of the cycle')
  assert.deepEqual(by(108)[0], CANONICAL[0], 'a full turn is no turn')
  assert.deepEqual(by(109)[0], CANONICAL[1])
  // The order is a rotation, not a reshuffle: the whole cycle is preserved.
  const rotated = by(54)
  for (let i = 0; i < 108; i++) assert.deepEqual(rotated[i], CANONICAL[(i + 54) % 108], `LED ${i}`)

  // Counter-clockwise, offset runs the way the strip does: away from the corner.
  const ccw = classicLayout({ ...REFERENCE_LAYOUT, clockwise: false, offset: 2 })
  assert.deepEqual(ccw[0], CANONICAL[105], 'two past the top-left going anti-clockwise')
})

test('a gap removes LED positions the strip does not cover, and the LEDs after it move up', () => {
  // The bottom-centre cut where the stand is: positions 70..73 do not exist.
  const gap = { position: 70, length: 4 }
  const rects = classicLayout({ ...REFERENCE_LAYOUT, gap })
  assert.equal(rects.length, 104)
  assert.deepEqual(keys(rects.slice(0, 70)), keys(CANONICAL.slice(0, 70)))
  assert.deepEqual(keys(rects.slice(70)), keys(CANONICAL.slice(74)), 'wire index 70 is the LED after the gap')
  for (const removed of CANONICAL.slice(70, 74)) {
    assert.ok(!keys(rects).includes(key(removed)), 'a removed position is not sampled by anyone')
  }
})

test('a gap that swallows the start corner hands the anchor to the next LED along', () => {
  // The gap covers the whole right edge, the bottom-right corner included.
  const gap = { position: 35, length: 20 }
  const cw = classicLayout({ ...REFERENCE_LAYOUT, start: 'bottom-right', clockwise: true, gap })
  assert.equal(cw.length, 88)
  assert.deepEqual(cw[0], CANONICAL[55], 'the first surviving LED clockwise of that corner')

  // Anti-clockwise from the same corner the walk goes the other way, into the
  // right edge, and lands on the last LED before the gap.
  const ccw = classicLayout({ ...REFERENCE_LAYOUT, start: 'bottom-right', clockwise: false, gap })
  assert.deepEqual(ccw[0], CANONICAL[34])
  assert.deepEqual(new Set(keys(ccw)), new Set(keys(cw)), 'both directions keep the same LEDs')
})

test('the gap composes with the entry point: the anchor is found after the removal, not before', () => {
  // Four LEDs gone from the top edge, so the bottom-left corner is four
  // positions earlier on the wire than the edge counts alone would say.
  const rects = classicLayout({ ...REFERENCE_LAYOUT, gap: { position: 10, length: 4 }, start: 'bottom-left' })
  assert.deepEqual(rects[0], CANONICAL[cornerIndex(REFERENCE_LAYOUT, 'bottom-left')])
  assert.equal(rects.length, 104)
  assert.deepEqual(cornerIndex(REFERENCE_LAYOUT, 'bottom-left'), 89)
})

test('overlap grows every band along its own edge and clamps at the frame', () => {
  const overlap = 0.01
  const rects = classicLayout({ ...REFERENCE_LAYOUT, overlap })
  // A top band grows horizontally only; its depth is untouched.
  near(rects[1]!.xMin, 1 / 35 - overlap, 'top band grew left')
  near(rects[1]!.xMax, 2 / 35 + overlap, 'top band grew right')
  assert.equal(rects[1]!.yMin, 0)
  near(rects[1]!.yMax, 0.12)
  // A right band grows vertically only.
  near(rects[36]!.yMin, 1 / 19 - overlap)
  near(rects[36]!.yMax, 2 / 19 + overlap)
  near(rects[36]!.xMin, 1 - 0.08)
  assert.equal(rects[36]!.xMax, 1)
  // The frame is the limit: the first and last band of an edge cannot leave it.
  assert.equal(rects[0]!.xMin, 0)
  assert.equal(rects[34]!.xMax, 1)
  assert.equal(rects[35]!.yMin, 0)
  assert.equal(rects[53]!.yMax, 1)

  // Neighbours on an edge now share ground, which is the point of the knob.
  assert.ok(overlaps(rects[1]!, rects[2]!), 'neighbouring top bands overlap')
  assert.ok(!overlaps(CANONICAL[1]!, CANONICAL[2]!), 'and did not before')
})

test('edgeGap insets both ends of every edge, by the same physical distance on all four', () => {
  const edgeGap = 0.05
  const aspectRatio = 16 / 9
  const rects = classicLayout({ ...REFERENCE_LAYOUT, edgeGap, aspectRatio })
  const insetH = edgeGap / aspectRatio

  // The top edge starts inset and ends inset, and its bands tile what is left.
  near(rects[0]!.xMin, insetH, 'top edge starts inset')
  near(rects[34]!.xMax, 1 - insetH, 'top edge ends inset')
  near(rects[0]!.xMax - rects[0]!.xMin, (1 - 2 * insetH) / 35, 'band width is the remaining span / 35')
  // The side edges use the fraction as given: 0.05 of the height.
  near(rects[35]!.yMin, edgeGap)
  near(rects[53]!.yMax, 1 - edgeGap)
  // The corner cluster is made by the DEPTHS, not by the edge ends: the top
  // band still reaches x = 0.97 where the right band's 8%-of-width depth
  // starts at 0.92, and the right band still starts at y = 0.05 inside the top
  // band's 12% depth. So this inset does not break the cluster.
  assert.ok(overlaps(rects[34]!, rects[35]!), 'a small inset leaves the corner shared')

  // An inset larger than both depths does break it, which is what the knob is
  // for on a strip that stops well short of the corners.
  const wide = classicLayout({ ...REFERENCE_LAYOUT, edgeGap: 0.15, aspectRatio })
  assert.ok(0.15 / aspectRatio > REFERENCE_LAYOUT.depthLeftRight, 'the horizontal inset clears the side depth')
  assert.ok(0.15 > REFERENCE_LAYOUT.depthTopBottom, 'and the vertical one clears the top depth')
  assert.ok(!overlaps(wide[34]!, wide[35]!), 'the top-right corner cluster is pulled apart')
  assert.ok(overlaps(CANONICAL[34]!, CANONICAL[35]!), 'and was shared by default')

  // A 4:3 panel gets a bigger horizontal fraction for the same distance, and a
  // 21:9 a smaller one. Hyperion hardcodes 16:9 and is wrong on both.
  const fourThree = classicLayout({ ...REFERENCE_LAYOUT, edgeGap, aspectRatio: 4 / 3 })
  near(fourThree[0]!.xMin, edgeGap / (4 / 3))
  assert.ok(fourThree[0]!.xMin > rects[0]!.xMin)
  const ultrawide = classicLayout({ ...REFERENCE_LAYOUT, edgeGap, aspectRatio: 21 / 9 })
  assert.ok(ultrawide[0]!.xMin < rects[0]!.xMin)
})

test('keystone moves the framed area: a strip inset on every side samples only inside it', () => {
  const inset = 0.1
  const keystone: Keystone = {
    topLeft: { x: inset, y: inset },
    topRight: { x: 1 - inset, y: inset },
    bottomRight: { x: 1 - inset, y: 1 - inset },
    bottomLeft: { x: inset, y: 1 - inset }
  }
  const rects = classicLayout({ ...REFERENCE_LAYOUT, keystone })
  assert.equal(rects.length, 108)
  near(rects[0]!.xMin, inset, 'top edge starts at the keystone corner')
  near(rects[0]!.yMin, inset)
  near(rects[34]!.xMax, 1 - inset)
  near(rects[35]!.xMax, 1 - inset, 'the right edge follows the moved corner')
  near(rects[53]!.yMax, 1 - inset)
  near(rects[54]!.yMax, 1 - inset, 'the bottom edge too')
  near(rects[89]!.xMin, inset)
  // Every band is inside the framed area, depths aside.
  for (const r of rects) {
    assert.ok(r.xMin >= inset - 1e-9 && r.xMax <= 1 - inset + 1e-9, `x of ${key(r)}`)
  }
})

test('a tilted top keystone line tilts the top bands with it, each at its own height', () => {
  // The top-right corner sits 6% lower than the top-left: a panel on a stand
  // that is not level, or a strip stuck on crooked.
  const keystone: Keystone = { ...NO_KEYSTONE, topRight: { x: 1, y: 0.06 } }
  const rects = classicLayout({ ...REFERENCE_LAYOUT, keystone })
  const stepY = 0.06 / 35
  for (let i = 0; i < 35; i++) {
    near(rects[i]!.yMin, stepY * i, `top LED ${i} follows the line`)
    near(rects[i]!.yMax, stepY * i + 0.12, `top LED ${i} keeps its depth`)
  }
  // The right edge starts where the tilted corner left off, not at zero.
  near(rects[35]!.yMin, 0.06)
})

test('the matrix generator walks a wall: snake folds every line, parallel does not', () => {
  const spec = { columns: 4, rows: 3, cabling: 'snake' as const, start: 'top-left' as const, direction: 'horizontal' as const }
  const snake = matrixLayout(spec)
  assert.equal(snake.length, 12)
  assert.equal(matrixLedCount(spec), 12)
  // Row 0 left to right, row 1 right to left, row 2 left to right again.
  near(snake[0]!.xMin, 0)
  near(snake[3]!.xMax, 1)
  near(snake[4]!.xMin, 0.75, 'the second row starts at the far side')
  near(snake[7]!.xMax, 0.25)
  near(snake[8]!.xMin, 0, 'and the third is back at the near side')
  // Cells tile the frame exactly: 1/4 by 1/3 each, no overlap, full coverage.
  for (const r of snake) {
    near(r.xMax - r.xMin, 0.25)
    near(r.yMax - r.yMin, 1 / 3)
  }
  for (let i = 0; i < snake.length; i++) {
    for (let j = i + 1; j < snake.length; j++) {
      assert.ok(!overlaps(snake[i]!, snake[j]!), `cells ${i} and ${j} overlap`)
    }
  }

  const parallel = matrixLayout({ ...spec, cabling: 'parallel' })
  near(parallel[4]!.xMin, 0, 'every parallel row starts at the same side')
  near(parallel[8]!.xMin, 0)
  assert.deepEqual(new Set(keys(parallel)), new Set(keys(snake)), 'same cells, different order')
})

test('the matrix start corner and direction pick which cell is first and which axis runs inner', () => {
  const base = { columns: 3, rows: 2, cabling: 'parallel' as const, direction: 'horizontal' as const, start: 'top-left' as const }
  const first = (start: Corner): LedRect => matrixLayout({ ...base, start })[0]!
  near(first('top-left').xMin, 0)
  near(first('top-left').yMin, 0)
  near(first('top-right').xMax, 1)
  near(first('top-right').yMin, 0)
  near(first('bottom-left').yMax, 1)
  near(first('bottom-right').xMax, 1)
  near(first('bottom-right').yMax, 1)

  // Vertical runs down a column before moving across.
  const vertical = matrixLayout({ ...base, direction: 'vertical' })
  near(vertical[0]!.xMin, 0)
  near(vertical[1]!.xMin, 0, 'the second cell is below the first, not beside it')
  near(vertical[1]!.yMin, 0.5)
  near(vertical[2]!.xMin, 1 / 3)
})

test('matrix gaps leave the named fractions uncovered and the cells share what is left', () => {
  const rects = matrixLayout({ ...MATRIX_REFERENCE, columns: 2, rows: 2, gap: { top: 0.1, bottom: 0.2, left: 0.05, right: 0.15 } })
  near(rects[0]!.xMin, 0.05)
  near(rects[0]!.yMin, 0.1)
  near(rects[1]!.xMax, 0.85)
  near(rects[3]!.yMax, 0.8)
  near(rects[0]!.xMax - rects[0]!.xMin, (1 - 0.05 - 0.15) / 2)
  near(rects[0]!.yMax - rects[0]!.yMin, (1 - 0.1 - 0.2) / 2)
})

test('the blacklist darkens LEDs in place: every other wire index is untouched', () => {
  const rects = applyBlacklist(CANONICAL, [{ start: 0, length: 3 }, { start: 100, length: 8 }])
  assert.equal(rects.length, CANONICAL.length, 'the strip is the same length; the cable did not change')
  for (const i of [0, 1, 2, 100, 107]) assert.deepEqual(rects[i], DARK_RECT, `LED ${i} must be dark`)
  for (const i of [3, 50, 99]) assert.deepEqual(rects[i], CANONICAL[i], `LED ${i} must be untouched`)
  assert.deepEqual(DARK_RECT, { xMin: 0, xMax: 0, yMin: 0, yMax: 0 })
  // No rules is the identity, and the input is not mutated.
  assert.deepEqual(applyBlacklist(CANONICAL, []), CANONICAL)
  assert.deepEqual(CANONICAL[0], classicLayout(REFERENCE_LAYOUT)[0])
})

test('a blacklist rule naming LEDs the strip does not have throws instead of doing nothing', () => {
  // Hyperion skips an out-of-range start and truncates an over-long run, so
  // "LED 200 is off" silently holds for nothing at all.
  assert.throws(() => applyBlacklist(CANONICAL, [{ start: 200, length: 1 }]), RangeError)
  assert.throws(() => applyBlacklist(CANONICAL, [{ start: 100, length: 20 }]), RangeError)
  assert.throws(() => applyBlacklist(CANONICAL, [{ start: -1, length: 1 }]), RangeError)
  assert.throws(() => applyBlacklist(CANONICAL, [{ start: 0, length: 0 }]), RangeError)
  assert.throws(() => applyBlacklist(CANONICAL, [{ start: 1.5, length: 1 }]), RangeError)
})

test('rejects the new knobs when they are nonsense', () => {
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, offset: 1.5 }), RangeError)
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, overlap: 0.6 }), RangeError)
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, overlap: -0.1 }), RangeError)
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, edgeGap: 0.3 }), RangeError)
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, aspectRatio: 0 }), RangeError)
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, start: 'middle' as unknown as Corner }), RangeError)
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, clockwise: 'yes' as unknown as boolean }), TypeError)
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, keystone: { ...NO_KEYSTONE, topLeft: { x: 1.2, y: 0 } } }), RangeError)

  // The gap: Hyperion's two clamps are both broken, so these are errors here.
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, gap: { position: 108, length: 1 } }), RangeError)
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, gap: { position: 100, length: 20 } }), RangeError)
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, gap: { position: 0, length: 108 } }), RangeError)
  assert.throws(() => classicLayout({ ...REFERENCE_LAYOUT, gap: { position: 0, length: -1 } }), RangeError)

  assert.throws(() => matrixLayout({ ...MATRIX_REFERENCE, columns: 0 }), RangeError)
  assert.throws(() => matrixLayout({ ...MATRIX_REFERENCE, rows: 1.5 }), RangeError)
  assert.throws(() => matrixLayout({ ...MATRIX_REFERENCE, cabling: 'woven' as unknown as 'snake' }), RangeError)
  assert.throws(() => matrixLayout({ ...MATRIX_REFERENCE, direction: 'diagonal' as unknown as 'horizontal' }), RangeError)
  assert.throws(() => matrixLayout({ ...MATRIX_REFERENCE, gap: { left: 0.5, right: 0.5 } }), RangeError)
  assert.throws(() => matrixLayout({ ...MATRIX_REFERENCE, gap: { top: 1.5 } }), RangeError)
})

test('cornerIndex names the first LED of each edge, and CORNERS lists them in strip order', () => {
  assert.deepEqual(CORNERS.map((c) => cornerIndex(REFERENCE_LAYOUT, c)), [0, 35, 54, 89])
  // An edge with no LEDs makes two corners share an index, which is the
  // honest answer: the nearest LED to both is the same one.
  const noRight = { ...REFERENCE_LAYOUT, right: 0 }
  assert.equal(cornerIndex(noRight, 'top-right'), 35)
  assert.equal(cornerIndex(noRight, 'bottom-right'), 35)
  assert.equal(classicLayout(noRight).length, 89)
  assert.deepEqual(classicLayout({ ...noRight, start: 'bottom-right' })[0], classicLayout(noRight)[35])
})

test('a keystone corner near the far side plus the band depth is clamped to the frame', () => {
  // A rectangle outside the unit square is one the parser accepts and the
  // sampler refuses - the layout applied and the engine threw.
  const keystone: Keystone = { ...NO_KEYSTONE, topLeft: { x: 0, y: 0.6 }, topRight: { x: 1, y: 0.6 } }
  const rects = classicLayout({ ...REFERENCE_LAYOUT, keystone, depthTopBottom: 0.5, depthLeftRight: 0.5 })
  for (const r of rects) {
    assert.ok(r.xMin >= 0 && r.xMax <= 1 && r.yMin >= 0 && r.yMax <= 1, `outside the frame: ${JSON.stringify(r)}`)
    assert.ok(r.xMax >= r.xMin && r.yMax >= r.yMin)
  }
})

test('a three-sided rig starting at the corner of its empty edge is not rotated by one', () => {
  // With no left edge the bottom-left corner's index equals the total, and the
  // anchor lookup fell off the end: the whole wire order came out one LED late.
  const noLeft = { ...REFERENCE_LAYOUT, left: 0 }
  const fromEmptyCorner = classicLayout({ ...noLeft, start: 'bottom-left', clockwise: true })
  const fromTopLeft = classicLayout({ ...noLeft, start: 'top-left', clockwise: true })
  // Leaving the bottom-left clockwise, the strip climbs the (empty) left edge
  // and its first LED is the leftmost of the top edge - exactly where a start
  // at the top-left begins.
  assert.deepEqual(fromEmptyCorner, fromTopLeft)
  assert.equal(fromEmptyCorner[0]!.yMin, 0)

  // Anti-clockwise from the top-left, the first LED is the leftmost of the
  // BOTTOM edge, which sits at the far end of the geometric run.
  const anti = classicLayout({ ...noLeft, start: 'top-left', clockwise: false })
  assert.equal(anti[0]!.yMax, 1)
  assert.ok(anti[0]!.xMin < 0.05)
})
