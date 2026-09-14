import assert from 'node:assert/strict'
import test from 'node:test'

import { createFrameEncoder } from '#lib/engine/encode'
import { createSocketSink, createWledSink, SOCKET_OPEN, type Socket } from '#lib/engine/net'
import { allocLedColors } from '#lib/engine/types'
import { wledFrame, wledHello, wledUrl } from '#lib/engine/wled'

/**
 * A WebSocket we drive by hand.
 *
 * The whole reason the socket is injected: connect, reconnect, backoff,
 * send-while-closed and close-mid-flight are the paths a network sink actually
 * fails on, and none of them can be provoked reliably against a real device.
 */
class FakeSocket implements Socket {
  static made: FakeSocket[] = []
  readyState = 0
  binaryType = ''
  sent: Array<string | ArrayBufferView | ArrayBuffer> = []
  onopen: ((event: unknown) => unknown) | null = null
  onclose: ((event: unknown) => unknown) | null = null
  onerror: ((event: unknown) => unknown) | null = null
  closed = false
  /**
   * Declared, not a constructor parameter property. Node's type-stripping runs
   * these tests with no build step and rejects `constructor(readonly url)` -
   * which is the whole reason the engine's testable code is plain TypeScript.
   */
  url: string

  constructor (url: string) {
    this.url = url
    FakeSocket.made.push(this)
  }

  send (data: string | ArrayBufferView | ArrayBuffer): void { this.sent.push(data) }
  close (): void { this.closed = true }

  open (): void {
    this.readyState = SOCKET_OPEN
    this.onopen?.({})
  }

  drop (): void {
    this.readyState = 3
    this.onclose?.({})
  }
}

/** A scheduler we step by hand, so backoff is asserted rather than waited for. */
function clockwork (): { schedule: (fn: () => void, ms: number) => unknown, cancel: (h: unknown) => void, delays: number[], run: () => void } {
  const queue: Array<() => void> = []
  const delays: number[] = []
  return {
    delays,
    schedule (fn, ms) {
      delays.push(ms)
      queue.push(fn)
      return queue.length - 1
    },
    cancel () { queue.length = 0 },
    run () {
      const pending = [...queue]
      queue.length = 0
      for (const fn of pending) fn()
    }
  }
}

function harness () {
  FakeSocket.made = []
  const timers = clockwork()
  return {
    timers,
    factory: (url: string) => new FakeSocket(url),
    get sockets () { return FakeSocket.made },
    last (): FakeSocket { return FakeSocket.made[FakeSocket.made.length - 1] as FakeSocket }
  }
}

const colours = (value: number, count: number): Float32Array => {
  const out = allocLedColors(count)
  out.fill(value)
  return out
}

// ---------------------------------------------------------------------------
// Our own protocol over a socket.
// ---------------------------------------------------------------------------

test('a socket sink sends the same bytes the serial port would', async () => {
  const h = harness()
  const encoder = createFrameEncoder('Afx', 8)
  const sink = createSocketSink({ url: 'ws://strip.local/afx', encoder, factory: h.factory, schedule: h.timers.schedule })

  assert.equal(sink.state(), 'connecting')
  h.last().open()
  assert.equal(sink.state(), 'open')
  assert.equal(h.last().binaryType, 'arraybuffer')

  await sink.send(colours(0.5, 8))
  assert.equal(h.last().sent.length, 1)
  const sent = h.last().sent[0] as Uint8Array
  assert.equal(sent.length, encoder.frameBytes)
  // Byte-for-byte what the serial path carries: no second protocol, no second
  // parser, and the firmware's own tests already cover it.
  assert.deepEqual(Array.from(sent), Array.from(encoder.encode(colours(0.5, 8))))
})

test('a frame sent before the socket opens is dropped, not queued', async () => {
  const h = harness()
  const sink = createSocketSink({
    url: 'ws://strip.local', encoder: createFrameEncoder('Afx', 4), factory: h.factory, schedule: h.timers.schedule
  })
  // Still dialling.
  await sink.send(colours(1, 4))
  await sink.send(colours(1, 4))
  assert.equal(h.last().sent.length, 0)
  assert.equal(sink.stats().drops, 2)
  assert.equal(sink.stats().sent, 0)

  h.last().open()
  await sink.send(colours(1, 4))
  assert.equal(h.last().sent.length, 1)
  assert.equal(sink.stats().sent, 1)
})

