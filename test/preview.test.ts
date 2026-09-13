import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ENGINE_CONFIG, resolveLayout, type LayoutConfig } from '#lib/engine/config'
import { LAYOUT_DEFAULTS, MATRIX_REFERENCE, REFERENCE_LAYOUT } from '#lib/engine/layout'
import { frameAspect, wireOrderColor } from '#lib/preview'

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
