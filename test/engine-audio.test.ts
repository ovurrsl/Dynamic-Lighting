import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUDIO_KINDS,
  GAIN_MAX,
  GAIN_MIN,
  NOISE_FLOOR,
  createFollower,
  createVisualiser,
  isAudioKind,
  logBands,
  parseAudioSpec
} from '#lib/engine/audio'
import { DEFAULT_ENGINE_CONFIG, resolveLayout, type EngineConfig } from '#lib/engine/config'
import { effectGeometry } from '#lib/engine/effects'
import { allocLedColors } from '#lib/engine/types'

const LAYOUT = resolveLayout(DEFAULT_ENGINE_CONFIG as EngineConfig)
const GEOMETRY = effectGeometry(LAYOUT)
const BINS = 512
const RATE = 48000

const frame = (): Float32Array => allocLedColors(LAYOUT.length)

/** A spectrum with energy only in the given bin range. */
function spectrum (from: number, to: number, magnitude = 1): Float32Array {
  const bins = new Float32Array(BINS)
  for (let i = from; i < to; i++) bins[i] = magnitude
  return bins
}

const maxOf = (out: Float32Array): number => {
  let max = 0
  for (const v of out) max = Math.max(max, v)
  return max
}

// ---------------------------------------------------------------------------
// Bands.
// ---------------------------------------------------------------------------

test('bands are logarithmic, because hearing is', () => {
  // The defect this prevents: with linear bands a 60 Hz kick and a 12 kHz
  // hi-hat land four LEDs apart out of a hundred, and the whole display is a
  // twitch in one corner.
  const edges = logBands(BINS, 16, RATE)
  const widths: number[] = []
  for (let i = 0; i < 16; i++) widths.push((edges[i + 1] as number) - (edges[i] as number))
  // Each band covers more bins than the one below it - that IS logarithmic.
  assert.ok((widths[15] as number) > (widths[0] as number) * 5, JSON.stringify(widths))
  for (let i = 1; i < widths.length; i++) {
    assert.ok((widths[i] as number) >= (widths[i - 1] as number), `band ${i} is narrower than ${i - 1}`)
  }
})

test('no band is empty, because an empty band is a dead LED nobody can explain', () => {
  for (const bands of [8, 16, 32, 64, 108]) {
    const edges = logBands(BINS, bands, RATE)
    for (let i = 0; i < bands; i++) {
      assert.ok((edges[i + 1] as number) > (edges[i] as number), `${bands} bands: band ${i} is empty`)
    }
  }
})

test('the top band is capped at Nyquist, not at a constant', () => {
  // 16 kHz is above Nyquist on a 22.05 kHz context, and a band beyond it would
  // be permanently silent.
  const edges = logBands(BINS, 8, 22050)
  assert.ok((edges[8] as number) <= BINS)
  const wide = logBands(BINS, 8, 96000)
  assert.ok((wide[8] as number) <= BINS)
})

test('bad arguments are refused rather than producing a silent display', () => {
  assert.throws(() => logBands(1, 8, RATE), /binCount/)
  assert.throws(() => logBands(BINS, 0, RATE), /bands/)
})

// ---------------------------------------------------------------------------
// The follower.
// ---------------------------------------------------------------------------

test('the follower rises instantly and falls slowly', () => {
  // Symmetric would either track every snare - the whole display pumps - or lag
  // the music entirely. This asymmetry is the same idea as the capture
  // smoother's, for the same reason.
  const follower = createFollower(0.5, 120)
  assert.equal(follower.push(0.8), 0.8, 'a louder peak is taken immediately')
  const after = follower.push(0.1)
  assert.ok(after > 0.7, `it fell to ${after} in one frame`)
  for (let i = 0; i < 240; i++) follower.push(0.1)
  assert.ok(follower.value() < 0.3, 'and it does come down over a couple of seconds')
})

test('the follower never falls below the noise floor', () => {
  // Otherwise the divisor approaches zero and a silent room is amplified into a
  // full-brightness display of its own mains hum.
  const follower = createFollower(0.9, 120)
  for (let i = 0; i < 10000; i++) follower.push(0)
  assert.ok(follower.value() >= NOISE_FLOOR)
})

