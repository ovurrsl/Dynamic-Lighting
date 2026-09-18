import assert from 'node:assert/strict'
import test from 'node:test'

import { REFERENCE_LAYOUT, classicLayout } from '#lib/engine/layout'
import { cornerOrder, layoutFromCorners, stepWalk, type CornerMarks } from '#lib/engine/calibrate'

/** The reference rig, walked: 35 top, 19 right, 35 bottom, 19 left, from the top-left. */
const reference = (over: Partial<CornerMarks> = {}): CornerMarks => ({
  indices: [0, 35, 54, 89],
  firstCorner: 'top-left',
  clockwise: true,
  total: 108,
  ...over
})

test('walking the reference rig gives the reference rig back', () => {
  // The whole point: the numbers a user cannot count by eye on a 108-LED reel
  // come out of four button presses.
  const layout = layoutFromCorners(reference())
  assert.deepEqual(layout, {
    top: 35, right: 19, bottom: 35, left: 19, start: 'top-left', clockwise: true, offset: 0
  })
  assert.equal(layout.top, REFERENCE_LAYOUT.top)
  assert.equal(layout.right, REFERENCE_LAYOUT.right)
})

test('the derived layout is one the engine will actually build', () => {
  // A wizard that produces a layout the layout generator then refuses is worse
  // than no wizard, so the answer is fed straight back to it.
  const layout = layoutFromCorners(reference())
  const rects = classicLayout({
    ...layout,
    depthTopBottom: REFERENCE_LAYOUT.depthTopBottom,
    depthLeftRight: REFERENCE_LAYOUT.depthLeftRight
  })
  assert.equal(rects.length, 108)
})

test('each direction maps a corner to the edge you actually travel', () => {
  // Clockwise is seen FROM THE FRONT, which is the opposite of how it looks
  // from behind the monitor where the strip is - the one thing here that is
  // asked rather than inferred.
  assert.deepEqual(cornerOrder('top-left', true), ['top-left', 'top-right', 'bottom-right', 'bottom-left'])
  assert.deepEqual(cornerOrder('top-left', false), ['top-left', 'bottom-left', 'bottom-right', 'top-right'])
  assert.deepEqual(cornerOrder('bottom-right', true), ['bottom-right', 'bottom-left', 'top-left', 'top-right'])

  // Anticlockwise from the top-left goes DOWN the left edge first.
  const anti = layoutFromCorners(reference({ clockwise: false, indices: [0, 19, 54, 73] }))
  assert.deepEqual(anti, {
    top: 35, right: 19, bottom: 35, left: 19, start: 'top-left', clockwise: false, offset: 0
  })
})

test('a strip that starts mid-edge comes out as an offset, not as wrong edges', () => {
  // The bottom-centre cut where the power is injected: LED 0 is halfway along
  // the bottom, and every edge count is still right.
  const marks = reference({ indices: [20, 55, 74, 1] })
  const layout = layoutFromCorners(marks)
  assert.deepEqual(layout, {
    top: 35, right: 19, bottom: 35, left: 19, start: 'top-left', clockwise: true, offset: 88
  })
  // Walking `offset` LEDs from the corner really does land on LED 0.
  assert.equal((20 + layout.offset) % 108, 0)
})

test('marks pressed out of order are refused, not silently accepted', () => {
  // They would produce a layout that is wrong in a way nobody notices until the
  // strip is on the wall - so the failure has to happen here.
  assert.throws(
    () => layoutFromCorners(reference({ indices: [0, 54, 35, 89] })),
    /do not partition/
  )
  assert.throws(() => layoutFromCorners(reference({ indices: [0, 35, 54] })), /four corners/)
  assert.throws(() => layoutFromCorners(reference({ indices: [0, 35, 54, 108] })), /0\.\.107/)
  assert.throws(() => layoutFromCorners(reference({ total: 3 })), /at least 4 LEDs/)
})

test('a three-sided rig is allowed: one edge with no LEDs is a real rig', () => {
  // A strip that skips the bottom edge, where the stand is.
  const layout = layoutFromCorners(reference({ indices: [0, 35, 54, 54], total: 89 }))
  assert.equal(layout.top, 35)
  assert.equal(layout.right, 19)
  assert.equal(layout.bottom, 0)
  assert.equal(layout.left, 35)
})

test('the walk wraps in both directions, because the strip is a loop', () => {
  assert.equal(stepWalk(0, -1, 108), 107)
  assert.equal(stepWalk(107, 1, 108), 0)
  assert.equal(stepWalk(0, -5, 108), 103)
  assert.equal(stepWalk(100, 20, 108), 12)
  assert.equal(stepWalk(5, 0, 0), 0, 'no LEDs is not a crash')
})
