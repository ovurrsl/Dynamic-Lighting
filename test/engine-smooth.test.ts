import assert from 'node:assert/strict'
import test from 'node:test'

import { REFERENCE_LAYOUT, ledCount } from '#lib/engine/layout'
import {
  SMOOTHING_DEFAULTS,
  createSmoother,
  decayWeight,
  halfLifeMs,
  type Smoother,
  type SmootherOptions
} from '#lib/engine/smooth'
import { allocLedColors, fillLedColors, type LedColors } from '#lib/engine/types'

const COUNT = ledCount(REFERENCE_LAYOUT)
const PERIOD = 1000 / 120
const MODES = ['linear', 'decay', 'asymmetric'] as const

const solid = (r: number, g: number, b: number, count = COUNT): LedColors =>
  fillLedColors(allocLedColors(count), r, g, b)
const BLACK = solid(0, 0, 0)
const RED = solid(1, 0, 0)
const GREEN = solid(0, 1, 0)
const BLUE = solid(0, 0, 1)
const WHITE = solid(1, 1, 1)

const near = (actual: number, expected: number, tolerance: number, message?: string): void =>
  assert.ok(Math.abs(actual - expected) <= tolerance, message ?? `expected ${actual} within ${tolerance} of ${expected}`)

const frameNear = (actual: LedColors, expected: LedColors, tolerance: number, message?: string): void => {
  assert.equal(actual.length, expected.length)
  for (let i = 0; i < actual.length; i++) near(actual[i]!, expected[i]!, tolerance, `${message ?? 'frame'}: channel ${i}`)
}

/** Ticks from `from` to `to` inclusive every `step` ms and returns copies of what came out. */
function run (s: Smoother, from: number, to: number, step: number): Array<{ time: number, frame: LedColors }> {
  const out: Array<{ time: number, frame: LedColors }> = []
  for (let i = 0; from + i * step <= to + 1e-9; i++) {
    const time = from + i * step
    const frame = s.tick(time)
    if (frame) out.push({ time, frame: frame.slice() })
  }
  return out
}

const fixedClock = (t = 0) => ({ now: () => t, set: (v: number) => { t = v } })

function make (mode: (typeof MODES)[number], extra: Partial<SmootherOptions> = {}, count = COUNT): Smoother {
  return createSmoother({ mode, count, ...extra } as SmootherOptions, fixedClock().now)
}

// ---------------------------------------------------------------------------
// Shared behaviour: the two design rules and the one rate limiter.
// ---------------------------------------------------------------------------

test('setTarget alone changes nothing observable, in every mode', () => {
  for (const mode of MODES) {
    const s = make(mode)
    assert.deepEqual(s.tick(0), BLACK, `${mode}: first frame is black`)

    // Hyperion's write() snaps its output to the very first input
    // (LinearColorSmoothing.cpp:221-226) so a read after write already shows
    // it. Here the input is only stored until a tick moves towards it.
    s.setTarget(RED, 1)
    s.setTarget(GREEN, 2)
    // Grey below the asymmetric cut threshold, so the bypass cannot hide a
    // setTarget that snapped the state.
    const grey = solid(0.2, 0.2, 0.2)
    s.setTarget(grey, 3)
    assert.deepEqual(s.current(), BLACK, `${mode}: current() after setTarget`)
    assert.equal(s.tick(3), null, `${mode}: no slot open yet`)
    assert.deepEqual(s.current(), BLACK, `${mode}: current() after a non-emitting tick`)
    // The next emitted frame is on its way to grey - not any of the targets,
    // which is what a setTarget that wrote `state` would have produced.
    const frame = s.tick(PERIOD)!
    assert.notDeepEqual(frame, RED, `${mode}: red was never shown`)
    assert.notDeepEqual(frame, GREEN, `${mode}: green was never shown`)
    assert.notDeepEqual(frame, grey, `${mode}: grey is reached over time, not at once`)
    assert.ok(frame[0]! > 0 && frame[0]! < 0.2, `${mode}: first frame ${frame[0]} is mid-transition`)
  }
})

