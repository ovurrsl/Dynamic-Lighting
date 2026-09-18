import assert from 'node:assert/strict'
import test from 'node:test'

import { openDisplayAudio, openMicrophone, type AnalyserLike, type AudioContextLike } from '#lib/engine/audio-input'

function fakeContext (over: Partial<AudioContextLike> = {}): AudioContextLike & { closed: boolean, analyser: AnalyserLike } {
  const analyser = {
    fftSize: 0,
    frequencyBinCount: 8,
    smoothingTimeConstant: 1,
    minDecibels: -100,
    maxDecibels: -30,
    getByteFrequencyData (array: Uint8Array) { array.fill(128) },
    disconnect () {}
  }
  const context = {
    closed: false,
    analyser,
    sampleRate: 48000,
    state: 'running',
    createAnalyser: () => analyser,
    createMediaStreamSource: () => ({ connect () {}, disconnect () {} }),
    async resume () {},
    async close () { context.closed = true },
    ...over
  }
  return context as AudioContextLike & { closed: boolean, analyser: AnalyserLike }
}

const stream = (audio = 1): unknown => {
  const stopped: string[] = []
  const tracks = Array.from({ length: audio }, () => ({ stop: () => stopped.push('audio') }))
  return {
    stopped,
    getAudioTracks: () => tracks,
    getTracks: () => [...tracks, { stop: () => stopped.push('video') }]
  }
}

test('the microphone asks for raw audio, not a cleaned-up voice', async () => {
  let asked: any
  const context = fakeContext()
  await openMicrophone({
    context: () => context,
    getUserMedia: async (c) => { asked = c; return stream() }
  })
  // Each of these fights a music visualiser; echo cancellation would subtract
  // the speakers, which is the entire signal.
  assert.equal(asked.audio.echoCancellation, false)
  assert.equal(asked.audio.noiseSuppression, false)
  assert.equal(asked.audio.autoGainControl, false)
})

test('a refused permission gets its own sentence', async () => {
  const denied = Object.assign(new Error('nope'), { name: 'NotAllowedError' })
  await assert.rejects(
    () => openMicrophone({ context: () => fakeContext(), getUserMedia: async () => { throw denied } }),
    /microphone permission was refused/
  )
})

test('a display capture with no audio track says so', async () => {
  // Safari and Firefox hand back video with no audio at all, and a visualiser
  // sitting at zero with no explanation is the worst possible outcome.
  await assert.rejects(
    () => openDisplayAudio({ context: () => fakeContext(), getDisplayMedia: async () => stream(0) }),
    /does not share tab or system audio/
  )
})

test('a suspended context is resumed, or the analyser reports pure silence', async () => {
  let resumed = false
  const context = fakeContext({ state: 'suspended', resume: async () => { resumed = true } })
  await openMicrophone({ context: () => context, getUserMedia: async () => stream() })
  assert.ok(resumed)
})

test('the analyser is configured for music, not for speech', async () => {
  const context = fakeContext()
  const source = await openMicrophone({ context: () => context, getUserMedia: async () => stream() })
  // Smoothing is ours, per band, where it is a setting; doing it here as well
  // would be two filters in series with one of them unadjustable.
  assert.equal(context.analyser.smoothingTimeConstant, 0)
  // Quietly mastered music sits below -30 dB and would be clipped off the top.
  assert.equal(context.analyser.minDecibels, -90)
  assert.equal(context.analyser.maxDecibels, -10)
  assert.equal(source.sampleRate, 48000)
  assert.equal(source.binCount, 8)
})

test('reading normalises to 0..1 and clears anything past the bins', async () => {
  const source = await openMicrophone({ context: () => fakeContext(), getUserMedia: async () => stream() })
  const bins = new Float32Array(12).fill(0.9)
  assert.equal(source.read(bins), true)
  for (let i = 0; i < 8; i++) assert.ok(Math.abs((bins[i] as number) - 128 / 255) < 1e-6)
  // Stale, not silent: leaving the tail alone would feed the visualiser numbers
  // from a previous, differently-sized source.
  for (let i = 8; i < 12; i++) assert.equal(bins[i], 0)
})

test('stopping releases the tracks and the context, and reads stop', async () => {
  const media = stream() as any
  const context = fakeContext()
  const source = await openMicrophone({ context: () => context, getUserMedia: async () => media })
  await source.stop()
  assert.ok(context.closed, 'a context left open keeps the microphone indicator on')
  assert.ok(media.stopped.includes('audio'))
  assert.equal(source.read(new Float32Array(8)), false)
})

test('a display capture stops its video track too', async () => {
  const media = stream() as any
  const source = await openDisplayAudio({
    context: () => fakeContext(),
    getDisplayMedia: async () => media
  })
  await source.stop()
  assert.ok(media.stopped.includes('video'), 'the browser would keep saying "sharing your screen"')
})

test('a track that ends - "Stop sharing", a microphone unplugged - makes read() say so', async () => {
  // The analyser goes on reporting zeros after the source is gone, which a
  // visualiser cannot tell from a quiet room. Only the track says so.
  const listeners: Array<() => void> = []
  const track = { stop () {}, addEventListener (type: string, fn: () => void) { if (type === 'ended') listeners.push(fn) } }
  const withEnded = { getAudioTracks: () => [track], getTracks: () => [track] }
  const source = await openMicrophone({ context: () => fakeContext(), getUserMedia: async () => withEnded })
  const bins = new Float32Array(8)
  assert.equal(source.read(bins), true)
  assert.equal(listeners.length, 1, 'the source listens for the end of its track')
  for (const fn of listeners) fn()
  assert.equal(source.read(bins), false)
})

test('a graph that fails to build gives the tracks back, or the browser keeps saying "recording"', async () => {
  const s = stream() as { stopped: string[] }
  await assert.rejects(
    () => openMicrophone({
      context: () => fakeContext({ createAnalyser: () => { throw new Error('no analyser today') } }),
      getUserMedia: async () => s
    }),
    /no analyser today/
  )
  assert.ok(s.stopped.includes('audio'), 'the audio track must be stopped')
  assert.ok(s.stopped.includes('video'), 'and any video track with it')
})
