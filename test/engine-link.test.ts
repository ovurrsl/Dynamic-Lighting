import assert from 'node:assert/strict'
import test from 'node:test'

import { REFERENCE_LAYOUT, ledCount } from '#lib/engine/layout'
import { HEADER_SIZE, encodeAfx, encodeAwa, frameSize } from '#lib/engine/protocol'
import { createLoopbackSink, createSerialWriter, type SerialSink } from '#lib/engine/serial'
import { allocLinearGrid, createRgbaDecoder } from '#lib/engine/decode'
import { createArrivalMeter, createValueMeter } from '#lib/engine/stats'
import { allocLedColors, fillLedColors } from '#lib/engine/types'
import { encodeLinear16, encodeLinear8, srgbToLinear } from '#lib/light'

const LEDS = ledCount(REFERENCE_LAYOUT)

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

function deferred (): Deferred {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A sink whose writes complete only when the test says so. */
function slowSink (): SerialSink & { calls: Uint8Array[], pending: Deferred[] } {
  const calls: Uint8Array[] = []
  const pending: Deferred[] = []
  return {
    calls,
    pending,
    write (bytes) {
      calls.push(bytes)
      const d = deferred()
      pending.push(d)
      return d.promise
    }
  }
}

/** Lets the writer's own then/finally callbacks run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Serial writer
// ---------------------------------------------------------------------------

test('a frame sent while another is in flight is dropped and counted, never queued', async () => {
  const sink = slowSink()
  const writer = createSerialWriter(sink)
  const frame = new Uint8Array([1, 2, 3])

  assert.equal(writer.send(frame), true)
  assert.equal(sink.calls.length, 1)
  for (let i = 0; i < 50; i++) assert.equal(writer.send(frame), false)
  // Fifty frames arrived during one slow write; the sink saw none of them.
  assert.equal(sink.calls.length, 1)
  assert.deepEqual(writer.stats(), { written: 0, dropped: 50, errors: 0, bytes: 0, inFlight: true })

  ;(sink.pending[0] as Deferred).resolve()
  await settle()
  assert.deepEqual(writer.stats(), { written: 1, dropped: 50, errors: 0, bytes: 3, inFlight: false })

  // The next frame goes straight through - and only the next one.
  assert.equal(writer.send(frame), true)
  assert.equal(sink.calls.length, 2)
})

test('the sink gets a copy: the caller may overwrite its buffer as soon as send returns', async () => {
  const sink = slowSink()
  const writer = createSerialWriter(sink)
  const frame = new Uint8Array([10, 20, 30, 40])
  writer.send(frame)
  frame.fill(0)
  assert.deepEqual(Array.from(sink.calls[0] as Uint8Array), [10, 20, 30, 40])
  ;(sink.pending[0] as Deferred).resolve()
  await writer.idle()

  // The owned buffer is reused for equal sizes and reallocated for others.
  writer.send(new Uint8Array([1, 2, 3, 4]))
  assert.equal(sink.calls[1], sink.calls[0])
  ;(sink.pending[1] as Deferred).resolve()
  await writer.idle()
  writer.send(new Uint8Array([9, 9]))
  assert.notEqual(sink.calls[2], sink.calls[0])
  assert.deepEqual(Array.from(sink.calls[2] as Uint8Array), [9, 9])
})

test('under sustained backpressure at most one write is ever outstanding and nothing is lost uncounted', async () => {
  const sink = slowSink()
  const writer = createSerialWriter(sink)
  const frame = new Uint8Array(333)
  let accepted = 0
  const sends = 1200
  for (let i = 0; i < sends; i++) {
    if (writer.send(frame)) accepted++
    assert.ok(sink.pending.filter((d, k) => k === sink.calls.length - 1).length <= 1)
    // Every fourth frame the link catches up.
    if (i % 4 === 3) {
      ;(sink.pending[sink.pending.length - 1] as Deferred).resolve()
      await settle()
    }
  }
  const s = writer.stats()
  assert.equal(accepted, sink.calls.length)
  assert.equal(s.written + s.dropped + (s.inFlight ? 1 : 0), sends)
  assert.equal(s.written, 300)
  assert.equal(s.dropped, 900)
})

test('a failed write is counted, reported, and does not wedge the link', async () => {
  const sink = slowSink()
  const seen: unknown[] = []
  const writer = createSerialWriter(sink, { onError: (e) => seen.push(e) })
  const frame = new Uint8Array([1])

  writer.send(frame)
  ;(sink.pending[0] as Deferred).reject(new Error('device gone'))
  await settle()
  assert.equal(seen.length, 1)
  assert.equal((seen[0] as Error).message, 'device gone')
  assert.deepEqual(writer.stats(), { written: 0, dropped: 0, errors: 1, bytes: 0, inFlight: false })

  assert.equal(writer.send(frame), true)
  ;(sink.pending[1] as Deferred).resolve()
  await writer.idle()
  assert.equal(writer.stats().written, 1)

  // A sink that throws synchronously is the same failure.
  const throwing = createSerialWriter({ write () { throw new Error('closed') } }, { onError: (e) => seen.push(e) })
  assert.equal(throwing.send(frame), true)
  await settle()
  assert.equal(throwing.stats().errors, 1)
  assert.equal(throwing.stats().inFlight, false)
  assert.equal(seen.length, 2)
})

test('idle resolves at once with nothing in flight, and after the write otherwise', async () => {
  const sink = slowSink()
  const writer = createSerialWriter(sink)
  await writer.idle()
  writer.send(new Uint8Array(1))
  let idle = false
  const waiting = writer.idle().then(() => { idle = true })
  await settle()
  assert.equal(idle, false)
  ;(sink.pending[0] as Deferred).resolve()
  await waiting
  assert.equal(idle, true)
})

// ---------------------------------------------------------------------------
// Loopback sink: the pipeline without a device
// ---------------------------------------------------------------------------

test('the loopback sink accepts exactly what the reference parser accepts', async () => {
  const sink = createLoopbackSink()
  const writer = createSerialWriter(sink)
  const colors = fillLedColors(allocLedColors(LEDS), 0.25, 0.5, 1)
  const size = frameSize('Afx', LEDS)

  for (let i = 0; i < 10; i++) {
    assert.equal(writer.send(encodeAfx(encodeLinear16(colors))), true)
    await writer.idle()
  }
  assert.equal(sink.stats().accepted, 10)
  assert.equal(sink.stats().rejected, 0)
  assert.equal(sink.stats().bytes, 10 * size)
  assert.deepEqual(sink.stats().parser, { frames: 10, resyncs: 0, badChecksum: 0, countMismatch: 0 })
  const payload = sink.stats().lastPayload as Uint8Array
  assert.equal(payload.length, LEDS * 6)
  assert.deepEqual(Array.from(payload.subarray(0, 6)), [0x40, 0x00, 0x80, 0x00, 0xff, 0xff])

  // A corrupted frame is rejected, as the firmware would reject it, and the
  // parser says why. The next good frame is delivered: the stream resyncs.
  const bad = encodeAfx(encodeLinear16(colors))
  bad[HEADER_SIZE + 5] = (bad[HEADER_SIZE + 5] as number) ^ 0xff
  writer.send(bad)
  await writer.idle()
  assert.equal(sink.stats().rejected, 1)
  assert.equal(sink.stats().parser.badChecksum, 1)
  writer.send(encodeAfx(encodeLinear16(colors)))
  await writer.idle()
  assert.equal(sink.stats().accepted, 11)
  // Bytes that never form a header are skipped by the parser and count as
  // one rejected write here.
  writer.send(new Uint8Array([1, 2, 3]))
  await writer.idle()
  assert.equal(sink.stats().rejected, 2)
  assert.equal(sink.stats().accepted, 11)
})

test('the loopback sink can simulate link latency with an injected wait', async () => {
  const waits: number[] = []
  let release: (() => void) | null = null
  const sink = createLoopbackSink({
    latencyMs: 7,
    wait: (ms) => {
      waits.push(ms)
      return new Promise<void>((resolve) => { release = resolve })
    }
  })
  const writer = createSerialWriter(sink)
  const frame = encodeAwa(encodeLinear8(allocLedColors(4)))
  writer.send(frame)
  await settle()
  assert.deepEqual(waits, [7])
  assert.equal(writer.stats().inFlight, true)
  assert.equal(writer.send(frame), false)
  ;(release as unknown as () => void)()
  await writer.idle()
  assert.equal(writer.stats().written, 1)
})

// ---------------------------------------------------------------------------
// RGBA decode
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Arrival meter
// ---------------------------------------------------------------------------

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
