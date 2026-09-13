import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { REFERENCE_LAYOUT, ledCount } from '#lib/engine/layout'
import {
  BACKGROUND_PRIORITY,
  DEFAULT_STREAM_TIMEOUT_MS,
  PriorityMuxer,
  type SourceInput,
  type WinnerChange
} from '#lib/engine/priority'
import { allocLedColors, fillLedColors, type Clock, type LinearGrid } from '#lib/engine/types'

const LEDS = ledCount(REFERENCE_LAYOUT)

/** A solid colour for the whole reference strip, as the panel or an effect pushes it. */
const solid = (r: number, g: number, b: number): SourceInput =>
  ({ kind: 'colors', colors: fillLedColors(allocLedColors(LEDS), r, g, b) })

/** A tiny captured frame. The muxer never looks inside; it only hands it on. */
const frame = (): SourceInput => {
  const grid: LinearGrid = { width: 4, height: 3, data: new Float32Array(4 * 3 * 3) }
  return { kind: 'grid', grid }
}

/** A clock the test advances by hand. Nothing in these tests touches wall time. */
function fakeClock (): { clock: Clock, set: (ms: number) => void } {
  let now = 0
  return { clock: () => now, set: (ms) => { now = ms } }
}

function recordChanges (mux: PriorityMuxer): WinnerChange[] {
  const changes: WinnerChange[] = []
  mux.onChange((change) => changes.push(change))
  return changes
}

test('the lower priority number wins, and the next one up takes over when it goes', () => {
  const mux = new PriorityMuxer(fakeClock().clock)
  mux.register(100, { component: 'effect' })
  mux.setInput(100, solid(0, 1, 0))
  mux.register(50, { component: 'color' })
  mux.setInput(50, solid(1, 0, 0))

  const winner = mux.tick()
  assert.equal(winner?.priority, 50)
  assert.equal(winner?.component, 'color')
  assert.equal(winner?.input.kind, 'colors')

  assert.equal(mux.clear(50), true)
  assert.equal(mux.tick()?.priority, 100)
  assert.equal(mux.clear(50), false)
})

test('the background at 255 loses to a source at 254 and shows only when nothing else is live', () => {
  const mux = new PriorityMuxer(fakeClock().clock)
  mux.register(BACKGROUND_PRIORITY, { component: 'background' })
  mux.setInput(BACKGROUND_PRIORITY, solid(0.02, 0.02, 0.05))
  mux.register(254, { component: 'capture' })
  mux.setInput(254, frame())

  const winner = mux.tick()
  assert.equal(winner?.priority, 254)
  assert.equal(winner?.input.kind, 'grid')

  mux.clear(254)
  const fallback = mux.tick()
  assert.equal(fallback?.priority, BACKGROUND_PRIORITY)
  assert.equal(fallback?.component, 'background')
})

test('a registered source that has not delivered input yet is not a candidate', () => {
  // Hyperion parity: registerInput() leaves the slot TIMEOUT_NOT_ACTIVE_PRIO
  // and updatePriorities() skips it until data arrives.
  const mux = new PriorityMuxer(fakeClock().clock)
  mux.register(1, { component: 'capture' })
  mux.register(200, { component: 'color' })
  mux.setInput(200, solid(1, 1, 1))

  assert.equal(mux.tick()?.priority, 200)
  assert.equal(mux.has(1), true)

  mux.setInput(1, frame())
  assert.equal(mux.tick()?.priority, 1)
})

test('manual selection overrides auto and is released when the pinned source disappears', () => {
  const mux = new PriorityMuxer(fakeClock().clock)
  mux.register(1, { component: 'color' })
  mux.setInput(1, solid(1, 0, 0))
  mux.register(100, { component: 'capture' })
  mux.setInput(100, frame())
  assert.equal(mux.tick()?.priority, 1)

  mux.setManual(100)
  assert.equal(mux.tick()?.priority, 100)
  assert.equal(mux.manualPriority(), 100)

  // The pinned source goes away: back to auto, and the pin is gone for good -
  // re-registering the same priority does not snap the selection back to it.
  mux.clear(100)
  assert.equal(mux.tick()?.priority, 1)
  assert.equal(mux.manualPriority(), null)

  mux.register(100, { component: 'capture' })
  mux.setInput(100, frame())
  assert.equal(mux.tick()?.priority, 1)
})

test('a pin on a source that has not delivered yet waits for it instead of freezing the LEDs', () => {
  // Hyperion honours the pin on registration alone (updatePriorities checks
  // contains(), not activity) and would make an input with no data visible.
  const mux = new PriorityMuxer(fakeClock().clock)
  mux.register(1, { component: 'color' })
  mux.setInput(1, solid(1, 0, 0))
  mux.register(100, { component: 'capture' })

  mux.setManual(100)
  assert.equal(mux.tick()?.priority, 1, 'auto choice shows while the pinned source has nothing')
  assert.equal(mux.manualPriority(), 100, 'the pin is kept while the source is registered')

  mux.setInput(100, frame())
  assert.equal(mux.tick()?.priority, 100)
})