test('a transition completes on the smoother\'s own clock with no further input', () => {
  // Half-intensity red keeps the mean change under the asymmetric cut
  // threshold, so all three modes genuinely have to travel.
  const target = solid(0.5, 0, 0)
  for (const mode of MODES) {
    const s = make(mode)
    s.setTarget(target, 0)
    const frames = run(s, 0, 600, PERIOD)
    assert.ok(frames.length > 60, `${mode}: keeps emitting without input`)
    const last = frames[frames.length - 1]!.frame
    // The IIR ends inside its 1 % perceptual deadband; the ports end exactly.
    const tolerance = mode === 'asymmetric' ? 0.5 * SMOOTHING_DEFAULTS.relFloor : 1e-6
    frameNear(last, target, tolerance, mode)
    // And it got there by moving, not by being told twice.
    assert.notDeepEqual(frames[1]!.frame, target, `${mode}: first frames are still in flight`)
  }
})

test('emits exactly one frame per output period at 120 Hz however finely tick is called', () => {
  for (const mode of MODES) {
    for (const step of [1, 0.7, PERIOD / 2]) {
      const s = make(mode)
      s.setTarget(RED, 0)
      const frames = run(s, 0, 1000 - 1e-6, step)
      // 120 slots in a second, one frame in each.
      assert.equal(frames.length, 120, `${mode}: ${frames.length} frames in 1 s at step ${step}`)
      for (let k = 0; k < 120; k++) {
        const inSlot = frames.filter((f) => f.time >= k * PERIOD - 1e-9 && f.time < (k + 1) * PERIOD - 1e-9)
        assert.equal(inSlot.length, 1, `${mode}: slot ${k} at step ${step} holds ${inSlot.length} frames`)
      }
    }
  }
})

test('a tick at the same instant never emits twice', () => {
  const s = make('linear')
  assert.ok(s.tick(0))
  assert.equal(s.tick(0), null)
  assert.equal(s.tick(PERIOD - 0.01), null)
  assert.ok(s.tick(PERIOD))
})

test('after a stall the output resumes on the period instead of bursting to catch up', () => {
  const s = make('linear')
  s.setTarget(RED, 0)
  assert.ok(s.tick(0))
  // 12 slots missed. Hyperion's grabber gate would have dropped the frames
  // and its timer would fire once; either way no burst - and neither here.
  assert.ok(s.tick(100))
  assert.equal(s.tick(101), null)
  assert.equal(s.tick(100 + PERIOD - 0.1), null)
  assert.ok(s.tick(100 + PERIOD))
})

test('current() is the last emitted frame and holds still between emissions', () => {
  // Interpolating faster than the output moves the internal average between
  // frames; what was emitted must not move with it.
  const s = make('decay', { outputHz: 30, interpolationHz: 120 })
  s.setTarget(RED, 0)
  const first = s.tick(0)!.slice()
  for (let t = PERIOD; t < 1000 / 30; t += PERIOD) {
    assert.equal(s.tick(t), null)
    assert.deepEqual(s.current(), first)
  }
  const second = s.tick(1000 / 30)!
  assert.notDeepEqual(second, first)
  assert.equal(s.current(), second)
})

test('the input is copied, so the caller may reuse its buffer', () => {
  for (const mode of MODES) {
    const s = make(mode)
    const buffer = RED.slice()
    s.setTarget(buffer, 0)
    buffer.set(GREEN)
    const frames = run(s, 0, 400, PERIOD)
    const last = frames[frames.length - 1]!.frame
    assert.equal(last[1], 0, `${mode}: green must not leak in from the mutated buffer`)
    assert.ok(last[0]! > 0.9, `${mode}: red is what was set`)
  }
})

test('a frame of a different size resets the smoother to that size, from black', () => {
  const s = make('linear')
  s.setTarget(RED, 0)
  run(s, 0, 200, PERIOD)
  assert.deepEqual(s.current(), RED)

  const half = solid(0, 1, 0, COUNT / 2)
  s.setTarget(half, 300)
  assert.equal(s.count, COUNT / 2)
  const frame = s.tick(300)!
  assert.equal(frame.length, half.length)
  // Starts over from black rather than carrying the old red into the new
  // layout: no red, and green still in flight. The reset also forgets the
  // last emission, so this first step integrates from the target's arrival
  // (k = 0) and only the minStep floor moves.
  assert.equal(frame[0], 0)
  near(frame[1]!, SMOOTHING_DEFAULTS.minStep, 1e-9)
  assert.throws(() => s.setTarget(new Float32Array(7), 301), RangeError)

  s.reset()
  assert.equal(s.count, COUNT / 2)
  assert.deepEqual(s.current(), allocLedColors(COUNT / 2))
})

test('uses the injected clock when no time is passed', () => {
  const clock = fixedClock(0)
  const s = createSmoother({ mode: 'linear', count: COUNT }, clock.now)
  s.setTarget(RED)
  const first = s.tick()!
  assert.ok(first[0]! > 0 && first[0]! < 0.01)
  clock.set(SMOOTHING_DEFAULTS.settlingMs)
  assert.deepEqual(s.tick(), RED)
})

