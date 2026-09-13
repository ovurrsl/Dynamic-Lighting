import assert from 'node:assert/strict'
import test from 'node:test'

import { REFERENCE_LAYOUT, classicLayout, ledCount } from '#lib/engine/layout'
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