test('a pinned source that expires releases the pin', () => {
  const { clock, set } = fakeClock()
  const mux = new PriorityMuxer(clock)
  mux.register(1, { component: 'color' })
  mux.setInput(1, solid(0, 0, 1))
  mux.register(100, { component: 'effect', durationMs: 100 })
  mux.setInput(100, solid(0, 1, 0))
  mux.setManual(100)

  set(50)
  assert.equal(mux.tick()?.priority, 100)
  set(100)
  assert.equal(mux.tick()?.priority, 1)
  assert.equal(mux.manualPriority(), null)
})

test('setManual refuses a priority nobody registered, and null returns to auto', () => {
  const mux = new PriorityMuxer(fakeClock().clock)
  mux.register(1, { component: 'color' })
  mux.setInput(1, solid(1, 0, 0))
  mux.register(100, { component: 'effect' })
  mux.setInput(100, solid(0, 1, 0))

  assert.throws(() => mux.setManual(7), /unregistered/)
  assert.throws(() => mux.setManual(0), RangeError)

  mux.setManual(100)
  assert.equal(mux.tick()?.priority, 100)
  mux.setManual(null)
  assert.equal(mux.tick()?.priority, 1)
  assert.equal(mux.manualPriority(), null)
})

test('a timed source expires exactly at registeredAt + durationMs', () => {
  const { clock, set } = fakeClock()
  const mux = new PriorityMuxer(clock)
  set(1000)
  mux.register(50, { component: 'color', durationMs: 500 })
  mux.setInput(50, solid(1, 0, 0))

  set(1499)
  assert.equal(mux.tick()?.priority, 50)
  assert.equal(mux.tick()?.registeredAt, 1000)

  set(1500)
  assert.equal(mux.tick(), null)
  assert.equal(mux.has(50), false)
})

test('tick(now) arbitrates at the instant given rather than the clock', () => {
  const { clock } = fakeClock()
  const mux = new PriorityMuxer(clock)
  mux.register(50, { component: 'color', durationMs: 500 })
  mux.setInput(50, solid(1, 0, 0))

  assert.equal(mux.tick(499)?.priority, 50)
  assert.equal(mux.tick(500), null)
})

test('expiry is driven by the injected clock alone, never by wall time', () => {
  // Hyperion's muxer reads QDateTime::currentMSecsSinceEpoch() (:246, :390).
  // Here any wall-clock read during registration, feeding or arbitration is a
  // failure, and the deadline still passes when only the injected clock moves.
  mock.method(Date, 'now', () => { throw new Error('Date.now was consulted') })
  mock.method(performance, 'now', () => { throw new Error('performance.now was consulted') })
  try {
    const { clock, set } = fakeClock()
    const mux = new PriorityMuxer(clock)
    mux.register(10, { component: 'color', durationMs: 10 })
    mux.setInput(10, solid(1, 1, 1))
    set(9)
    assert.equal(mux.tick()?.priority, 10)
    set(10)
    assert.equal(mux.tick(), null)
  } finally {
    mock.restoreAll()
  }
})

test('a streaming source is dropped after timeoutMs of silence, and every setInput restarts that clock', () => {
  const { clock, set } = fakeClock()
  const mux = new PriorityMuxer(clock)
  mux.register(BACKGROUND_PRIORITY, { component: 'background' })
  mux.setInput(BACKGROUND_PRIORITY, solid(0, 0, 0.05))

  assert.equal(DEFAULT_STREAM_TIMEOUT_MS.capture, 5000)
  mux.register(250, { component: 'capture', timeoutMs: DEFAULT_STREAM_TIMEOUT_MS.capture })
  mux.setInput(250, frame())

  set(4999)
  assert.equal(mux.tick()?.priority, 250)
  mux.setInput(250, frame())

  // Without the refresh at 4999 this source would have died at 5000.
  set(9998)
  assert.equal(mux.tick()?.priority, 250)
  set(9999)
  assert.equal(mux.tick()?.priority, BACKGROUND_PRIORITY)
  assert.equal(mux.has(250), false)
})

test('a streaming source that never delivered does not time out', () => {
  const { clock, set } = fakeClock()
  const mux = new PriorityMuxer(clock)
  mux.register(250, { component: 'capture', timeoutMs: 1000 })

  set(100_000)
  assert.equal(mux.tick(), null)
  assert.equal(mux.has(250), true, 'silence before the first frame is not a stall')
})