test('rejects options that cannot run', () => {
  const clock = fixedClock().now
  assert.throws(() => createSmoother({ mode: 'linear', count: 0 }, clock), RangeError)
  assert.throws(() => createSmoother({ mode: 'linear', count: 1.5 }, clock), RangeError)
  assert.throws(() => createSmoother({ mode: 'linear', count: 1, outputHz: 0 }, clock), RangeError)
  assert.throws(() => createSmoother({ mode: 'linear', count: 1, minStep: 0 }, clock), RangeError)
  assert.throws(() => createSmoother({ mode: 'decay', count: 1, settlingMs: 0 }, clock), RangeError)
  assert.throws(() => createSmoother({ mode: 'decay', count: 1, decay: 0 }, clock), RangeError)
  assert.throws(() => createSmoother({ mode: 'asymmetric', count: 1, attackMs: 0 }, clock), RangeError)
  assert.throws(() => createSmoother({ mode: 'asymmetric', count: 1, relFloor: -1 }, clock), RangeError)
  assert.throws(() => createSmoother({ mode: 'sigmoid' } as unknown as SmootherOptions, clock), RangeError)
})

// ---------------------------------------------------------------------------
// Linear: port of performLinear (LinearColorSmoothing.cpp:488-520).
// ---------------------------------------------------------------------------

test('linear: a step converges to the target monotonically and never overshoots', () => {
  const s = make('linear')
  s.setTarget(RED, 0)
  let previous = 0
  for (const { time, frame } of run(s, 0, 300, PERIOD)) {
    for (let i = 0; i < frame.length; i += 3) {
      const r = frame[i]!
      assert.ok(r >= previous && r <= 1, `t=${time}: red ${r} left [${previous}, 1]`)
      assert.equal(frame[i + 1], 0)
      assert.equal(frame[i + 2], 0)
    }
    if (time < SMOOTHING_DEFAULTS.settlingMs) assert.ok(frame[0]! > previous, `t=${time}: must still be moving`)
    previous = frame[0]!
  }
  assert.equal(previous, 1)
})

test('linear: every tick moves at least minStep, so a transition cannot stall short of the target', () => {
  // With the target just set, k = 1 - settling/settling = 0 and a pure
  // k * diff step would be zero forever. Hyperion's ceil() to one LSB
  // (cpp:514-516) is what makes it move; minStep is the float analogue.
  const s = make('linear')
  s.setTarget(solid(0.5, 0, 0), 0)
  const frame = s.tick(0)!
  near(frame[0]!, SMOOTHING_DEFAULTS.minStep, 1e-9)

  // Same guarantee when k * diff is merely small: still at least one step.
  const tiny = make('linear', { minStep: 1e-3 })
  tiny.setTarget(solid(0.5, 0, 0), 0)
  tiny.tick(0)
  const second = tiny.tick(PERIOD)!
  // k at the second tick is PERIOD / settling ~ 0.056, times the 0.499 left
  // is ~0.028 > minStep, so this one is a k-step; the first was the floor.
  assert.ok(second[0]! - 1e-3 > 0.02)
  assert.ok(second[0]! < 0.5)
})

test('linear: a remaining distance below minStep is finished exactly, not overshot', () => {
  // Integer ceil(k * |diff|) can never exceed an integer |diff|, so Hyperion
  // needs no cap. A float floor can, and must be capped, or the output would
  // oscillate around the target by minStep forever.
  const s = make('linear')
  s.setTarget(solid(0.5, 0, 0), 0)
  run(s, 0, 200, PERIOD)
  assert.equal(s.current()[0], 0.5)

  const nudge = solid(0.5 + 3e-6, 0, 0)
  assert.ok(3e-6 < SMOOTHING_DEFAULTS.minStep)
  s.setTarget(nudge, 200)
  const frame = s.tick(200 + PERIOD)!
  assert.equal(frame[0], nudge[0])
  assert.equal(s.tick(200 + 2 * PERIOD)![0], nudge[0])
})

test('linear: snaps to the target once the settling time has elapsed', () => {
  // 1 kHz output so that 149 and 150 are both slots.
  const s = make('linear', { settlingMs: 150, outputHz: 1000 })
  s.setTarget(RED, 0)
  s.tick(0)
  assert.ok(s.tick(100)![0]! < 1)
  assert.ok(s.tick(149)![0]! < 1, 'one millisecond early is still in flight')
  // cpp:526-530: past the target time the target is written directly.
  assert.deepEqual(s.tick(150), RED)
  assert.deepEqual(s.tick(1000), RED)
})

