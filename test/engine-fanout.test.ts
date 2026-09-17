import assert from 'node:assert/strict'
import test from 'node:test'

import { createFanout } from '#lib/engine/fanout'
import type { FrameHandler, FrameSource, SourceFrame } from '#lib/engine/source'

/**
 * A capture stood in for by hand.
 *
 * `closed` counts how many times the UPSTREAM frame was released, which is the
 * number that matters: one close is correct, zero strands the browser's buffer
 * pool and the capture stops after a few dozen frames, two is a use-after-free
 * that only shows on a real stream.
 */
function fakeSource () {
  let handler: FrameHandler | null = null
  let ended: ((error?: unknown) => void) | null = null
  let stops = 0
  let starts = 0
  const closed: number[] = []

  const source: FrameSource = {
    kind: 'stream',
    settings: () => ({ width: 1280, height: 720, frameRate: 60 }),
    start (onFrame, onEnd) {
      starts++
      handler = onFrame
      ended = onEnd ?? null
    },
    // The handler deliberately survives `stop`: a real reader can still deliver
    // a frame it had already read while `cancel()` is resolving, and a frame
    // that arrives with nobody listening must still be released.
    async stop () { stops++ }
  }

  return {
    source,
    starts: () => starts,
    stops: () => stops,
    closed,
    /** Pushes one frame; returns how many times it was released. */
    push (n = 0, at = n): SourceFrame {
      let count = 0
      const frame: SourceFrame = {
        image: { tag: `frame-${n}` },
        width: 1280,
        height: 720,
        release: () => { count++; closed[n] = count }
      }
      closed[n] = 0
      handler?.(frame, at)
      return frame
    },
    end (error?: unknown) { ended?.(error) }
  }
}

test('one frame reaches every consumer and is released exactly once', () => {
  const up = fakeSource()
  const fan = createFanout(up.source)
  const seen: string[] = []
  const held: SourceFrame[] = []

  for (const name of ['masa', 'tv']) {
    const view = fan.attach()
    view.start((frame) => { seen.push(`${name}:${String((frame.image as { tag: string }).tag)}`); held.push(frame) })
  }
  assert.equal(up.starts(), 1, 'one capture, however many strips')
  assert.equal(fan.active(), 2)

  up.push(0)
  assert.deepEqual(seen, ['masa:frame-0', 'tv:frame-0'])
  assert.equal(up.closed[0], 0, 'nobody has let go yet, so the buffer is still ours')

  held[0]?.release()
  assert.equal(up.closed[0], 0, 'one consumer is still reading it')
  held[1]?.release()
  assert.equal(up.closed[0], 1, 'and now, exactly once')
})

test('a consumer releasing inside its handler does not free the frame under the next one', () => {
  // The bug this exists for: a synchronous release takes the count to zero
  // before the second consumer has even been offered the frame.
  const up = fakeSource()
  const fan = createFanout(up.source)
  let secondSawOpenFrame = false

  const quick = fan.attach()
  quick.start((frame) => { frame.release() })
  const slow = fan.attach()
  slow.start(() => { secondSawOpenFrame = up.closed[0] === 0 })

  up.push(0)
  assert.equal(secondSawOpenFrame, true)
  assert.equal(up.closed[0], 0, 'the slow one is still holding it')
})

test('releasing twice counts once, because the engine really does release twice', () => {
  // lib/engine/runtime.ts releases once it has the bitmap and again in its
  // `finally`. Counting that as two consumers letting go would free the buffer
  // while another instance is mid-`createImageBitmap`.
  const up = fakeSource()
  const fan = createFanout(up.source)
  const held: SourceFrame[] = []
  fan.attach().start((frame) => { frame.release(); frame.release(); frame.release() })
  fan.attach().start((frame) => { held.push(frame) })

  up.push(0)
  assert.equal(up.closed[0], 0, 'three releases from one consumer are still one consumer')
  held[0]?.release()
  assert.equal(up.closed[0], 1)
})

