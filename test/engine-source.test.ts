import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createStreamSource,
  createVideoSource,
  hasStreamSource,
  type SourceFrame,
  type StreamFrame,
  type StreamReader,
  type VideoElement
} from '#lib/engine/source'

/** A clock we advance by hand, so arrival times are asserted rather than raced. */
function ticker (): { now: () => number, advance: (ms: number) => void } {
  let at = 0
  return { now: () => at, advance: (ms) => { at += ms } }
}

/**
 * A `MediaStreamTrackProcessor` we push frames into.
 *
 * The reason the processor is injected at all: the paths that matter here -
 * a frame arriving, a track ending, a reader cancelled mid-read - are the ones
 * that cannot be provoked reliably against a real screen capture.
 */
function fakeStream (): {
  reader: StreamReader
  push: (frame: StreamFrame) => void
  end: () => void
  fail: (error: unknown) => void
  released: () => boolean
} {
  const queue: Array<{ value?: StreamFrame, done: boolean }> = []
  let waiting: ((value: { value?: StreamFrame, done: boolean }) => void) | null = null
  let rejecting: ((error: unknown) => void) | null = null
  let released = false

  const settle = (item: { value?: StreamFrame, done: boolean }): void => {
    if (waiting !== null) {
      const resolve = waiting
      waiting = null
      rejecting = null
      resolve(item)
    } else {
      queue.push(item)
    }
  }

  return {
    released: () => released,
    push: (frame) => { settle({ value: frame, done: false }) },
    end: () => { settle({ done: true }) },
    fail: (error) => {
      if (rejecting !== null) {
        const reject = rejecting
        waiting = null
        rejecting = null
        reject(error)
      }
    },
    reader: {
      async read () {
        const next = queue.shift()
        if (next !== undefined) return next
        return await new Promise((resolve, reject) => { waiting = resolve; rejecting = reject })
      },
      async cancel () { settle({ done: true }) },
      releaseLock () { released = true }
    }
  }
}

function frame (width = 1920, height = 1080): StreamFrame & { closed: boolean } {
  const f = {
    displayWidth: width,
    displayHeight: height,
    closed: false,
    close () { f.closed = true }
  }
  return f
}

const fakeTrack = (): { stop: () => void, stopped: boolean } => {
  const track = { stopped: false, stop: () => { track.stopped = true } }
  return track
}

// ---------------------------------------------------------------------------
// The stream route.
// ---------------------------------------------------------------------------

test('the stream source hands over each frame with its size and a release', async () => {
  const clock = ticker()
  const stream = fakeStream()
  const track = fakeTrack()
  const source = createStreamSource({
    track,
    clock: clock.now,
    processor: () => ({ readable: { getReader: () => stream.reader } })
  })
  assert.equal(source.kind, 'stream')

  const seen: Array<{ frame: SourceFrame, at: number }> = []
  source.start((f, at) => { seen.push({ frame: f, at }) })

  const first = frame(2560, 1440)
  clock.advance(16)
  stream.push(first)
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.frame.width, 2560)
  assert.equal(seen[0]?.frame.height, 1440)
  assert.equal(seen[0]?.at, 16)
  assert.equal(first.closed, false, 'the handler owns the frame')
  seen[0]?.frame.release()
  assert.equal(first.closed, true)
  await source.stop()
})

test('a track that ends is reported as an end, not as an error', async () => {
  // This is a resolution change, an HDR toggle or a monitor going to sleep -
  // it happens on real desks every day and needs a different sentence and a
  // button, not a stack trace.
  const stream = fakeStream()
  const ends: unknown[] = []
  const source = createStreamSource({
    track: fakeTrack(),
    clock: () => 0,
    processor: () => ({ readable: { getReader: () => stream.reader } })
  })
  source.start(() => {}, (error) => { ends.push(error) })
  stream.end()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(ends, [undefined], 'an ended stream reports no error')
  assert.ok(stream.released(), 'the reader lock should be released')
  await source.stop()
})

test('stopping does not report an end, because stopping is a decision', async () => {
  const stream = fakeStream()
  const ends: unknown[] = []
  const track = fakeTrack()
  const source = createStreamSource({
    track,
    clock: () => 0,
    processor: () => ({ readable: { getReader: () => stream.reader } })
  })
  source.start(() => {}, (error) => { ends.push(error) })
  await source.stop()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ends.length, 0, 'a deliberate stop must not read as the capture dying')
  assert.ok(track.stopped, 'the track has to be stopped or the browser keeps sharing')
})

test('a processor this browser does not have is an end, not a throw', async () => {
  const ends: unknown[] = []
  const source = createStreamSource({
    track: fakeTrack(),
    clock: () => 0,
    processor: () => { throw new Error('no MediaStreamTrackProcessor') }
  })
  source.start(() => {}, (error) => { ends.push(error) })
  assert.equal((ends[0] as Error).message, 'no MediaStreamTrackProcessor')
  await source.stop()
})