test('a duration and an inactivity limit each end the source, whichever comes first', () => {
  const { clock, set } = fakeClock()
  const mux = new PriorityMuxer(clock)

  mux.register(10, { component: 'effect', durationMs: 300, timeoutMs: 100 })
  mux.setInput(10, solid(1, 0, 0))
  set(100)
  assert.equal(mux.tick(), null, 'inactivity limit came first')

  set(0)
  mux.register(20, { component: 'effect', durationMs: 100, timeoutMs: 1000 })
  mux.setInput(20, solid(1, 0, 0))
  set(50)
  mux.setInput(20, solid(1, 0, 0))
  set(100)
  assert.equal(mux.tick(), null, 'duration came first')
})

test('clearAll removes every source except the background; clear can still remove that', () => {
  const mux = new PriorityMuxer(fakeClock().clock)
  mux.register(BACKGROUND_PRIORITY, { component: 'background' })
  mux.setInput(BACKGROUND_PRIORITY, solid(0.02, 0.02, 0.02))
  mux.register(1, { component: 'color' })
  mux.setInput(1, solid(1, 0, 0))
  mux.register(100, { component: 'capture' })
  mux.setInput(100, frame())
  mux.register(254, { component: 'effect' })
  mux.setInput(254, solid(0, 1, 0))
  assert.equal(mux.tick()?.priority, 1)

  mux.clearAll()
  assert.equal(mux.tick()?.priority, BACKGROUND_PRIORITY)
  assert.equal(mux.has(1), false)
  assert.equal(mux.has(100), false, 'capture does not survive clearAll')
  assert.equal(mux.has(254), false)
  assert.equal(mux.has(BACKGROUND_PRIORITY), true)

  assert.equal(mux.clear(BACKGROUND_PRIORITY), true)
  assert.equal(mux.tick(), null)
})

test('onChange fires only when the winner changes, not on every tick', () => {
  const mux = new PriorityMuxer(fakeClock().clock)
  const changes = recordChanges(mux)

  mux.register(10, { component: 'color' })
  mux.setInput(10, solid(1, 0, 0))
  mux.tick()
  assert.equal(changes.length, 1)
  assert.equal(changes[0]?.previous, null)
  assert.equal(changes[0]?.current?.priority, 10)

  // Five frames of fresh input from the same winner: no events.
  for (let i = 0; i < 5; i++) {
    mux.setInput(10, solid(i / 5, 0, 0))
    mux.tick()
  }
  assert.equal(changes.length, 1)

  mux.clear(10)
  mux.tick()
  assert.equal(changes.length, 2)
  assert.equal(changes[1]?.previous?.priority, 10)
  assert.equal(changes[1]?.current, null)

  mux.tick()
  mux.tick()
  mux.tick()
  assert.equal(changes.length, 2)
})

test('the null <-> non-null transitions are reported exactly once each', () => {
  const mux = new PriorityMuxer(fakeClock().clock)
  const changes = recordChanges(mux)

  // Nothing registered: null -> null is not a transition.
  assert.equal(mux.tick(), null)
  assert.equal(mux.tick(), null)
  assert.equal(changes.length, 0)

  mux.register(200, { component: 'effect' })
  mux.setInput(200, solid(0, 1, 0))
  assert.notEqual(mux.tick(), null)
  assert.equal(changes.length, 1, 'off -> on')
  assert.deepEqual(
    { previous: changes[0]?.previous, priority: changes[0]?.current?.priority },
    { previous: null, priority: 200 }
  )

  mux.clear(200)
  assert.equal(mux.tick(), null)
  assert.equal(changes.length, 2, 'on -> off')
  assert.equal(changes[1]?.previous?.priority, 200)
  assert.equal(changes[1]?.current, null)

  assert.equal(mux.tick(), null)
  assert.equal(changes.length, 2)
})

test('a different component at the same priority is a winner change', () => {
  // Hyperion emits visibleComponentChanged for this even though the priority
  // did not move; the backlight rule downstream depends on it.
  const mux = new PriorityMuxer(fakeClock().clock)
  const changes = recordChanges(mux)
  mux.register(100, { component: 'effect' })
  mux.setInput(100, solid(0, 1, 0))
  mux.tick()

  mux.register(100, { component: 'color' })
  mux.setInput(100, solid(1, 0, 0))
  mux.tick()
  assert.equal(changes.length, 2)
  assert.equal(changes[1]?.previous?.component, 'effect')
  assert.equal(changes[1]?.current?.component, 'color')
})

test('unsubscribing stops the callbacks', () => {
  const mux = new PriorityMuxer(fakeClock().clock)
  let calls = 0
  const unsubscribe = mux.onChange(() => { calls++ })
  mux.register(1, { component: 'color' })
  mux.setInput(1, solid(1, 1, 1))
  mux.tick()
  assert.equal(calls, 1)

  unsubscribe()
  mux.clear(1)
  mux.tick()
  assert.equal(calls, 1)
})