test('linear: a target changed mid-flight re-aims from where the output is', () => {
  const s = make('linear')
  s.setTarget(RED, 0)
  run(s, 0, 75, PERIOD)
  const atSwitch = s.current().slice()
  assert.ok(atSwitch[0]! > 0.3 && atSwitch[0]! < 0.7)

  s.setTarget(GREEN, 75)
  let lastR = atSwitch[0]!
  let lastG = 0
  for (const { time, frame } of run(s, 75 + PERIOD, 300, PERIOD)) {
    assert.ok(frame[0]! <= lastR && frame[1]! >= lastG, `t=${time}: both channels head for green`)
    lastR = frame[0]!
    lastG = frame[1]!
  }
  assert.deepEqual(s.current(), GREEN)
})

// ---------------------------------------------------------------------------
// Decay: port of rememberFrame / interpolateFrame / performDecay
// (LinearColorSmoothing.cpp:543-566, 375-425, 427-449).
// ---------------------------------------------------------------------------

test('decay: weights over a full window sum to 1 for decay=1 and to decay+1 before normalisation', () => {
  const cuts = [0, 0.05, 0.2, 0.21, 0.5, 0.77, 0.9, 1]
  const total = (decay: number): number => {
    let sum = 0
    for (let i = 1; i < cuts.length; i++) sum += decayWeight(decay, cuts[i - 1]!, cuts[i]!)
    return sum
  }
  near(total(1), 1, 1e-12)
  near(total(2), 3, 1e-12)
  near(total(8), 9, 1e-12)
  // Above 1 the newest slice outweighs the oldest of the same length.
  assert.ok(decayWeight(2, 0.9, 1) > decayWeight(2, 0, 0.1))
  near(decayWeight(1, 0.9, 1), decayWeight(1, 0, 0.1), 1e-12)
})

test('decay: a constant input over a full window is reproduced exactly for any decay', () => {
  // With decay=2 the raw weight sum is 3; only the division by fs
  // (cpp:415-419) brings the colour back to itself.
  const colour = solid(0.3, 0.6, 0.9)
  for (const decay of [1, 2, 8]) {
    const s = make('decay', { decay })
    for (let t = 0; t <= 300; t += PERIOD) {
      s.setTarget(colour, t)
      s.tick(t)
    }
    frameNear(s.current(), colour, 1e-6, `decay=${decay}`)
  }
})

test('decay: halfLifeMs follows (1 - 2^(-1/decay)) * settling and the output really is half-way then', () => {
  near(halfLifeMs(1, 150), 75, 1e-12)
  near(halfLifeMs(2, 150), (1 - Math.SQRT1_2) * 150, 1e-12)
  near(halfLifeMs(8, 150), 12.45, 0.01)
  near(halfLifeMs(2, 200), 58.58, 0.01)

  for (const decay of [1, 2, 8]) {
    const s = make('decay', { decay, settlingMs: 150 })
    // A black frame long before, still straddling the window, then a step.
    s.setTarget(BLACK, -1000)
    s.setTarget(WHITE, 0)
    const frame = s.tick(halfLifeMs(decay, 150))!
    near(frame[0]!, 0.5, 1e-6, `decay=${decay}`)
  }
})

test('decay: the frame straddling the window start is kept so the oldest slice has a colour', () => {
  // rememberFrame (cpp:543-566) starts its prune count at p = -1: of the
  // frames older than the window, the newest survives because it was still
  // on screen when the window opened. Pruned naively, the slice between the
  // window start and the next frame would count as nothing at all.
  const s = make('decay', { settlingMs: 150 })
  s.setTarget(RED, 0)
  s.setTarget(GREEN, 20)
  s.setTarget(BLUE, 100)
  s.setTarget(WHITE, 200) // window now starts at 50: red and green are both older
  const frame = s.tick(200)!
  // Green covers 50..100 (a third), blue 100..200 (two thirds), white nothing yet.
  near(frame[0]!, 0, 1e-6, 'red ended before the window')
  near(frame[1]!, 1 / 3, 1e-6, 'green was still showing when the window opened')
  near(frame[2]!, 2 / 3, 1e-6)
})

