import assert from 'node:assert/strict'
import test from 'node:test'

import { HISTORY_LIMIT, pushSample, sparklinePath, stageShares } from '#lib/telemetry'

test('the history keeps the newest samples and forgets the oldest', () => {
  let history: number[] = []
  for (let i = 0; i < HISTORY_LIMIT + 10; i++) history = pushSample(history, i)
  assert.equal(history.length, HISTORY_LIMIT)
  assert.equal(history[0], 10)
  assert.equal(history[history.length - 1], HISTORY_LIMIT + 9)
})

test('appending returns a new array, because the caller is React state', () => {
  const before: number[] = [1, 2]
  const after = pushSample(before, 3)
  assert.notEqual(after, before)
  assert.deepEqual(before, [1, 2], 'the original is untouched')
})

test('a non-finite sample is dropped rather than stored', () => {
  // One NaN makes the whole path NaN and the graph disappears with nothing
  // saying why - and a report that arrived mid-restart can carry one.
  const history = pushSample(pushSample([10, 20], Number.NaN), Number.POSITIVE_INFINITY)
  assert.deepEqual(history, [10, 20])
})

test('a steady value draws as a flat line through the middle, not pinned to an edge', () => {
  // 120 fps that never moves is the healthy case. It must not divide by zero,
  // and it must not read as "pinned at the ceiling".
  const line = sparklinePath([120, 120, 120], { width: 100, height: 20 })
  assert.notEqual(line.d, null)
  const ys = (line.d as string).match(/,(\d+(?:\.\d+)?)/g)?.map((m) => Number(m.slice(1)))
  assert.deepEqual(ys, [10, 10, 10])
})

test('the line runs oldest to newest and uses the whole box', () => {
  const line = sparklinePath([0, 50, 100], { width: 100, height: 20 })
  assert.equal(line.d, 'M 0,20 L 50,10 L 100,0')
  assert.equal(line.min, 0)
  assert.equal(line.max, 100)
})

test('an explicit ceiling is honoured, and values past it are clamped rather than drawn outside', () => {
  const line = sparklinePath([0, 60, 200], { width: 100, height: 10, max: 120 })
  assert.equal(line.d, 'M 0,10 L 50,5 L 100,0')
})

test('one sample is a short stroke, not an invisible dot', () => {
  // Otherwise the graph is empty for the first second after every start, which
  // reads as "the graph is broken".
  const line = sparklinePath([60], { width: 100, height: 20, max: 120 })
  assert.equal(line.d, 'M 48,10 L 52,10')
})

test('nothing to draw is null, not an empty path', () => {
  assert.equal(sparklinePath([], { width: 100, height: 20 }).d, null)
  assert.equal(sparklinePath([1, 2], { width: 0, height: 20 }).d, null)
})

test('the stages are shares of the BUDGET, which is what makes them a decision', () => {
  // "The downscale is the biggest stage" is always true and says nothing.
  // "The downscale alone is most of the budget" is something you act on.
  const shares = stageShares({ downscale: 6, readback: 1, decode: 0.5, sample: 0.25 }, 8.333)
  assert.deepEqual(shares.map((s) => s.key), ['downscale', 'readback', 'decode', 'sample'])
  assert.ok((shares[0] as { share: number }).share > 0.7)
  assert.ok((shares[3] as { share: number }).share < 0.05)
})

test('a missing or nonsense stage reading is zero, not a bar off the end', () => {
  const shares = stageShares(
    { downscale: Number.NaN, readback: -3, decode: 1, sample: 0 },
    0
  )
  assert.equal(shares[0]?.ms, 0)
  assert.equal(shares[1]?.ms, 0, 'a negative duration is not a duration')
  assert.equal(shares[2]?.share, 1, 'a zero budget does not divide by zero')
})