test('the socket copies the frame, because the encoder reuses one buffer', async () => {
  const h = harness()
  const encoder = createFrameEncoder('Afx', 4)
  const sink = createSocketSink({ url: 'ws://s', encoder, factory: h.factory, schedule: h.timers.schedule })
  h.last().open()

  await sink.send(colours(0, 4))
  const first = Array.from(h.last().sent[0] as Uint8Array)
  await sink.send(colours(1, 4))
  const stillFirst = Array.from(h.last().sent[0] as Uint8Array)
  // Without the copy the socket would hold a view onto the encoder's buffer and
  // the first frame would silently become the second.
  assert.deepEqual(stillFirst, first)
  assert.notDeepEqual(Array.from(h.last().sent[1] as Uint8Array), first)
})

test('a dropped connection reconnects, with backoff that doubles and then resets', async () => {
  const h = harness()
  const sink = createSocketSink({
    url: 'ws://strip.local',
    encoder: createFrameEncoder('Afx', 4),
    factory: h.factory,
    schedule: h.timers.schedule,
    cancel: h.timers.cancel,
    retryMs: 100,
    maxRetryMs: 800
  })
  h.last().open()
  assert.equal(h.sockets.length, 1)

  // Three failures in a row: 100, 200, 400.
  for (const expected of [100, 200, 400]) {
    h.last().drop()
    assert.equal(sink.state(), 'connecting')
    assert.equal(h.timers.delays[h.timers.delays.length - 1], expected)
    h.timers.run()
  }
  assert.equal(h.sockets.length, 4)

  // A successful open resets it. Resetting on the ATTEMPT instead would turn
  // the backoff into a fixed interval against a device that is switched off.
  h.last().open()
  h.last().drop()
  assert.equal(h.timers.delays[h.timers.delays.length - 1], 100)
  assert.equal(sink.stats().connects, 2)
  assert.equal(sink.stats().closes, 4)
})

test('backoff is capped', () => {
  const h = harness()
  createSocketSink({
    url: 'ws://s', encoder: createFrameEncoder('Afx', 4), factory: h.factory,
    schedule: h.timers.schedule, cancel: h.timers.cancel, retryMs: 100, maxRetryMs: 300
  })
  h.last().open()
  for (let i = 0; i < 6; i++) {
    h.last().drop()
    h.timers.run()
  }
  assert.ok(h.timers.delays.every((d) => d <= 300), JSON.stringify(h.timers.delays))
  assert.equal(h.timers.delays[h.timers.delays.length - 1], 300)
})

test('closing stops the retries rather than reconnecting forever', async () => {
  const h = harness()
  const sink = createSocketSink({
    url: 'ws://s', encoder: createFrameEncoder('Afx', 4), factory: h.factory,
    schedule: h.timers.schedule, cancel: h.timers.cancel
  })
  h.last().open()
  await sink.close()
  assert.ok(h.sockets[0]?.closed)
  assert.equal(sink.state(), 'idle')

  const before = h.sockets.length
  h.timers.run()
  assert.equal(h.sockets.length, before, 'a closed sink dialled again')
})