test('decay: a partial window fades in from black by default and shows full value when normalised', () => {
  // cpp:415-416: inv_fs = fs < 1 ? 1 : 1 / fs. Hyperion leaves a not-yet-full
  // window un-normalised, so the first frames come up from black.
  const hyperion = make('decay', { settlingMs: 150 })
  hyperion.setTarget(RED, 0)
  near(hyperion.tick(75)![0]!, 0.5, 1e-6, 'half the window covered: half brightness')
  near(hyperion.tick(150)![0]!, 1, 1e-6, 'full window: full brightness')

  const ours = make('decay', { settlingMs: 150, normalizePartialWindow: true })
  ours.setTarget(RED, 0)
  near(ours.tick(75)![0]!, 1, 1e-6, 'normalised: the only frame is the answer')
  near(ours.tick(150)![0]!, 1, 1e-6)
})

test('decay: the average is recomputed at interpolationHz while frames go out at outputHz', () => {
  const s = make('decay', { outputHz: 120, interpolationHz: 25, settlingMs: 150 })
  s.setTarget(BLACK, -1000)
  s.setTarget(WHITE, 0)
  const frames = run(s, 0, 200, PERIOD)
  assert.equal(frames.length, 25)
  // 40 ms of output frames share one average, then it moves.
  for (let i = 1; i < 5; i++) assert.deepEqual(frames[i]!.frame, frames[0]!.frame, `frame ${i} is a repeat`)
  assert.notDeepEqual(frames[5]!.frame, frames[0]!.frame)
  for (let i = 6; i < 10; i++) assert.deepEqual(frames[i]!.frame, frames[5]!.frame, `frame ${i} is a repeat`)
})

test('decay: by default the average moves on every output frame, not once a second', () => {
  // Hyperion's schema defaults interpolationRate to 1.0 (plan section 11,
  // defect 7): a freshly saved config stair-steps once a second. Our default
  // is the output rate, so every frame during a transition is different.
  const s = make('decay')
  s.setTarget(BLACK, -1000)
  s.setTarget(WHITE, 0)
  const frames = run(s, 0, 140, PERIOD)
  for (let i = 1; i < frames.length; i++) {
    assert.ok(frames[i]!.frame[0]! > frames[i - 1]!.frame[0]!, `frame ${i} did not advance`)
  }
})

// ---------------------------------------------------------------------------
// Asymmetric: ours.
// ---------------------------------------------------------------------------

/** One LED stepping alone keeps the frame-wide mean change far below the cut threshold. */
const oneLed = (v: number): LedColors => {
  const f = allocLedColors(COUNT)
  f[0] = v
  f[1] = v
  f[2] = v
  return f
}

test('asymmetric: a rising step reaches 63 % at attackMs and a falling step at releaseMs', () => {
  const { attackMs, releaseMs } = SMOOTHING_DEFAULTS
  const s = make('asymmetric', { outputHz: 1000 })
  s.setTarget(oneLed(1), 0)
  run(s, 0, attackMs, 1)
  near(s.current()[0]!, 1 - Math.exp(-1), 1e-3, 'attack')
  near(s.current()[0]!, 0.632, 1e-3)

  run(s, attackMs + 1, 400, 1)
  const settled = s.current()[0]!
  assert.ok(settled > 0.98)

  s.setTarget(oneLed(0), 400)
  run(s, 401, 400 + releaseMs, 1)
  near(s.current()[0]! / settled, Math.exp(-1), 1e-3, 'release')
  // The tail is six times slower than the rise: at attackMs it has barely started.
  s.setTarget(oneLed(1), 1000)
  run(s, 1001, 2000, 1)
  const top = s.current()[0]!
  s.setTarget(oneLed(0), 2000)
  run(s, 2001, 2000 + attackMs, 1)
  assert.ok(s.current()[0]! / top > 0.8)
})

test('asymmetric: the step response does not depend on how often it is ticked', () => {
  // Exact discretisation: 1 - exp(-dt / tau) composes over any dt split, so
  // 60 Hz and 120 Hz output land on the same value at the same time.
  const at50 = [60, 120, 1000].map((outputHz) => {
    const s = make('asymmetric', { outputHz })
    s.setTarget(oneLed(1), 0)
    run(s, 0, 50, 1000 / outputHz)
    return s.current()[0]!
  })
  const expected = 1 - Math.exp(-50 / SMOOTHING_DEFAULTS.attackMs)
  for (const v of at50) near(v, expected, 1e-5)
})

