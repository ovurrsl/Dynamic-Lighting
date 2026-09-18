import assert from 'node:assert/strict'
import test from 'node:test'

import { createFrameEncoder } from '#lib/engine/encode'
import { AFX_PATH, afxUrl, createSocketSink, createWledSink, SOCKET_OPEN, type Socket } from '#lib/engine/net'
import { allocLedColors } from '#lib/engine/types'
import { WLED_DEFAULT_GAMMA, WLED_LEDS_PER_FRAME, WLED_MAX_FRAME_BYTES, wledFrames, wledGoodbye, wledHello, wledUrl } from '#lib/engine/wled'

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

test('the board URL accepts what a user would actually type, and lands on the firmware’s path', () => {
  assert.equal(afxUrl('192.168.1.41'), `ws://192.168.1.41${AFX_PATH}`)
  assert.equal(afxUrl('  192.168.1.41  '), `ws://192.168.1.41${AFX_PATH}`)
  assert.equal(afxUrl('http://strip.local/'), `ws://strip.local${AFX_PATH}`)
  assert.equal(afxUrl('https://strip.local'), `wss://strip.local${AFX_PATH}`)
  assert.equal(afxUrl('ws://strip.local'), `ws://strip.local${AFX_PATH}`)
  // A path the user typed is theirs: someone behind a reverse proxy has put the
  // board somewhere else and knows where.
  assert.equal(afxUrl('ws://gateway.local/boards/1'), 'ws://gateway.local/boards/1')
  assert.throws(() => afxUrl('   '), /host is empty/)
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

/** The byte WLED's own gamma turns back into `linear`: round(255 · linear^(1/γ)). */
const compensated = (linear: number, gamma = WLED_DEFAULT_GAMMA): string =>
  Math.round(Math.pow(linear, 1 / gamma) * 255).toString(16).toUpperCase().padStart(2, '0')

test('the WLED frame sets individual LEDs in the documented indexed form, from LED 0', () => {
  const colors = allocLedColors(3)
  colors.set([1, 0, 0, 0, 1, 0, 0, 0, 1])
  const frames = wledFrames(colors, 3)
  assert.equal(frames.length, 1)
  assert.equal(frames[0], '{"seg":{"id":0,"i":[0,"FF0000","00FF00","0000FF"]}}')

  const parsed = JSON.parse(frames[0] as string) as { seg: { id: number, i: [number, ...string[]] } }
  assert.equal(parsed.seg.id, 0)
  assert.equal(parsed.seg.i[0], 0, 'the leading integer is the index the run starts at')
  assert.equal(parsed.seg.i.length, 4)
})

test('WLED bytes are PRE-COMPENSATED for the device’s own gamma, so the strip ends up linear', () => {
  // WLED runs every JSON colour through gamma32() (2.8 by default). A linear
  // byte sent as-is would be raised to the 2.8 on the way to the strip - the
  // double gamma every other output in this engine avoids.
  const colors = allocLedColors(1)
  colors[0] = 0.5
  const [frame] = wledFrames(colors, 1)
  assert.match(frame as string, new RegExp(`"${compensated(0.5)}0000"`))
  assert.doesNotMatch(frame as string, /"800000"/, 'a raw linear byte would be dimmed to 0.5^2.8 by the device')
  // Gamma 1 is a device with colour gamma switched off: linear goes as linear.
  assert.match(wledFrames(colors, 1, { gamma: 1 })[0] as string, /"800000"/)
  // And the compensation keeps the low end the device would crush.
  colors[0] = 0.001
  assert.notEqual(wledFrames(colors, 1)[0], '{"seg":{"id":0,"i":[0,"000000"]}}')
})

test('a long strip is sent as several messages, each under the device’s one-frame limit', () => {
  const leds = 512
  const colors = colours(1, leds)
  const frames = wledFrames(colors, leds)
  assert.equal(frames.length, Math.ceil(leds / WLED_LEDS_PER_FRAME))
  let covered = 0
  for (const frame of frames) {
    assert.ok(frame.length <= WLED_MAX_FRAME_BYTES, `${frame.length} bytes is over the limit`)
    const parsed = JSON.parse(frame) as { seg: { i: [number, ...string[]] } }
    assert.equal(parsed.seg.i[0], covered, 'each run starts where the previous one ended')
    covered += parsed.seg.i.length - 1
  }
  assert.equal(covered, leds)
  // A strip that fits is still one message.
  assert.equal(wledFrames(colours(1, 108), 108).length, 1)
})

test('a NaN in the colour buffer becomes black, never the string "NaN" inside a colour', () => {
  const colors = allocLedColors(1)
  colors[0] = Number.NaN
  assert.equal(wledFrames(colors, 1)[0], '{"seg":{"id":0,"i":[0,"000000"]}}')
})

test('a WLED segment can be named, and bad arguments are refused', () => {
  const colors = allocLedColors(1)
  assert.match(wledFrames(colors, 1, { segment: 2 })[0] as string, /"id":2/)
  assert.throws(() => wledFrames(colors, 0), /positive integer/)
  assert.throws(() => wledFrames(colors, 2), /needs 6/)
  assert.throws(() => wledFrames(colors, 1, { segment: -1 }), /non-negative/)
  assert.throws(() => wledFrames(colors, 1, { gamma: 0 }), /gamma/)
  assert.throws(() => wledFrames(colors, 1, { gamma: Number.NaN }), /gamma/)
})

test('the WLED URL accepts what a user would actually type, and lands on /ws exactly once', () => {
  assert.equal(wledUrl('192.168.1.40'), 'ws://192.168.1.40/ws')
  assert.equal(wledUrl('  192.168.1.40  '), 'ws://192.168.1.40/ws')
  assert.equal(wledUrl('http://wled.local/'), 'ws://wled.local/ws')
  assert.equal(wledUrl('https://wled.local'), 'wss://wled.local/ws')
  assert.equal(wledUrl('ws://wled.local/ws'), 'ws://wled.local/ws')
  assert.equal(wledUrl('ws://wled.local'), 'ws://wled.local/ws')
  // Pasted from the device's own page: used to come out as /ws/ws.
  assert.equal(wledUrl('http://wled.local/ws'), 'ws://wled.local/ws')
  assert.equal(wledUrl('ws://wled.local/ws/'), 'ws://wled.local/ws')
  assert.equal(wledUrl('wled.local:81'), 'ws://wled.local:81/ws')
  assert.throws(() => wledUrl('   '), /host is empty/)
})

test('an address is parsed, not string-surgeried: IPv6, case, query, fragment, credentials', () => {
  // A bare IPv6 address used to have its last group read as a port.
  assert.equal(afxUrl('fe80::1'), `ws://[fe80::1]${AFX_PATH}`)
  assert.equal(afxUrl('[fe80::1]:81'), `ws://[fe80::1]:81${AFX_PATH}`)
  // Schemes are compared without regard to case; the host is lower-cased by
  // the parser as the browser would.
  assert.equal(afxUrl('WS://Strip.Local'), `ws://strip.local${AFX_PATH}`)
  assert.equal(afxUrl('HTTPS://strip.local'), `wss://strip.local${AFX_PATH}`)
  // A query the user typed stays; a fragment would make the socket throw.
  assert.equal(afxUrl('strip.local/afx?token=1'), 'ws://strip.local/afx?token=1')
  assert.equal(afxUrl('strip.local#x'), `ws://strip.local${AFX_PATH}`)
  assert.throws(() => afxUrl('ftp://strip.local'), /not a WebSocket address/)
  assert.throws(() => afxUrl('ws://user:pw@strip.local'), /user name or password/)
  assert.throws(() => afxUrl('strip local'), /not an address/)
})

test('a WLED sink says hello once per connection, and the hello is not the realtime lock', async () => {
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

test('the WLED handshake turns the device on at full brightness and freezes the segment - and never sends "live"', () => {
  // `"live":true` puts WLED into its UDP realtime mode, in which the main loop
  // stops servicing the strip and pixels written over JSON are never shown.
  const hello = JSON.parse(wledHello({ segment: 3 })) as Record<string, unknown> & { seg: Record<string, unknown> }
  assert.equal(hello.on, true)
  assert.equal(hello.bri, 255)
  assert.equal(hello.seg.id, 3)
  assert.equal(hello.seg.frz, true)
  assert.equal('live' in hello, false)
})

test('closing a WLED sink hands the segment back to its own effect', async () => {
  const h = harness()
  const sink = createWledSink({ url: 'ws://wled.local/ws', leds: 1, factory: h.factory, schedule: h.timers.schedule, cancel: h.timers.cancel })
  h.last().open()
  await sink.close()
  const last = h.last().sent[h.last().sent.length - 1]
  assert.equal(last, wledGoodbye())
  assert.deepEqual(JSON.parse(wledGoodbye({ segment: 1 })), { seg: { id: 1, frz: false } })
  assert.ok(h.last().closed)

  // A socket that never opened has nothing to unfreeze, and a goodbye to it
  // would be counted as a drop for no reason.
  const h2 = harness()
  const never = createWledSink({ url: 'ws://wled.local/ws', leds: 1, factory: h2.factory, schedule: h2.timers.schedule, cancel: h2.timers.cancel })
  await never.close()
  assert.deepEqual(h2.last().sent, [])
  assert.equal(never.stats().drops, 0)
})

test('a WLED sink refuses an impossible LED count or gamma at construction', () => {
  const h = harness()
  assert.throws(
    () => createWledSink({ url: 'ws://x/ws', leds: 0, factory: h.factory, schedule: h.timers.schedule }),
    /positive integer/
  )
  assert.throws(
    () => createWledSink({ url: 'ws://x/ws', leds: 1, gamma: 9, factory: h.factory, schedule: h.timers.schedule }),
    /gamma/
  )
})

// ---------------------------------------------------------------------------
// The link itself: stalls and refusals.
// ---------------------------------------------------------------------------

test('a stalled socket drops the frame instead of queueing it', async () => {
  // WebSocket.send never blocks and never fails on a stalled link: it queues
  // without limit, and a WiFi stall that queued frames would deliver a second
  // of the past once it cleared. The writer above cannot see that queue;
  // this is where it is refused.
  const h = harness()
  const encoder = createFrameEncoder('Afx', 4)
  const sink = createSocketSink({ url: 'ws://s', encoder, factory: h.factory, schedule: h.timers.schedule, highWaterBytes: 100 })
  const socket = h.last() as FakeSocket & { bufferedAmount: number }
  socket.open()
  socket.bufferedAmount = 0
  await sink.send(colours(1, 4))
  assert.equal(socket.sent.length, 1)

  socket.bufferedAmount = 101
  await sink.send(colours(1, 4))
  await sink.send(colours(1, 4))
  assert.equal(socket.sent.length, 1, 'nothing more should have been handed to a stalled socket')
  assert.equal(sink.stats().stalls, 2)
  assert.equal(sink.stats().drops, 2)

  socket.bufferedAmount = 0
  await sink.send(colours(1, 4))
  assert.equal(socket.sent.length, 2, 'and it resumes the moment the queue drains')
})

test('a WLED frame goes whole or not at all', async () => {
  const h = harness()
  const leds = WLED_LEDS_PER_FRAME * 2
  const sink = createWledSink({ url: 'ws://wled.local/ws', leds, factory: h.factory, schedule: h.timers.schedule, cancel: h.timers.cancel, highWaterBytes: 10 })
  const socket = h.last() as FakeSocket & { bufferedAmount: number }
  socket.open()
  socket.bufferedAmount = 0
  await sink.send(colours(1, leds))
  assert.equal(socket.sent.length, 1 + 2, 'hello plus both halves')
  socket.bufferedAmount = 11
  await sink.send(colours(0, leds))
  assert.equal(socket.sent.length, 3, 'a stalled link gets neither half, not the first one only')
  assert.equal(sink.stats().frameDrops, 1)
  assert.equal(sink.stats().sent, 1)
})

test('a URL the socket constructor refuses is refused for ever, with the reason kept', () => {
  const h = harness()
  const encoder = createFrameEncoder('Afx', 4)
  const sink = createSocketSink({
    url: 'nonsense',
    encoder,
    factory: () => { throw new SyntaxError('The URL is invalid') },
    schedule: h.timers.schedule
  })
  assert.equal(sink.state(), 'error')
  assert.deepEqual(h.timers.delays, [], 'a SyntaxError must not be retried every second for ever')
  assert.match(String(sink.stats().reason), /URL is invalid/)
})

test('any other constructor failure is retried with backoff, and the reason is shown meanwhile', () => {
  const h = harness()
  const encoder = createFrameEncoder('Afx', 4)
  let attempts = 0
  const sink = createSocketSink({
    url: 'ws://s',
    encoder,
    factory: () => { attempts++; throw new Error('SecurityError: blocked') },
    schedule: h.timers.schedule,
    retryMs: 10
  })
  assert.equal(sink.state(), 'error')
  assert.match(String(sink.stats().reason), /blocked/)
  assert.deepEqual(h.timers.delays, [10])
  h.timers.run()
  assert.equal(attempts, 2)
  assert.deepEqual(h.timers.delays, [10, 20])
})

test('a close code the server sent is kept as the reason, and a clean open clears it', () => {
  const h = harness()
  const encoder = createFrameEncoder('Afx', 4)
  const sink = createSocketSink({ url: 'ws://s', encoder, factory: h.factory, schedule: h.timers.schedule })
  h.last().open()
  h.last().onclose?.({ code: 1006 })
  assert.match(String(sink.stats().reason), /1006/)
  h.timers.run()
  h.last().open()
  assert.equal(sink.stats().reason, undefined)
})

test('a Stop hands the segment back, and the next frame says hello again before painting', async () => {
  // The link stays open across a Stop. Released, the device's own effect is
  // running on the segment; a frame that arrived without a fresh hello would
  // land on it and, on a device older than 0.13, be repainted at once.
  const h = harness()
  const sink = createWledSink({ url: 'ws://wled.local/ws', leds: 1, factory: h.factory, schedule: h.timers.schedule, cancel: h.timers.cancel })
  h.last().open()
  await sink.send(colours(1, 1))
  await sink.release!()
  assert.equal(h.last().sent[h.last().sent.length - 1], wledGoodbye())
  await sink.release!()
  assert.equal(h.last().sent.length, 3, 'a second release says nothing')

  await sink.send(colours(0.5, 1))
  const sent = h.last().sent as string[]
  assert.equal(sent[3], wledHello(), 'hello again before the first frame after a release')
  assert.match(sent[4] as string, /"seg"/)
  await sink.send(colours(0.5, 1))
  assert.equal(h.last().sent.length, 6, 'and only once')

  // Closing after a release does not repeat the goodbye.
  await sink.release!()
  await sink.close()
  assert.equal(h.last().sent.filter((m) => m === wledGoodbye()).length, 2)
})