test('a consumer that throws strands nothing', () => {
  const up = fakeSource()
  const fan = createFanout(up.source)
  const held: SourceFrame[] = []
  fan.attach().start(() => { throw new Error('sampler blew up') })
  fan.attach().start((frame) => { held.push(frame) })

  up.push(0)
  assert.equal(held.length, 1, 'the healthy instance still got its frame')
  held[0]?.release()
  assert.equal(up.closed[0], 1, 'and the buffer came back')
})

test('a frame with nobody started is released immediately, not leaked', () => {
  const up = fakeSource()
  const fan = createFanout(up.source)
  const view = fan.attach()
  view.start(() => {})
  void view.stop()
  // The upstream is stopped by now, but a frame already in flight can still
  // arrive - and one that is never released costs the pool a slot forever.
  up.push(0)
  assert.equal(up.closed[0], 1)
})

test('the capture starts with the first strip and stops with the last', async () => {
  const up = fakeSource()
  const fan = createFanout(up.source)
  const masa = fan.attach()
  const tv = fan.attach()

  masa.start(() => {})
  assert.equal(up.starts(), 1)
  tv.start(() => {})
  assert.equal(up.starts(), 1, 'the second strip joins, it does not open a second picker')

  await masa.stop()
  assert.equal(up.stops(), 0, 'turning off one strip must not end the other’s capture')
  assert.equal(fan.active(), 1)

  await tv.stop()
  assert.equal(up.stops(), 1, 'and the last one out really does stop reading the screen')
  assert.equal(fan.active(), 0)
})

test('a lost capture is reported to every instance that was running', () => {
  const up = fakeSource()
  const fan = createFanout(up.source)
  const errors: string[] = []
  const a = fan.attach()
  const b = fan.attach()
  a.start(() => {}, (error) => { errors.push(`a:${String(error)}`) })
  b.start(() => {}, (error) => { errors.push(`b:${String(error)}`) })
  fan.attach().start(() => {}, () => { errors.push('c') })

  up.end(new Error('screen share stopped'))
  assert.deepEqual(errors, ['a:Error: screen share stopped', 'b:Error: screen share stopped', 'c'])
  assert.equal(fan.active(), 0, 'a lost capture leaves nobody running')
})

test('joining after the capture has ended is told so rather than left waiting', () => {
  const up = fakeSource()
  const fan = createFanout(up.source)
  fan.attach().start(() => {})
  up.end()

  let told = false
  fan.attach().start(() => {}, () => { told = true })
  assert.equal(told, true)
  assert.equal(fan.active(), 0)
})

test('settings come from the capture, so every instance reports the same screen', () => {
  const up = fakeSource()
  const fan = createFanout(up.source)
  assert.deepEqual(fan.attach().settings(), { width: 1280, height: 720, frameRate: 60 })
  assert.equal(fan.kind, 'stream')
  assert.equal(fan.attach().kind, 'stream')
})

test('stopping the fanout ends everything at once', async () => {
  const up = fakeSource()
  const fan = createFanout(up.source)
  fan.attach().start(() => {})
  fan.attach().start(() => {})
  assert.equal(fan.attached(), 2)

  await fan.stop()
  assert.equal(up.stops(), 1)
  assert.equal(fan.active(), 0)
  assert.equal(fan.attached(), 0)
})

test('after the last consumer leaves, the fanout is ended: nobody is attached to a stopped track', async () => {
  // FrameSource.start is once. A fanout left "not ended" after its upstream
  // was stopped handed the next consumer a source that could never deliver,
  // which on the panel read as "the capture ended on its own" after a Stop.
  const up = fakeSource()
  const fan = createFanout(up.source)
  const only = fan.attach()
  only.start(() => {})
  await only.stop()
  assert.equal(up.stops(), 1)
  assert.equal(fan.ended(), true, 'idle means ended, because a stopped source cannot be started again')

  let told = false
  fan.attach().start(() => {}, () => { told = true })
  assert.equal(told, true, 'a late joiner is told, not left waiting')
  assert.equal(up.starts(), 1, 'and the dead upstream was not started a second time')
})