test('asymmetric: the deadband holds sub-perceptual noise at the top but does not freeze the dark end', () => {
  const s = make('asymmetric')
  // Land exactly on a known state via the cut bypass: a bright frame with one
  // dark channel (LED 1 red).
  const base = solid(0.5, 0.5, 0.5)
  base[3] = 0.001
  s.setTarget(base, 0)
  assert.deepEqual(s.tick(0), base)
  const dark = base[3]!

  // +-0.003 on the bright channel is under the 1 % relative band; the same
  // +-0.0003 on the dark channel is well over its 4-LSB absolute floor.
  let t = 0
  for (let i = 1; i <= 40; i++) {
    const noisy = base.slice()
    const sign = i % 2 === 0 ? 1 : -1
    noisy[0] = 0.5 + sign * 0.003
    noisy[3] = dark + sign * 0.0003
    t = i * PERIOD
    s.setTarget(noisy, t)
    s.tick(t)
    assert.equal(s.current()[0], 0.5, `tick ${i}: the bright channel must hold`)
    assert.notEqual(s.current()[3], dark, `tick ${i}: the dark channel must follow`)
  }
  // A perceptible change at the top does go through.
  const real = base.slice()
  real[0] = 0.52
  s.setTarget(real, t + PERIOD)
  s.tick(t + PERIOD)
  assert.ok(s.current()[0]! > 0.5)
})

test('asymmetric: a scene cut snaps the whole frame in one tick; one LED jumping does not', () => {
  const cut = make('asymmetric')
  cut.setTarget(WHITE, 0)
  assert.deepEqual(cut.tick(0), WHITE, 'mean change 1.0 > threshold: snapped')

  const local = make('asymmetric')
  local.setTarget(oneLed(1), 0)
  local.tick(0)
  const frame = local.tick(PERIOD)!
  const partial = 1 - Math.exp(-PERIOD / SMOOTHING_DEFAULTS.attackMs)
  near(frame[0]!, partial, 1e-5, 'one LED of 108 is a local change: filtered')
  for (let i = 3; i < frame.length; i++) assert.equal(frame[i], 0)

  // Just under the threshold, frame-wide, is still a filtered change.
  const under = make('asymmetric')
  under.setTarget(solid(0.24, 0.24, 0.24), 0)
  under.tick(0)
  near(under.tick(PERIOD)![0]!, 0.24 * partial, 1e-5)
})

// ---------------------------------------------------------------------------
// Adversarial coverage added in review. Seven of these reproduced findings
// against the module as first written (a negative dt, a NaN sample, a double
// frame after a short stall, linear never landing under a streaming input, the
// deadband holding short of the target, a sub-ulp minStep, decay below 1);
// the fixes landed with them and every test here is regression coverage.
// ---------------------------------------------------------------------------

test('a single-LED strip runs every mode end to end', () => {
  const target = new Float32Array([0.1, 0.2, 0.3])
  for (const mode of MODES) {
    const s = make(mode, {}, 1)
    s.setTarget(target, 0)
    const frames = run(s, 0, 600, PERIOD)
    assert.ok(frames.length > 60, `${mode}: ${frames.length} frames`)
    const last = frames[frames.length - 1]!.frame
    assert.equal(last.length, 3)
    // The IIR stops inside its relative band of the brightest channel.
    const tolerance = mode === 'asymmetric' ? SMOOTHING_DEFAULTS.relFloor * 0.3 : 1e-6
    frameNear(last, target, tolerance, mode)
  }
})

test('a strip of fifty thousand LEDs is smoothed without an index slip', () => {
  const n = 50_000
  const target = solid(0.5, 0.25, 0.125, n)
  for (const mode of MODES) {
    const s = make(mode, {}, n)
    for (let t = 0; t <= 20 * PERIOD; t += PERIOD) {
      s.setTarget(target, t)
      s.tick(t)
    }
    const out = s.current()
    assert.equal(out.length, n * 3)
    for (let c = 0; c < 3; c++) {
      const first = out[c]!
      const last = out[(n - 1) * 3 + c]!
      assert.ok(Number.isFinite(first) && first > 0 && first <= target[c]!, `${mode}: channel ${c} = ${first}`)
      assert.equal(last, first, `${mode}: the last LED must see what the first does`)
    }
  }
})

