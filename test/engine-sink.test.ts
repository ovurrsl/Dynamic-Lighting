import assert from 'node:assert/strict'
import test from 'node:test'

import { createFrameEncoder } from '#lib/engine/encode'
import {
  createBytesSink,
  createFrameWriter,
  createLoopbackSink,
  type FrameSink
} from '#lib/engine/sink'
import { allocLedColors } from '#lib/engine/types'

interface Deferred { resolve: () => void, reject: (error: unknown) => void }

/** A sink whose sends we resolve by hand, so "in flight" is a state we control. */
function slowSink (): FrameSink & { calls: Float32Array[], pending: Deferred[] } {
  const calls: Float32Array[] = []
  const pending: Deferred[] = []
  return {
    kind: 'loopback',
    calls,
    pending,
    describe: () => 'slow',
    state: () => 'open',
    async send (colors) {
      // A copy, because the writer reuses its owned buffer: recording the live
      // reference would make every entry look like the last frame.
      calls.push(Float32Array.from(colors))
      await new Promise<void>((resolve, reject) => pending.push({ resolve, reject }))
    },
    async close () {},
    stats: () => ({})
  }
}

/**
 * Values are powers of two on purpose. These arrays are Float32Array, and 0.4
 * is not exactly representable in single precision - asserting on it compares
 * 0.4000000059604645 against 0.4 and fails for a reason that has nothing to do
 * with the code under test.
 */
const colours = (value: number, count = 4): Float32Array => {
  const out = allocLedColors(count)
  out.fill(value)
  return out
}

test('one frame in flight: the second is dropped, not queued', async () => {
  const sink = slowSink()
  const writer = createFrameWriter(sink)

  assert.equal(writer.send(colours(0.125)), true)
  assert.equal(writer.send(colours(0.25)), false)
  assert.equal(writer.send(colours(0.375)), false)
  assert.deepEqual(writer.stats(), { written: 0, dropped: 2, errors: 0, inFlight: true })
  assert.equal(sink.calls.length, 1)

  sink.pending[0]?.resolve()
  await writer.idle()
  assert.equal(writer.stats().written, 1)

  // And the gate opens again once nothing is in flight.
  assert.equal(writer.send(colours(0.5)), true)
  assert.equal(sink.calls.length, 2)
  assert.equal(sink.calls[1]?.[0], 0.5)
})

test('the queue never grows, however long the stall lasts', async () => {
  // The defect this guards: a queue turns a 200 ms hiccup into latency that
  // grows for the rest of the session, because it never drains faster than
  // frames arrive.
  const sink = slowSink()
  const writer = createFrameWriter(sink)
  writer.send(colours(0))
  for (let i = 0; i < 500; i++) writer.send(colours(i / 500))
  assert.equal(sink.calls.length, 1)
  assert.equal(writer.stats().dropped, 500)

  sink.pending[0]?.resolve()
  await writer.idle()
  // Nothing accumulated: the next frame sent is the next one offered, not the
  // 501 that were dropped.
  assert.equal(sink.calls.length, 1)
})

test('the writer owns its buffer, so the caller may overwrite immediately', async () => {
  const sink = slowSink()
  const writer = createFrameWriter(sink)
  const live = colours(0.5)
  writer.send(live)
  live.fill(0.9) // the engine reuses one target buffer every frame
  sink.pending[0]?.resolve()
  await writer.idle()
  assert.equal(sink.calls[0]?.[0], 0.5, 'the sink saw the caller’s later write')
})

test('a rejecting sink is counted and reported, and the writer carries on', async () => {
  const seen: unknown[] = []
  const sink = slowSink()
  const writer = createFrameWriter(sink, { onError: (error) => seen.push(error) })
  writer.send(colours(0.125))
  sink.pending[0]?.reject(new Error('link down'))
  await writer.idle()
  assert.equal(writer.stats().errors, 1)
  assert.equal(writer.stats().written, 0)
  assert.equal((seen[0] as Error).message, 'link down')
  // The gate is open again: a failed link must not wedge the engine.
  assert.equal(writer.send(colours(0.25)), true)
})

test('a sink that throws synchronously is treated like one that rejects', async () => {
  const seen: unknown[] = []
  const sink: FrameSink = {
    kind: 'serial',
    describe: () => 'broken',
    state: () => 'error',
    send () { throw new Error('port closed') },
    async close () {},
    stats: () => ({})
  }
  const writer = createFrameWriter(sink, { onError: (error) => seen.push(error) })
  assert.equal(writer.send(colours(0.125)), true)
  await writer.idle()
  assert.equal(writer.stats().errors, 1)
  assert.equal((seen[0] as Error).message, 'port closed')
})

test('the loopback parses what it is given, and a healthy run rejects nothing', async () => {
  const encoder = createFrameEncoder('Afx', 108)
  const sink = createLoopbackSink({ encoder })
  const writer = createFrameWriter(sink)
  const frame = colours(0.25, 108)

  for (let i = 0; i < 20; i++) {
    writer.send(frame)
    await writer.idle()
  }
  const stats = sink.loopback()
  assert.equal(stats.accepted, 20)
  assert.equal(stats.rejected, 0, 'a rejected frame is a framing bug')
  assert.equal(stats.parser.resyncs, 0)
  assert.equal(stats.parser.badChecksum, 0)
  assert.equal(stats.bytes, 20 * encoder.frameBytes)
  assert.equal(stats.lastPayload?.length, 108 * 6)
})

test('the loopback round-trips every wire format', async () => {
  for (const format of ['Afx', 'Awa', 'Ada'] as const) {
    const sink = createLoopbackSink({ encoder: createFrameEncoder(format, 12) })
    await sink.send(colours(0.5, 12))
    assert.equal(sink.loopback().accepted, 1, format)
    assert.equal(sink.loopback().rejected, 0, format)
  }
})

test('a bytes sink encodes once and hands the frame over whole', async () => {
  const written: Uint8Array[] = []
  const encoder = createFrameEncoder('Afx', 6)
  const sink = createBytesSink({
    kind: 'serial',
    label: '1a86:7523',
    encoder,
    transport: { async write (bytes) { written.push(Uint8Array.from(bytes)) } }
  })
  assert.equal(sink.describe(), '1a86:7523')
  assert.equal(sink.state(), 'open')
  await sink.send(colours(1, 6))
  assert.equal(written.length, 1)
  assert.equal(written[0]?.length, encoder.frameBytes)
  assert.equal(sink.stats().bytes, encoder.frameBytes)
})

test('a bytes sink whose transport fails reports error state and rethrows', async () => {
  const sink = createBytesSink({
    kind: 'serial',
    label: 'gone',
    encoder: createFrameEncoder('Afx', 4),
    transport: { async write () { throw new Error('device lost') } }
  })
  await assert.rejects(() => sink.send(colours(1, 4)), /device lost/)
  // The state has to change: "sending and failing" must not read as "open".
  assert.equal(sink.state(), 'error')
})

test('closing a bytes sink releases the transport and goes idle', async () => {
  let closed = false
  const sink = createBytesSink({
    kind: 'serial',
    label: 'port',
    encoder: createFrameEncoder('Afx', 4),
    transport: { async write () {}, async close () { closed = true } }
  })
  await sink.close()
  assert.ok(closed)
  assert.equal(sink.state(), 'idle')
})