test('re-registering a priority drops the previous input instead of serving it under the new owner', () => {
  // Hyperion's registerInput() on an occupied priority keeps the old input and
  // timeout ("Reuse input"), so a new effect shows the old one's last frame
  // until it delivers. Here the slot starts clean.
  const { clock, set } = fakeClock()
  const mux = new PriorityMuxer(clock)
  const stale = solid(1, 0, 0)
  mux.register(100, { component: 'effect' })
  mux.setInput(100, stale)
  assert.equal(mux.tick()?.input, stale)

  set(5)
  mux.register(100, { component: 'effect' })
  assert.equal(mux.tick(), null, 'the old input must not be served')

  const fresh = solid(0, 1, 0)
  mux.setInput(100, fresh)
  const winner = mux.tick()
  assert.equal(winner?.input, fresh)
  assert.equal(winner?.registeredAt, 5)
})

test('arbitration is per frame: a replace-and-feed between two ticks is invisible', () => {
  // Hyperion re-arbitrates inside every mutation, so the same sequence emits
  // "gone" then "back". The LEDs never showed the gap, so neither do we.
  const mux = new PriorityMuxer(fakeClock().clock)
  const changes = recordChanges(mux)
  mux.register(100, { component: 'effect' })
  mux.setInput(100, solid(1, 0, 0))
  assert.equal(mux.current(), null, 'nothing is decided before the first tick')
  mux.tick()
  assert.equal(changes.length, 1)

  mux.register(100, { component: 'effect' })
  mux.setInput(100, solid(0, 1, 0))
  mux.tick()
  assert.equal(changes.length, 1)
  assert.equal(mux.current()?.priority, 100)
})

test('tick() hands back the latest input of an unchanged winner, and the same object when nothing moved', () => {
  const mux = new PriorityMuxer(fakeClock().clock)
  const changes = recordChanges(mux)
  mux.register(10, { component: 'color' })

  const first = solid(1, 0, 0)
  mux.setInput(10, first)
  const a = mux.tick()
  assert.equal(a?.input, first)
  assert.equal(mux.tick(), a, 'identical state, identical object')
  assert.equal(mux.current(), a)

  const second = solid(0, 0, 1)
  mux.setInput(10, second)
  const b = mux.tick()
  assert.equal(b?.input, second)
  assert.notEqual(b, a)
  assert.equal(changes.length, 1)
})

test('setInput on an unregistered priority throws instead of failing silently', () => {
  // Hyperion logs "setInput() used without registerInput()" and returns false.
  const { clock, set } = fakeClock()
  const mux = new PriorityMuxer(clock)
  assert.throws(() => mux.setInput(42, solid(1, 1, 1)), /unregistered priority 42/)

  // Including a source that was registered and has since expired.
  mux.register(42, { component: 'color', durationMs: 10 })
  mux.setInput(42, solid(1, 1, 1))
  set(10)
  mux.tick()
  assert.throws(() => mux.setInput(42, solid(1, 1, 1)), /unregistered/)
})

test('priorities outside 1..255, non-integers, empty components and non-positive limits are rejected', () => {
  const mux = new PriorityMuxer(fakeClock().clock)
  for (const bad of [0, 256, 1.5, -1, NaN, Infinity]) {
    assert.throws(() => mux.register(bad, { component: 'color' }), RangeError, `priority ${bad}`)
  }
  assert.throws(() => mux.register(1, { component: '' }), TypeError)
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.throws(() => mux.register(1, { component: 'color', timeoutMs: bad }), RangeError, `timeoutMs ${bad}`)
    assert.throws(() => mux.register(1, { component: 'color', durationMs: bad }), RangeError, `durationMs ${bad}`)
  }
  assert.equal(mux.has(1), false, 'a rejected registration leaves nothing behind')
})

test('sources() lists registrations in priority order with their active state', () => {
  const { clock, set } = fakeClock()
  const mux = new PriorityMuxer(clock)
  set(7)
  mux.register(200, { component: 'capture' })
  mux.register(5, { component: 'color' })
  mux.setInput(5, solid(1, 0, 0))
  mux.register(BACKGROUND_PRIORITY, { component: 'background' })
  mux.setInput(BACKGROUND_PRIORITY, solid(0, 0, 0))

  assert.deepEqual(mux.sources(), [
    { priority: 5, component: 'color', registeredAt: 7, active: true },
    { priority: 200, component: 'capture', registeredAt: 7, active: false },
    { priority: 255, component: 'background', registeredAt: 7, active: true }
  ])
})
