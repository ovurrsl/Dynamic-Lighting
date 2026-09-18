import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ENGINE_CONFIG, parseEngineConfig, resolveLayout, serialiseEngineConfig, type LayoutConfig } from '#lib/engine/config'
import { LAYOUT_DEFAULTS, MATRIX_REFERENCE, NO_KEYSTONE, REFERENCE_LAYOUT } from '#lib/engine/layout'
import { frameAspect, isDefaultKeystone, nudge, pointerToLayout, wireOrderColor } from '#lib/preview'

const classic = (over: Partial<LayoutConfig> = {}): LayoutConfig =>
  ({ kind: 'classic', ...REFERENCE_LAYOUT, ...over } as LayoutConfig)
const matrix = (over: Partial<LayoutConfig> = {}): LayoutConfig =>
  ({ kind: 'matrix', ...MATRIX_REFERENCE, ...over } as LayoutConfig)

test('a classic layout is framed at its own aspect ratio, a matrix at its cell grid', () => {
  assert.equal(frameAspect(DEFAULT_ENGINE_CONFIG.layout), LAYOUT_DEFAULTS.aspectRatio)
  assert.equal(frameAspect(classic({ aspectRatio: 21 / 9 })), 21 / 9)
  // A 32x8 matrix is a wide bar, and framing it 16:9 would squash it.
  assert.equal(frameAspect(matrix({ columns: 32, rows: 8 })), 4)
})

test('a ratio that would collapse or flip the drawing falls back', () => {
  for (const bad of [0, -1.5]) {
    assert.equal(frameAspect(classic({ aspectRatio: bad })), LAYOUT_DEFAULTS.aspectRatio)
  }
})

test('the wire-order ramp never gives the last LED the first one hue', () => {
  const count = resolveLayout(DEFAULT_ENGINE_CONFIG as never).length
  assert.equal(count, 108)
  assert.notEqual(wireOrderColor(count - 1, count), wireOrderColor(0, count))
  assert.match(wireOrderColor(0, count), /^hsl\(0 /)
  // Monotone in index, so the direction the strip runs is readable, not guessable.
  const hue = (at: number): number => Number(/hsl\((\d+(?:\.\d+)?) /.exec(wireOrderColor(at, count))?.[1])
  for (let at = 1; at < count; at += 1) assert.ok(hue(at) > hue(at - 1), `LED ${at}`)
})

test('a single LED, and none at all, still produce a colour', () => {
  assert.match(wireOrderColor(0, 1), /^hsl\(0 /)
  assert.match(wireOrderColor(0, 0), /^hsl\(0 /)
})

test('a pointer maps into layout coordinates through the element it was over', () => {
  const box = { left: 100, top: 50, width: 400, height: 200 }
  assert.deepEqual(pointerToLayout(100, 50, box), { x: 0, y: 0 })
  assert.deepEqual(pointerToLayout(500, 250, box), { x: 1, y: 1 })
  assert.deepEqual(pointerToLayout(300, 150, box), { x: 0.5, y: 0.5 })
  // Forgetting the element's own offset is the classic bug; this is what it
  // would look like if the offset were dropped.
  assert.notDeepEqual(pointerToLayout(300, 150, box), pointerToLayout(300, 150, { ...box, left: 0, top: 0 }))
})

test('a drag that leaves the picture pins the corner instead of describing a strip off the monitor', () => {
  const box = { left: 0, top: 0, width: 100, height: 100 }
  assert.deepEqual(pointerToLayout(-40, 180, box), { x: 0, y: 1 })
  // An element with no area yet must not produce NaN corners.
  assert.deepEqual(pointerToLayout(10, 10, { left: 0, top: 0, width: 0, height: 0 }), { x: 0, y: 0 })
})

test('keyboard nudging moves by the step and stops at the frame', () => {
  assert.deepEqual(nudge({ x: 0.5, y: 0.5 }, 1, 0, 0.01), { x: 0.51, y: 0.5 })
  assert.deepEqual(nudge({ x: 0.5, y: 0.5 }, 0, -1, 0.01), { x: 0.5, y: 0.49 })
  assert.deepEqual(nudge({ x: 0, y: 1 }, -1, 1, 0.05), { x: 0, y: 1 })
})

test('an untouched keystone is recognised as untouched, a moved corner is not', () => {
  assert.equal(isDefaultKeystone(undefined), true)
  assert.equal(isDefaultKeystone(NO_KEYSTONE), true)
  assert.equal(isDefaultKeystone({ ...NO_KEYSTONE, topLeft: { x: 0.02, y: 0 } }), false)
})

test('a keystone the editor produced still builds a layout', () => {
  const keystone = { topLeft: { x: 0.05, y: 0.02 }, topRight: { x: 0.95, y: 0 }, bottomRight: { x: 1, y: 0.98 }, bottomLeft: { x: 0, y: 1 } }
  const config = parseEngineConfig({ ...JSON.parse(serialiseEngineConfig(DEFAULT_ENGINE_CONFIG)), layout: { ...classic(), keystone } })
  const rects = resolveLayout(config)
  assert.equal(rects.length, 108)
  // The top-left corner moved inwards, so nothing samples the very corner.
  assert.ok(rects.every((r) => r.xMin >= 0 && r.yMin >= 0 && r.xMax <= 1 && r.yMax <= 1))
  assert.ok(rects.some((r) => r.xMin > 0.001), 'keystone pulled the frame in')
})
