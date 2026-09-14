import assert from 'node:assert/strict'
import test from 'node:test'

import { createArrivalMeter, createValueMeter } from '#lib/engine/stats'

test('a steady 120 Hz stream reports 120 fps with flat percentiles and no gaps', () => {
  const meter = createArrivalMeter()
  const period = 1000 / 120
  let now = 1000
  for (let i = 0; i < 240; i++) {
    meter.mark(now)
    now += period
  }
  const s = meter.snapshot(now)
  assert.ok(Math.abs(s.fps - 120) < 0.01, `fps ${s.fps}`)
  assert.ok(Math.abs(s.p50 - period) < 1e-9)
  assert.ok(Math.abs(s.p99 - period) < 1e-9)
  assert.ok(Math.abs(s.max - period) < 1e-9)
  assert.equal(s.gaps, 0)
  assert.equal(s.total, 240)
  // Two seconds of window at 120 Hz: 240 arrivals fit exactly, and the very
  // first sits on the window's edge, where float accumulation decides.
  assert.ok(s.samples === 239 || s.samples === 240, `samples ${s.samples}`)
})

test('one stall shows in p99, max and the gap count while p50 stays put', () => {
  const meter = createArrivalMeter({ windowMs: 5000 })
  const period = 1000 / 120
  let now = 0
  // One stall in a hundred frames is the top percentile; in a thousand it
  // would only show in `max`, which is why both are reported.
  for (let i = 0; i < 100; i++) {
    meter.mark(now)
    now += i === 50 ? 100 : period
  }
  const s = meter.snapshot(now)
  assert.ok(Math.abs(s.p50 - period) < 1e-9)
  assert.equal(s.p99, 100)
  assert.equal(s.max, 100)
  assert.equal(s.gaps, 1)
  // 99 intervals over 917 ms: the rate shows the stall, the mean interval
  // (9.26 ms) would have read as a healthy 108 Hz stream.
  assert.ok(s.fps < 110 && s.fps > 105, `fps ${s.fps}`)
})

test('the window forgets old arrivals; gaps and total are for ever; reset clears both', () => {
  const meter = createArrivalMeter({ windowMs: 1000, gapMs: 30, capacity: 16 })
  meter.mark(0)
  meter.mark(500)
  meter.mark(510)
  meter.mark(520)
  let s = meter.snapshot(1200)
  assert.equal(s.samples, 3)
  assert.equal(s.gaps, 1)
  assert.equal(s.total, 4)
  assert.equal(s.p50, 10)

  s = meter.snapshot(5000)
  assert.deepEqual({ fps: s.fps, p50: s.p50, samples: s.samples, gaps: s.gaps, total: s.total }, { fps: 0, p50: 0, samples: 0, gaps: 1, total: 4 })

  // More arrivals than the ring holds: only the newest survive.
  for (let i = 0; i < 40; i++) meter.mark(6000 + i * 5)
  s = meter.snapshot(6200)
  assert.equal(s.samples, 16)
  assert.equal(s.total, 44)

  meter.reset()
  s = meter.snapshot(6200)
  assert.equal(s.total, 0)
  assert.equal(s.gaps, 0)
  assert.equal(s.samples, 0)

  assert.throws(() => createArrivalMeter({ windowMs: 0 }), RangeError)
  assert.throws(() => createArrivalMeter({ capacity: 1 }), RangeError)
})

test('the value meter reports percentiles over its ring and forgets the oldest values', () => {
  const meter = createValueMeter(100)
  assert.deepEqual(meter.snapshot(), { p50: 0, p99: 0, max: 0, samples: 0 })
  for (let v = 1; v <= 100; v++) meter.add(v)
  let s = meter.snapshot()
  assert.equal(s.samples, 100)
  assert.equal(s.p50, 51)
  assert.equal(s.p99, 100)
  assert.equal(s.max, 100)

  // 50 more values push the oldest 50 out: 51..150 remain.
  for (let v = 101; v <= 150; v++) meter.add(v)
  s = meter.snapshot()
  assert.equal(s.samples, 100)
  assert.equal(s.p50, 101)
  assert.equal(s.max, 150)

  meter.reset()
  assert.equal(meter.snapshot().samples, 0)
  assert.throws(() => createValueMeter(0), RangeError)
})