test('a target that flips every tick keeps the output inside the hull of the targets, in every mode', () => {
  // 0.4 / 0.6 keeps the flip below the asymmetric cut threshold once the
  // first frame has snapped, so all three modes have to filter it.
  const lo = solid(0.4, 0.4, 0.4)
  const hi = solid(0.6, 0.6, 0.6)
  for (const mode of MODES) {
    const s = make(mode)
    let i = 0
    for (let t = 0; t <= 1000; t += PERIOD, i++) {
      s.setTarget(i % 2 === 0 ? lo : hi, t)
      const frame = s.tick(t)
      if (!frame) continue
      for (const v of frame) {
        assert.ok(v >= 0 && v <= hi[0]! + 1e-6, `${mode} t=${t}: ${v} left [0, 0.6]`)
        if (t > 800) assert.ok(v >= lo[0]! - 1e-6, `${mode} t=${t}: ${v} fell out of the hull`)
      }
    }
  }
})

test('an out-of-range target keeps every mode finite and on cadence', () => {
  // The smoother does not clamp: clamping is the encoder's job (clamp01 in
  // lib/light.ts) and a clamp here would hide an upstream bug. What it must
  // not do is blow up or lose the beat.
  for (const mode of MODES) {
    const s = make(mode)
    s.setTarget(solid(2, -1, 0.5), 0)
    const frames = run(s, 0, 1000 - 1e-6, PERIOD)
    assert.equal(frames.length, 120, mode)
    for (const { frame } of frames) for (const v of frame) assert.ok(Number.isFinite(v), `${mode}: ${v}`)
  }
})

test('a tick earlier than the last emission is ignored rather than rewinding the schedule', () => {
  const s = make('linear')
  s.setTarget(RED, 0)
  assert.ok(s.tick(100))
  assert.equal(s.tick(50), null)
  assert.equal(s.tick(100 + PERIOD - 0.01), null)
  assert.ok(s.tick(100 + PERIOD))
})

test('linear and decay treat a target stamped later than the tick as not shown yet', () => {
  const linear = make('linear')
  linear.setTarget(solid(0.5, 0, 0), 100)
  // k would be negative; clamped to 0 only the minStep floor moves.
  near(linear.tick(0)![0]!, SMOOTHING_DEFAULTS.minStep, 1e-9)

  const decay = make('decay')
  decay.setTarget(RED, 100)
  assert.deepEqual(decay.tick(0), BLACK)
})

test('asymmetric: a target stamped later than the tick must not fling the output out of range', () => {
  const s = make('asymmetric')
  s.setTarget(solid(0.1, 0.1, 0.1), 100)
  // dt = -100: attack = 1 - exp(100 / 15) = -785, and 0.1 * -785 = -78.5.
  const frame = s.tick(0)!
  for (let i = 0; i < frame.length; i++) {
    assert.ok(frame[i]! >= 0 && frame[i]! <= 0.1, `channel ${i} = ${frame[i]}`)
  }
})

test('decay: a frame arriving exactly at the window start owns the whole window', () => {
  const s = make('decay', { settlingMs: 150 })
  s.setTarget(RED, 0)
  s.setTarget(GREEN, 50)
  // windowStart = 50. Red's slice is [50, 50): nothing, and it must not be
  // picked as the straddling frame either, because green starts on the edge.
  const frame = s.tick(200)!
  near(frame[0]!, 0, 1e-6, 'red')
  near(frame[1]!, 1, 1e-6, 'green')
})

test('decay: targets that pile up at one instant are shown for no time and the last of them wins', () => {
  const s = make('decay', { settlingMs: 150 })
  s.setTarget(BLACK, -1000)
  for (let i = 0; i < 5000; i++) s.setTarget(i % 2 === 0 ? GREEN : RED, 0)
  // Half-way through the window the straddling black still owns half of it;
  // the 4999 frames that were replaced within the same instant weigh nothing.
  const half = s.tick(75)!
  near(half[0]!, 0.5, 1e-6, 'red')
  near(half[1]!, 0, 1e-6, 'green')
  frameNear(s.tick(150)!, RED, 1e-6)
})

test('linear and decay shake off a NaN sample once it has left the window', () => {
  const grey = solid(0.5, 0.5, 0.5)
  for (const mode of ['linear', 'decay'] as const) {
    const s = make(mode)
    s.setTarget(grey, 0)
    run(s, 0, 300, PERIOD)
    const bad = grey.slice()
    bad[0] = NaN
    s.setTarget(bad, 400)
    s.tick(400)
    s.setTarget(grey, 400 + PERIOD)
    run(s, 400 + PERIOD, 1400, PERIOD)
    // Linear recovers at the settling snap, decay once the frame is pruned.
    near(s.current()[0]!, 0.5, 1e-6, mode)
  }
})

