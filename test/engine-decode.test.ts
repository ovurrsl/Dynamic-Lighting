import assert from 'node:assert/strict'
import test from 'node:test'

import { allocLinearGrid, createRgbaDecoder } from '#lib/engine/decode'
import { srgbToLinear } from '#lib/light'

test('decodes 8-bit sRGB pixels to linear light through the table and ignores alpha', () => {
  const decoder = createRgbaDecoder(2, 2)
  const rgba = Uint8ClampedArray.from([
    0, 0, 0, 255, /**/ 255, 255, 255, 0,
    128, 64, 32, 7, /**/ 1, 2, 3, 200
  ])
  const grid = decoder.decode(rgba)
  assert.equal(grid.width, 2)
  assert.equal(grid.height, 2)
  const expected = [0, 0, 0, 255, 255, 255, 128, 64, 32, 1, 2, 3].map((v) => Math.fround(srgbToLinear(v / 255)))
  assert.deepEqual(Array.from(grid.data), expected)
  // 128 is 0.2158 linear, not 0.502: this is the whole point of the stage.
  assert.ok(Math.abs((grid.data[6] as number) - 0.2158) < 1e-3)

  // Decodes into a caller's grid without allocating.
  const out = allocLinearGrid(2, 2)
  assert.equal(decoder.decode(rgba, out), out)
  assert.deepEqual(Array.from(out.data), expected)
})

test('rejects the wrong number of bytes, a mismatched output grid and a bad size', () => {
  const decoder = createRgbaDecoder(4, 3)
  assert.throws(() => decoder.decode(new Uint8ClampedArray(4 * 3 * 3)), RangeError)
  assert.throws(() => decoder.decode(new Uint8ClampedArray(4 * 3 * 4), allocLinearGrid(3, 4)), RangeError)
  assert.throws(() => createRgbaDecoder(0, 3), RangeError)
  assert.throws(() => allocLinearGrid(2, 2.5), RangeError)
})