test('a factory that throws is an error state, not a crash', () => {
  const timers = clockwork()
  const sink = createSocketSink({
    url: 'ws://nope',
    encoder: createFrameEncoder('Afx', 4),
    factory: () => { throw new Error('blocked by policy') },
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  assert.equal(sink.state(), 'error')
  assert.equal(timers.delays.length, 1, 'it should still be retrying')
})

test('a socket that throws on send counts a drop rather than rejecting the frame', async () => {
  const h = harness()
  const sink = createSocketSink({
    url: 'ws://s', encoder: createFrameEncoder('Afx', 4), factory: h.factory, schedule: h.timers.schedule
  })
  h.last().open()
  h.last().send = () => { throw new Error('socket gone') }
  await sink.send(colours(1, 4))
  assert.equal(sink.stats().drops, 1)
  assert.equal(sink.stats().sent, 0)
})

// ---------------------------------------------------------------------------
// WLED.
// ---------------------------------------------------------------------------

test('the WLED frame sets individual LEDs in the shape WLED documents', () => {
  const colors = allocLedColors(3)
  colors.set([1, 0, 0, 0, 1, 0, 0, 0, 1])
  const frame = wledFrame(colors, 3)
  assert.equal(frame, '{"on":true,"seg":{"id":0,"i":["FF0000","00FF00","0000FF"]}}')

  const parsed = JSON.parse(frame) as { seg: { id: number, i: string[] } }
  assert.equal(parsed.seg.id, 0)
  assert.equal(parsed.seg.i.length, 3)
})

test('WLED numeric encoding is the same colours, and hex is the smaller one', () => {
  const colors = allocLedColors(2)
  colors.set([1, 0, 0, 0, 0.5, 0])
  const hex = wledFrame(colors, 2, { encoding: 'hex' })
  const rgb = wledFrame(colors, 2, { encoding: 'rgb' })
  assert.match(rgb, /\[255,0,0\],\[0,128,0\]/)
  assert.match(hex, /"FF0000","008000"/)
  // Hex is the default for exactly this reason, at 60 frames a second.
  assert.ok(hex.length < rgb.length)
})

test('WLED carries LINEAR bytes, like every other output', () => {
  // Same reasoning as the Adalight path: WLED writes the byte to its driver and
  // a WS2812's brightness follows PWM duty, which follows the byte.
  const colors = allocLedColors(1)
  colors[0] = 0.5
  assert.match(wledFrame(colors, 1), /"800000"/)
  assert.doesNotMatch(wledFrame(colors, 1), /"BC0000"/) // what an sRGB encode would give
})

test('a WLED segment can be named, and bad arguments are refused', () => {
  const colors = allocLedColors(1)
  assert.match(wledFrame(colors, 1, { segment: 2 }), /"id":2/)
  assert.throws(() => wledFrame(colors, 0), /positive integer/)
  assert.throws(() => wledFrame(colors, 2), /needs 6/)
  assert.throws(() => wledFrame(colors, 1, { segment: -1 }), /non-negative/)
})

test('the WLED URL accepts what a user would actually type', () => {
  assert.equal(wledUrl('192.168.1.40'), 'ws://192.168.1.40/ws')
  assert.equal(wledUrl('  192.168.1.40  '), 'ws://192.168.1.40/ws')
  assert.equal(wledUrl('http://wled.local/'), 'ws://wled.local/ws')
  assert.equal(wledUrl('https://wled.local'), 'wss://wled.local/ws')
  assert.equal(wledUrl('ws://wled.local/ws'), 'ws://wled.local/ws')
  assert.equal(wledUrl('ws://wled.local'), 'ws://wled.local/ws')
  assert.throws(() => wledUrl('   '), /host is empty/)
})

test('a WLED sink claims realtime control once per connection, not per frame', async () => {
  const h = harness()
  const sink = createWledSink({ url: 'ws://wled.local/ws', leds: 2, factory: h.factory, schedule: h.timers.schedule, cancel: h.timers.cancel })
  h.last().open()
  assert.deepEqual(h.last().sent, [wledHello()])

  await sink.send(colours(1, 2))
  await sink.send(colours(0, 2))
  assert.equal(h.last().sent.length, 3, 'the handshake should not repeat per frame')

  // And it goes out again on a fresh connection, because the device forgot.
  h.last().drop()
  h.timers.run()
  h.last().open()
  assert.deepEqual(h.last().sent, [wledHello()])
})

test('the WLED handshake matters: a device running an effect ignores pixels until claimed', () => {
  const hello = JSON.parse(wledHello()) as { on: boolean, live: boolean }
  assert.equal(hello.live, true)
  assert.equal(hello.on, true)
})

test('a WLED sink refuses an impossible LED count at construction', () => {
  const h = harness()
  assert.throws(
    () => createWledSink({ url: 'ws://x/ws', leds: 0, factory: h.factory, schedule: h.timers.schedule }),
    /positive integer/
  )
})
