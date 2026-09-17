import assert from 'node:assert/strict'
import test from 'node:test'

import { formatOverrideList, formatRangeList, parseOverrideList, parseRangeList } from '#lib/engine/ranges'

test('a blacklist is typed as indices and inclusive ranges', () => {
  assert.deepEqual(parseRangeList('0-3, 10, 20-24'), [
    { start: 0, length: 4 },
    { start: 10, length: 1 },
    { start: 20, length: 5 }
  ])
  assert.deepEqual(parseRangeList(''), [])
  assert.deepEqual(parseRangeList('  7 ;8  '), [{ start: 7, length: 1 }, { start: 8, length: 1 }])
})

test('a blacklist round-trips through its text', () => {
  const ranges = [{ start: 0, length: 4 }, { start: 10, length: 1 }, { start: 20, length: 5 }]
  assert.equal(formatRangeList(ranges), '0-3, 10, 20-24')
  assert.deepEqual(parseRangeList(formatRangeList(ranges)), ranges)
})

test('a bad blacklist entry is named, not the whole list', () => {
  assert.throws(() => parseRangeList('0-3, x'), /"x"/)
  assert.throws(() => parseRangeList('9-4'), /runs backwards/)
})

test('overrides are typed as index:order', () => {
  assert.deepEqual(parseOverrideList('5:grb, 7:BRG'), { 5: 'grb', 7: 'brg' })
  assert.deepEqual(parseOverrideList(''), {})
  assert.equal(formatOverrideList({ 7: 'brg', 5: 'grb' }), '5:grb, 7:brg')
  assert.equal(formatOverrideList(undefined), '')
})

test('an unknown order is refused with the six that exist', () => {
  assert.throws(() => parseOverrideList('5:xyz'), /rgb, rbg, grb, gbr, brg, bgr/)
  assert.throws(() => parseOverrideList('five:grb'), /"five:grb"/)
})