test('a stream that fails mid-read reports the error', async () => {
  const stream = fakeStream()
  const ends: unknown[] = []
  const source = createStreamSource({
    track: fakeTrack(),
    clock: () => 0,
    processor: () => ({ readable: { getReader: () => stream.reader } })
  })
  source.start(() => {}, (error) => { ends.push(error) })
  await Promise.resolve()
  stream.fail(new Error('source gone'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((ends[0] as Error).message, 'source gone')
})

// ---------------------------------------------------------------------------
// The video route.
// ---------------------------------------------------------------------------

function fakeVideo (options: { callback?: boolean, width?: number, height?: number } = {}): VideoElement & {
  fire: () => void
  playing: boolean
  cancelled: number[]
} {
  let pending: ((now: number) => void) | null = null
  let handle = 0
  const video = {
    srcObject: null as unknown,
    videoWidth: options.width ?? 1180,
    videoHeight: options.height ?? 2556,
    muted: false,
    playsInline: false,
    playing: false,
    cancelled: [] as number[],
    async play () { video.playing = true },
    pause () { video.playing = false },
    fire () { pending?.(0) },
    ...(options.callback === false
      ? {}
      : {
          requestVideoFrameCallback (callback: (now: number) => void) {
            pending = callback
            handle += 1
            return handle
          },
          cancelVideoFrameCallback (h: number) { video.cancelled.push(h) }
        })
  }
  return video as VideoElement & { fire: () => void, playing: boolean, cancelled: number[] }
}

/** A scheduler we step by hand, so the timer route is asserted rather than waited for. */
function clockwork (): { schedule: (fn: () => void, ms: number) => unknown, cancel: (h: unknown) => void, delays: number[], step: () => void } {
  const queue: Array<() => void> = []
  const delays: number[] = []
  return {
    delays,
    schedule (fn, ms) { delays.push(ms); queue.push(fn); return queue.length - 1 },
    cancel () { queue.length = 0 },
    step () {
      const pending = queue.shift()
      pending?.()
    }
  }
}

test('the video source attaches the stream and plays it muted and inline', () => {
  // Muted and playsInline are not decoration: without them iOS refuses to play
  // the element at all, and the capture that the phone can do is then wasted on
  // a video that never starts.
  const video = fakeVideo()
  const stream = { id: 'a-stream' }
  const source = createVideoSource({
    stream, track: fakeTrack(), video, clock: () => 0, fps: 60
  })
  source.start(() => {})
  assert.equal(video.srcObject, stream)
  assert.equal(video.muted, true)
  assert.equal(video.playsInline, true)
  assert.equal((video as unknown as { playing: boolean }).playing, true)
})

test('the callback route delivers the element itself, with no release to forget', async () => {
  const clock = ticker()
  const video = fakeVideo()
  const source = createVideoSource({
    stream: {}, track: fakeTrack(), video, clock: clock.now, fps: 60
  })
  assert.equal(source.kind, 'video-callback')

  const seen: SourceFrame[] = []
  source.start((f) => { seen.push(f) })
  clock.advance(8)
  video.fire()
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.image, video, 'createImageBitmap takes the element directly')
  assert.equal(seen[0]?.width, 1180)
  assert.equal(seen[0]?.height, 2556)
  // A no-op rather than an absent function: making the caller branch on the
  // source kind is how a VideoFrame leak gets written on the other route.
  assert.doesNotThrow(() => { seen[0]?.release() })

  video.fire()
  assert.equal(seen.length, 2, 'the callback should re-arm after each frame')
  await source.stop()
})

test('a video with no frame yet is skipped rather than drawn', () => {
  // A <video> is zero by zero until its first frame, and drawImage throws on a
  // source that size instead of drawing nothing.
  const video = fakeVideo({ width: 0, height: 0 })
  const seen: SourceFrame[] = []
  const source = createVideoSource({ stream: {}, track: fakeTrack(), video, clock: () => 0, fps: 60 })
  source.start((f) => { seen.push(f) })
  video.fire()
  assert.equal(seen.length, 0)
})

test('without requestVideoFrameCallback a timer stands in, at the capture rate', () => {
  const timers = clockwork()
  const video = fakeVideo({ callback: false })
  const seen: SourceFrame[] = []
  const source = createVideoSource({
    stream: {}, track: fakeTrack(), video, clock: () => 0, fps: 30,
    schedule: timers.schedule, cancel: timers.cancel
  })
  assert.equal(source.kind, 'video-timer', 'the panel has to be able to say which route is running')
  source.start((f) => { seen.push(f) })
  assert.equal(timers.delays[0], 33, '30 fps is a 33 ms period')
  timers.step()
  assert.equal(seen.length, 1)
  timers.step()
  assert.equal(seen.length, 2)
})

test('the timer route can be forced, so the two can be compared on a real machine', () => {
  const timers = clockwork()
  const source = createVideoSource({
    stream: {}, track: fakeTrack(), video: fakeVideo(), clock: () => 0, fps: 60,
    schedule: timers.schedule, cancel: timers.cancel, preferTimer: true
  })
  assert.equal(source.kind, 'video-timer')
})

test('stopping a video source releases the element and the track', async () => {
  const timers = clockwork()
  const video = fakeVideo()
  const track = fakeTrack()
  const source = createVideoSource({
    stream: {}, track, video, clock: () => 0, fps: 60, schedule: timers.schedule, cancel: timers.cancel
  })
  const seen: SourceFrame[] = []
  source.start((f) => { seen.push(f) })
  await source.stop()

  assert.equal(video.srcObject, null, 'a held srcObject keeps the browser sharing the screen')
  assert.equal((video as unknown as { playing: boolean }).playing, false)
  assert.ok(track.stopped)
  assert.deepEqual(video.cancelled, [1])
  video.fire()
  assert.equal(seen.length, 0, 'a stopped source delivered a frame')
})

test('the stream route is detected, not assumed', () => {
  assert.equal(hasStreamSource({}), false)
  assert.equal(hasStreamSource({ MediaStreamTrackProcessor: class {} }), true)
  assert.equal(hasStreamSource(undefined), false)
})