// ---------------------------------------------------------------------------
// Every visualiser.
// ---------------------------------------------------------------------------

for (const kind of AUDIO_KINDS) {
  const build = (over: Record<string, unknown> = {}) => createVisualiser({
    spec: { kind, ...over },
    geometry: GEOMETRY,
    sampleRate: RATE,
    binCount: BINS
  })

  test(`${kind}: silence lights nothing`, () => {
    // A silent room is a fan, a disk and mains hum. Without a floor the strip
    // shimmers faintly forever and the user concludes it is broken.
    const v = build()
    const out = frame()
    const quiet = new Float32Array(BINS)
    for (let i = 0; i < 300; i++) v.render(quiet, out, i * 8)
    assert.equal(maxOf(out), 0, `${kind} lit up in silence`)
  })

  test(`${kind}: output stays inside 0..1 even when the input is slammed`, () => {
    const v = build({ gain: GAIN_MAX })
    const out = frame()
    const loud = spectrum(0, BINS, 1)
    for (let i = 0; i < 200; i++) {
      v.render(loud, out, i * 8)
      for (let j = 0; j < out.length; j++) {
        const value = out[j] as number
        assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${kind} produced ${value}`)
      }
    }
  })

  test(`${kind}: brightness is a ceiling`, () => {
    const v = build({ brightness: 0.3, gain: 4 })
    const out = frame()
    const loud = spectrum(0, BINS, 1)
    for (let i = 0; i < 120; i++) v.render(loud, out, i * 8)
    assert.ok(maxOf(out) <= 0.3 + 1e-6, `${kind} reached ${maxOf(out)}`)
  })

  test(`${kind}: it responds to sound`, () => {
    const v = build()
    const out = frame()
    const loud = spectrum(0, BINS, 1)
    for (let i = 0; i < 30; i++) v.render(loud, out, i * 8)
    assert.ok(maxOf(out) > 0.05, `${kind} stayed dark with a full-scale input`)
  })
}

// ---------------------------------------------------------------------------
// What each one is supposed to do.
// ---------------------------------------------------------------------------

test('the spectrum puts low frequencies at one end and high at the other', () => {
  const v = createVisualiser({ spec: { kind: 'spectrum' }, geometry: GEOMETRY, sampleRate: RATE, binCount: BINS })
  const out = frame()
  // Energy only in the lowest bins: a kick drum and nothing else.
  const bass = spectrum(0, 6, 1)
  for (let i = 0; i < 20; i++) v.render(bass, out, i * 8)

  const litIn = (from: number, to: number): number => {
    let sum = 0
    for (let i = from; i < to; i++) {
      sum += (out[i * 3] as number) + (out[i * 3 + 1] as number) + (out[i * 3 + 2] as number)
    }
    return sum
  }
  const third = Math.floor(GEOMETRY.count / 3)
  assert.ok(litIn(0, third) > litIn(third * 2, GEOMETRY.count) * 5,
    'bass should light the start of the strip, not the end')
})

test('the spectrum bars fall back rather than latching on', () => {
  const v = createVisualiser({
    spec: { kind: 'spectrum', decay: 0.3 }, geometry: GEOMETRY, sampleRate: RATE, binCount: BINS
  })
  const out = frame()
  const loud = spectrum(0, BINS, 1)
  for (let i = 0; i < 20; i++) v.render(loud, out, i * 8)
  const peak = maxOf(out)
  const quiet = new Float32Array(BINS)
  for (let i = 0; i < 10; i++) v.render(quiet, out, (20 + i) * 8)
  assert.ok(maxOf(out) < peak, 'the bars stayed where the music left them')
})

test('pulse listens to the bass and ignores the cymbals', () => {
  // Including the whole spectrum would turn every hi-hat into a flash, which is
  // the single most common way this effect is got wrong.
  const bassOnly = createVisualiser({ spec: { kind: 'pulse' }, geometry: GEOMETRY, sampleRate: RATE, binCount: BINS })
  const trebleOnly = createVisualiser({ spec: { kind: 'pulse' }, geometry: GEOMETRY, sampleRate: RATE, binCount: BINS })
  const out = frame()

  const bass = spectrum(0, 6, 1)
  for (let i = 0; i < 30; i++) bassOnly.render(bass, out, i * 8)
  const withBass = maxOf(out)

  const treble = spectrum(300, BINS, 1)
  for (let i = 0; i < 30; i++) trebleOnly.render(treble, out, i * 8)
  const withTreble = maxOf(out)

  assert.ok(withBass > 0.05, `bass gave ${withBass}`)
  assert.ok(withTreble < withBass / 2, `treble gave ${withTreble} against bass ${withBass}`)
})

test('the level visualiser lights the whole rig at once, in the chosen colour', () => {
  const v = createVisualiser({
    spec: { kind: 'level', color: { r: 255, g: 0, b: 0 } },
    geometry: GEOMETRY, sampleRate: RATE, binCount: BINS
  })
  const out = frame()
  const loud = spectrum(0, BINS, 1)
  for (let i = 0; i < 30; i++) v.render(loud, out, i * 8)
  for (let i = 0; i < GEOMETRY.count; i++) {
    assert.ok((out[i * 3] as number) > 0, `LED ${i} is dark`)
    assert.equal(out[i * 3 + 1], 0, 'a red level should have no green')
    assert.equal(out[i * 3 + 2], 0, 'and no blue')
  }
})

test('the gain adapts, so quiet material still lights the strip', () => {
  // The whole point of the follower: a track mastered at -20 dB and one at -6
  // should both fill the strip, because the user did not choose the master.
  const quiet = createVisualiser({ spec: { kind: 'level' }, geometry: GEOMETRY, sampleRate: RATE, binCount: BINS })
  const loud = createVisualiser({ spec: { kind: 'level' }, geometry: GEOMETRY, sampleRate: RATE, binCount: BINS })
  const out = frame()

  for (let i = 0; i < 200; i++) quiet.render(spectrum(0, BINS, 0.08), out, i * 8)
  const quietPeak = maxOf(out)
  for (let i = 0; i < 200; i++) loud.render(spectrum(0, BINS, 0.9), out, i * 8)
  const loudPeak = maxOf(out)

  assert.ok(quietPeak > 0.3, `quiet material only reached ${quietPeak}`)
  assert.ok(Math.abs(quietPeak - loudPeak) < 0.25, `${quietPeak} against ${loudPeak} - the follower is not adapting`)
})

// ---------------------------------------------------------------------------
// The wire.
// ---------------------------------------------------------------------------

test('the meter reports the OVERALL level, not each visualiser’s own response', () => {
  // The meter answers "is the engine hearing anything at all", and a strip is
  // across the room so that has to be answerable without looking at it. Pulse
  // listens only to the bass, so reporting its response would read a flat zero
  // on music with no bass and send the user to check a working input.
  const pulse = createVisualiser({ spec: { kind: 'pulse' }, geometry: GEOMETRY, sampleRate: RATE, binCount: BINS })
  const out = frame()
  // A 440 Hz-ish tone: well above the lowest quarter of the bands, so pulse
  // itself should stay dark - and the meter should not.
  const treble = spectrum(300, 340, 1)
  for (let i = 0; i < 60; i++) pulse.render(treble, out, i * 8)
  assert.ok(maxOf(out) < 0.05, 'pulse should ignore this, and does')
  assert.ok(pulse.level() > 0.5, `but the meter read ${pulse.level()}`)
})

test('a spec off the wire is validated and clamped', () => {
  assert.deepEqual(parseAudioSpec({ kind: 'level' }), { kind: 'level' })
  assert.equal(parseAudioSpec({ kind: 'pulse', gain: 99 }).gain, GAIN_MAX)
  assert.equal(parseAudioSpec({ kind: 'pulse', gain: 0 }).gain, GAIN_MIN)
  assert.equal(parseAudioSpec({ kind: 'spectrum', decay: 5 }).decay, 1)
  assert.throws(() => parseAudioSpec({ kind: 'vu-meter' }), /kind must be one of/)
  assert.throws(() => parseAudioSpec({ kind: 'level', color: { r: -1, g: 0, b: 0 } }), /0\.\.255/)
  assert.throws(() => parseAudioSpec('level'), /must be an object/)
  for (const kind of AUDIO_KINDS) assert.ok(isAudioKind(kind))
  assert.equal(isAudioKind('Level'), false)
})