test('asymmetric: one NaN sample must not trap the channel or disable the scene cut for good', () => {
  const grey = solid(0.5, 0.5, 0.5)
  const s = make('asymmetric')
  s.setTarget(grey, 0)
  run(s, 0, 300, PERIOD)
  const bad = grey.slice()
  bad[0] = NaN
  s.setTarget(bad, 400)
  s.tick(400)
  // Every later target is valid. Three seconds on, the channel is still NaN
  // (diff = x - NaN never enters the deadband, and y + NaN is NaN), and the
  // cut test's mean over all channels is NaN too, so it can never fire again.
  s.setTarget(grey, 400 + PERIOD)
  run(s, 400 + PERIOD, 3400, PERIOD)
  assert.ok(Number.isFinite(s.current()[0]!), `channel 0 is ${s.current()[0]}`)
  s.setTarget(WHITE, 3500)
  assert.deepEqual(s.tick(3500), WHITE, 'a full-frame cut must still snap')
})

test('two frames never go out closer together than half a period, stall or no stall', () => {
  // The slot schedule re-anchors only once a whole slot has been missed. A
  // stall that ends late in the next slot takes that slot and the following
  // one opens moments later: two frames a millisecond apart, which is the
  // burst the rate limiter is there to prevent (the spec's gate is
  // `now >= lastEmit + period`). GC pauses of 8-16 ms are routine.
  const s = make('linear')
  s.setTarget(RED, 0)
  assert.ok(s.tick(0))
  assert.ok(s.tick(16.5), 'slot 1, taken 8.2 ms late')
  assert.equal(s.tick(17.5), null, 'slot 2, one millisecond after the last frame')

  for (const gap of [PERIOD + 0.1, PERIOD * 1.5, PERIOD * 1.99]) {
    const t = make('linear')
    t.setTarget(RED, 0)
    let last = -Infinity
    for (const time of [0, gap, gap + 0.5, gap + 1]) {
      if (t.tick(time)) {
        assert.ok(time - last >= PERIOD / 2, `gap ${gap}: frames at ${last} and ${time}`)
        last = time
      }
    }
  }
})

test('linear: a static screen re-sent every frame still settles within twice settlingMs', () => {
  // Capture re-sends the same colour at 60 Hz - the normal case for a still
  // image - while the output runs at 120 Hz. Hyperion's write() (cpp:215)
  // re-arms the target time on every frame too; the question is whether the
  // port wants to inherit that, and either way it needs a test.
  const s = make('linear')
  const target = solid(0.5, 0, 0)
  let at150 = -1
  let settledAt = -1
  for (let i = 0; i * PERIOD <= 2000; i++) {
    const t = i * PERIOD
    if (i % 2 === 0) s.setTarget(target, t)
    const frame = s.tick(t)
    if (!frame) continue
    if (i === 18) at150 = frame[0]!
    if (settledAt < 0 && frame[0] === target[0]) settledAt = t
  }
  assert.ok(settledAt >= 0 && settledAt <= 2 * SMOOTHING_DEFAULTS.settlingMs,
    `at 150 ms the output was ${at150}; it reached the target at ${settledAt} ms`)
})

test('asymmetric: a target held still is eventually reproduced exactly', () => {
  const s = make('asymmetric')
  const target = solid(0.2, 0.2, 0.2)
  for (let t = 0; t <= 3000; t += PERIOD) {
    s.setTarget(target, t)
    s.tick(t)
  }
  // Stops at 0.19865: once x - y < 0.01 * y the output freezes 0.67 % short.
  frameNear(s.current(), target, 1e-6)
})

test('linear: a minStep below Float32 resolution still moves the output every tick', () => {
  const s = make('linear', { minStep: 1e-9, outputHz: 1000 }, 1)
  s.setTarget(new Float32Array([0.5, 0, 0]), 0)
  run(s, 0, 200, 1)
  assert.equal(s.current()[0], 0.5)
  // Two Float32 ulps of 0.5 away. k = 1 - 150 / 151 ~ 0.0066, so k * diff is
  // below minStep and the floor applies - but 0.5 + 1e-9 is 0.5 in Float32.
  const nudge = new Float32Array([0.5 + 2 * 2 ** -24, 0, 0])
  s.setTarget(nudge, 201)
  assert.notEqual(s.tick(201)![0], 0.5)
})

test('decay: a decay below 1 is rejected, since it would weight the oldest slice the most', () => {
  // With decay = 0.5 the oldest tenth of the window outweighs the newest.
  assert.ok(decayWeight(0.5, 0, 0.1) > decayWeight(0.5, 0.9, 1))
  assert.throws(() => make('decay', { decay: 0.5 }), RangeError)
})
