import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BORDER_DEFAULTS,
  BORDER_MODES,
  UNKNOWN_BORDER,
  bordersEqual,
  createBorderDetector,
  detectBorder,
  linearBlackThreshold,
  type BorderDetector,
  type BorderDetectorOptions,
  type BorderMode
} from '#lib/engine/border'
import { NO_BORDER, type Border, type LinearGrid } from '#lib/engine/types'
import { srgbToLinear } from '#lib/light'

// A 16:9 grid at the size the capture stage produces. The thirds, halves and
// quarters the probes use land on whole pixels: w/3 = 32, w/2 = 48, 2w/3 = 64,
// w/4 = 24, 3w/4 = 72; h/3 = 18, h/2 = 27.
const W = 96
const H = 54
const BRIGHT = 0.5

/** A grid filled with one linear colour. */
function grid (r = 0, g = 0, b = 0, width = W, height = H): LinearGrid {
  const data = new Float32Array(width * height * 3)
  for (let i = 0; i < data.length; i += 3) {
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
  }
  return { width, height, data }
}

/** Paints the rectangle [x0, x1) x [y0, y1) in a linear colour. */
function paint (g: LinearGrid, x0: number, y0: number, x1: number, y1: number, r: number, gg: number, b: number): LinearGrid {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * g.width + x) * 3
      g.data[i] = r
      g.data[i + 1] = gg
      g.data[i + 2] = b
    }
  }
  return g
}

// 2.39:1 in a 16:9 frame: 96 / 2.39 = 40 rows of picture, 7 rows of bar each end.
const LETTERBOX_BARS = 7
// 4:3 in a 16:9 frame: 54 * 4/3 = 72 columns of picture, 12 columns of bar each side.
const PILLARBOX_BARS = 12

const letterbox = (): LinearGrid => paint(grid(), 0, LETTERBOX_BARS, W, H - LETTERBOX_BARS, BRIGHT, BRIGHT, BRIGHT)
const pillarbox = (): LinearGrid => paint(grid(), PILLARBOX_BARS, 0, W - PILLARBOX_BARS, H, BRIGHT, BRIGHT, BRIGHT)
const windowbox = (): LinearGrid =>
  paint(grid(), PILLARBOX_BARS, LETTERBOX_BARS, W - PILLARBOX_BARS, H - LETTERBOX_BARS, BRIGHT, BRIGHT, BRIGHT)
const black = (): LinearGrid => grid()
const full = (): LinearGrid => grid(BRIGHT, BRIGHT, BRIGHT)

const LETTERBOX_RAW: Border = { unknown: false, topBottom: LETTERBOX_BARS, leftRight: 0 }
const PILLARBOX_RAW: Border = { unknown: false, topBottom: 0, leftRight: PILLARBOX_BARS }
// What process() reports: blur removal adds one pixel to each non-zero side.
const LETTERBOX: Border = { unknown: false, topBottom: LETTERBOX_BARS + 1, leftRight: 0 }
const PILLARBOX: Border = { unknown: false, topBottom: 0, leftRight: PILLARBOX_BARS + 1 }
const NONE: Border = { unknown: false, topBottom: 0, leftRight: 0 }

const Y_MODES: BorderMode[] = ['default', 'classic', 'osd', 'letterbox']
const X_MODES: BorderMode[] = ['default', 'classic', 'osd']

const { borderSwitchMs, unknownSwitchMs, maxInconsistentMs } = BORDER_DEFAULTS
/** Hyperion's frame period; the defaults are its frame counts at this rate. */
const STEP = 100

const fixedClock = (t = 0) => ({ now: () => t, set: (v: number) => { t = v } })

function make (options: BorderDetectorOptions = {}): BorderDetector {
  return createBorderDetector(options, fixedClock().now)
}

/** Feeds `g` every `step` ms from `from` to `to` inclusive; returns the last stable border. */
function feed (d: BorderDetector, g: LinearGrid, from: number, to: number, step = STEP): Readonly<Border> {
  let last: Readonly<Border> = d.current()
  for (let i = 0; from + i * step <= to + 1e-9; i++) last = d.process(g, from + i * step)
  return last
}

/** A detector already settled on the letterbox at t = 0. */
function settledOnLetterbox (options: BorderDetectorOptions = {}): BorderDetector {
  const d = make(options)
  assert.deepEqual(d.process(letterbox(), 0), LETTERBOX)
  return d
}

// ---------------------------------------------------------------------------
// Detection: the four probe patterns.
// ---------------------------------------------------------------------------

test('a 2.39:1 letterbox on a 16:9 grid is found by every mode, with no side inset', () => {
  for (const mode of Y_MODES) {
    assert.deepEqual(make({ mode }).detect(letterbox()), LETTERBOX_RAW, mode)
  }
})

test('a 4:3 pillarbox is found by the modes that look sideways; letterbox mode reports no border, not unknown', () => {
  for (const mode of X_MODES) {
    assert.deepEqual(make({ mode }).detect(pillarbox()), PILLARBOX_RAW, mode)
  }
  // Letterbox mode never insets the sides (.h:278), and the picture columns
  // it probes are lit right to the top, so the answer is a known zero.
  assert.deepEqual(make({ mode: 'letterbox' }).detect(pillarbox()), NONE)
})

test('a windowboxed picture yields both insets from the modes that look both ways', () => {
  for (const mode of X_MODES) {
    assert.deepEqual(make({ mode }).detect(windowbox()), { unknown: false, topBottom: LETTERBOX_BARS, leftRight: PILLARBOX_BARS }, mode)
  }
  assert.deepEqual(make({ mode: 'letterbox' }).detect(windowbox()), LETTERBOX_RAW)
})

test('an all-black frame is unknown with zero sizes, never -1', () => {
  // Hyperion reports {true, -1, -1} (.cpp:21-22) and relies on the consumer
  // mapping unknown to 0/0 before use; here the sizes are already harmless.
  for (const mode of Y_MODES) {
    assert.deepEqual(make({ mode }).detect(black()), { unknown: true, topBottom: 0, leftRight: 0 }, mode)
  }
  assert.deepEqual(UNKNOWN_BORDER, { unknown: true, topBottom: 0, leftRight: 0 })
})

test('a bar deeper than a third of the frame is unknown: the probes never look further', () => {
  // 20 rows of bar on a 54-row grid; the Y loops stop at h/3 = 18.
  const deep = paint(grid(), 0, 20, W, H - 20, BRIGHT, BRIGHT, BRIGHT)
  for (const mode of Y_MODES) {
    assert.equal(make({ mode }).detect(deep).unknown, true, mode)
  }
  // 40 columns of bar on a 96-column grid; the X loops stop at w/3 = 32.
  const wide = paint(grid(), 40, 0, W - 40, H, BRIGHT, BRIGHT, BRIGHT)
  for (const mode of X_MODES) {
    assert.equal(make({ mode }).detect(wide).unknown, true, mode)
  }
})

test('an unlit frame with no bars is a known zero border, not unknown', () => {
  for (const mode of Y_MODES) {
    assert.deepEqual(make({ mode }).detect(full()), NONE, mode)
  }
})

test('blur removal grows a non-zero border by exactly blurRemovePx and leaves zero alone', () => {
  assert.deepEqual(make().process(letterbox(), 0), { unknown: false, topBottom: LETTERBOX_BARS + 1, leftRight: 0 })
  assert.deepEqual(make().process(pillarbox(), 0), { unknown: false, topBottom: 0, leftRight: PILLARBOX_BARS + 1 })
  assert.deepEqual(make({ blurRemovePx: 0 }).process(letterbox(), 0), LETTERBOX_RAW)
  assert.deepEqual(make({ blurRemovePx: 3 }).process(windowbox(), 0), { unknown: false, topBottom: LETTERBOX_BARS + 3, leftRight: PILLARBOX_BARS + 3 })
  // detect() is the raw reading: blur removal belongs to the processor (.h:92-100).
  assert.deepEqual(make({ blurRemovePx: 3 }).detect(letterbox()), LETTERBOX_RAW)
})

test('a logo in one corner of the bar fools default but not osd', () => {
  // A channel bug in the top-left corner: inside the top bar, inset from the
  // edge as overlays are (nothing is drawn on the very edge column), and wide
  // enough to cross the w/3 column that default reads from the top.
  const g = paint(letterbox(), 4, 1, 36, 4, BRIGHT, BRIGHT, BRIGHT)
  assert.deepEqual(make({ mode: 'default' }).detect(g), { unknown: false, topBottom: 1, leftRight: 0 })
  // osd reads Y only at the picture's own corner columns, 0 and 95 here,
  // where the bar is intact.
  assert.deepEqual(make({ mode: 'osd' }).detect(g), LETTERBOX_RAW)
})

test('a caption at the bottom centre fools default but not letterbox mode, which reads the centre from the top only', () => {
  const captioned = paint(letterbox(), 30, H - 4, 66, H - 1, BRIGHT, BRIGHT, BRIGHT)
  // default walks up the middle column from the bottom and hits the caption.
  assert.deepEqual(make({ mode: 'default' }).detect(captioned), { unknown: false, topBottom: 1, leftRight: 0 })
  assert.deepEqual(make({ mode: 'letterbox' }).detect(captioned), LETTERBOX_RAW)

  // The asymmetry is deliberate (.h:247), so the same caption at the TOP
  // centre does fool letterbox mode: that is the price of the rule.
  const titled = paint(letterbox(), 30, 1, 66, 4, BRIGHT, BRIGHT, BRIGHT)
  assert.deepEqual(make({ mode: 'letterbox' }).detect(titled), { unknown: false, topBottom: 1, leftRight: 0 })
})

test('dark content in the top-left corner fools classic and no other mode (expected; ported as-is)', () => {
  // A full-frame picture with a 10x10 dark patch in the corner. Classic walks
  // the diagonal to (10, 10), slides left along row 10 to the edge and up
  // column 0 until row 9 is dark: a ten-row "bar" that does not exist.
  const g = paint(full(), 0, 0, 10, 10, 0, 0, 0)
  assert.deepEqual(make({ mode: 'classic' }).detect(g), { unknown: false, topBottom: 10, leftRight: 0 })
  for (const mode of ['default', 'osd', 'letterbox'] as const) {
    assert.deepEqual(make({ mode }).detect(g), NONE, mode)
  }
})

test('the pure detector and the instance agree, and the instance uses the configured mode', () => {
  const t = linearBlackThreshold(BORDER_DEFAULTS.threshold)
  for (const mode of BORDER_MODES) {
    const d = make({ mode })
    assert.equal(d.mode, mode)
    assert.equal(d.linearThreshold, t)
    assert.deepEqual(d.detect(windowbox()), detectBorder(windowbox(), mode, t), mode)
  }
})

// ---------------------------------------------------------------------------
// Threshold.
// ---------------------------------------------------------------------------

test('a pixel at exactly the sRGB threshold is not black; one just below is', () => {
  const at = srgbToLinear(0.05)
  const below = srgbToLinear(0.049)
  for (const mode of Y_MODES) {
    assert.deepEqual(make({ mode }).detect(grid(at, at, at)), NONE, `${mode}: at threshold`)
    assert.equal(make({ mode }).detect(grid(below, below, below)).unknown, true, `${mode}: below threshold`)
  }
  // The same boundary for a non-default threshold.
  const t = 0.2
  assert.deepEqual(make({ threshold: t }).detect(grid(srgbToLinear(t), 0, 0)), NONE)
  assert.equal(make({ threshold: t }).detect(grid(srgbToLinear(t - 0.001), 0, 0)).unknown, true)
})

test('black needs all three channels under the threshold: one lit channel is a picture', () => {
  const at = srgbToLinear(0.05)
  assert.deepEqual(make().detect(grid(at, 0, 0)), NONE)
  assert.deepEqual(make().detect(grid(0, at, 0)), NONE)
  assert.deepEqual(make().detect(grid(0, 0, at)), NONE)
  // Deep blue: dim as a luma, but unmistakably not a bar.
  assert.deepEqual(make().detect(grid(0, 0, srgbToLinear(0.3))), NONE)
})

test('the threshold is a fraction of sRGB, compared in linear light, on Hyperion\'s byte boundary', () => {
  // Hyperion rounds 5% up to byte 13 (BlackBorderDetector.cpp:18): byte 12 is
  // black, byte 13 is not. The linear compare lands on the same boundary.
  assert.equal(make().detect(grid(srgbToLinear(12 / 255), srgbToLinear(12 / 255), srgbToLinear(12 / 255))).unknown, true)
  assert.deepEqual(make().detect(grid(srgbToLinear(13 / 255), srgbToLinear(13 / 255), srgbToLinear(13 / 255))), NONE)
  // And 0.05 is NOT a linear value: a pixel at sRGB 0.2 is linear 0.033,
  // under 0.05 as a number, and still a picture.
  const dim = srgbToLinear(0.2)
  assert.ok(dim < 0.05)
  assert.deepEqual(make().detect(grid(dim, dim, dim)), NONE)
})

// ---------------------------------------------------------------------------
// Hysteresis.
// ---------------------------------------------------------------------------

test('the very first detection is accepted at once, whatever maxInconsistentMs is', () => {
  assert.deepEqual(make().process(letterbox(), 0), LETTERBOX)
  assert.deepEqual(make().process(pillarbox(), 12345), PILLARBOX)
  // Hyperion's fast start only works while the limit is at most its literal
  // starting counter of 10 frames (.cpp:17, :24); ours does not depend on it.
  assert.deepEqual(make({ maxInconsistentMs: 5000 }).process(letterbox(), 0), LETTERBOX)
  assert.deepEqual(make({ maxInconsistentMs: 5000 }).process(letterbox(), 3000), LETTERBOX)
})

test('one flicker frame with a different border is ignored and does not restart the consistency run', () => {
  const d = settledOnLetterbox()

  // A lone frame against a settled border: nothing moves.
  assert.deepEqual(d.process(pillarbox(), 5000), LETTERBOX)
  assert.deepEqual(d.process(letterbox(), 5100), LETTERBOX)
  assert.deepEqual(d.current(), LETTERBOX)

  // The content really changes at 10 s. The pillarbox becomes the candidate
  // once it has disagreed for longer than maxInconsistentMs, then needs
  // borderSwitchMs of agreement.
  const adopted = 10000 + maxInconsistentMs + STEP
  const due = adopted + borderSwitchMs
  assert.deepEqual(feed(d, pillarbox(), 10000, 13000), LETTERBOX)
  // One letterbox frame in the middle of the pillarbox run is discarded: it
  // neither becomes the candidate nor resets the pillarbox's run. Either
  // failure would push the switch past `due`.
  assert.deepEqual(d.process(letterbox(), 13000 + STEP), LETTERBOX)
  assert.deepEqual(feed(d, pillarbox(), 13000 + 2 * STEP, due - STEP), LETTERBOX)
  assert.deepEqual(d.process(pillarbox(), due), PILLARBOX)
})

test('a new border replaces a settled one only after borderSwitchMs of consistency past the inconsistency window', () => {
  const d = settledOnLetterbox()
  const adopted = 10000 + maxInconsistentMs + STEP
  const due = adopted + borderSwitchMs
  assert.deepEqual(feed(d, pillarbox(), 10000, due - STEP), LETTERBOX)
  assert.deepEqual(d.current(), LETTERBOX)
  assert.deepEqual(d.process(pillarbox(), due), PILLARBOX)
  assert.deepEqual(d.current(), PILLARBOX)
})

test('unknown replaces a settled border only after unknownSwitchMs', () => {
  const d = settledOnLetterbox()
  const adopted = 10000 + maxInconsistentMs + STEP
  const due = adopted + unknownSwitchMs
  // Well past the border switch delay and still on the letterbox: losing a
  // border is a far slower decision than gaining one (.cpp:194 vs :203).
  assert.deepEqual(feed(d, black(), 10000, adopted + borderSwitchMs), LETTERBOX)
  assert.deepEqual(feed(d, black(), adopted + borderSwitchMs + STEP, due - STEP), LETTERBOX)
  const gone = d.process(black(), due)
  assert.equal(gone.unknown, true)
  assert.deepEqual(gone, UNKNOWN_BORDER)
  assert.equal(d.current().unknown, true)
})

test('a border replaces an unknown state as soon as it outlives the inconsistency window, with no borderSwitch wait', () => {
  const d = make()
  assert.equal(d.process(black(), 0).unknown, true)
  assert.equal(feed(d, black(), STEP, 900).unknown, true)

  const adopted = 1000 + maxInconsistentMs + STEP
  assert.equal(feed(d, letterbox(), 1000, adopted - STEP).unknown, true)
  // .cpp:203: `_currentBorder.unknown ||` - nothing to protect, so no wait.
  assert.deepEqual(d.process(letterbox(), adopted), LETTERBOX)
})

test('hysteresis is measured in time: at 120 FPS the switch still takes borderSwitchMs, not fifty frames', () => {
  const d = settledOnLetterbox()
  const period = 1000 / 120
  // Hyperion's counters would flip after 10 discarded + 50 consistent frames,
  // half a second at this rate. Ours holds for the configured milliseconds.
  const hyperionFrames = 61
  assert.deepEqual(feed(d, pillarbox(), 10000, 10000 + hyperionFrames * period, period), LETTERBOX)
  assert.deepEqual(feed(d, pillarbox(), 10000 + (hyperionFrames + 1) * period, 15000, period), LETTERBOX)
  assert.deepEqual(feed(d, pillarbox(), 15000 + period, 17000, period), PILLARBOX)
})

test('the switch fires on the first frame past the deadline, not only on one landing exactly on it', () => {
  const d = settledOnLetterbox()
  // 333 ms steps from 10 s never hit an instant that is exactly
  // maxInconsistentMs or borderSwitchMs after any earlier frame. An `==`
  // deadline, as in .cpp:194 and :203, would never fire.
  assert.deepEqual(feed(d, pillarbox(), 10000, 15000, 333), LETTERBOX)
  assert.deepEqual(feed(d, pillarbox(), 10000 + 16 * 333, 18000, 333), PILLARBOX)
})

test('the returned border keeps its identity until it changes, and cannot be mutated', () => {
  const d = settledOnLetterbox()
  const first = d.process(letterbox(), STEP)
  assert.equal(d.process(letterbox(), 2 * STEP), first)
  assert.equal(d.current(), first)
  assert.ok(Object.isFrozen(first))

  const due = 10000 + maxInconsistentMs + STEP + borderSwitchMs
  assert.equal(feed(d, pillarbox(), 10000, due - STEP), first)
  const second = d.process(pillarbox(), due)
  assert.notEqual(second, first)
  assert.deepEqual(first, LETTERBOX, 'the old object is untouched')
  assert.deepEqual(second, PILLARBOX)
})

test('process reads the injected clock when no time is passed', () => {
  const clock = fixedClock(0)
  const d = createBorderDetector({}, clock.now)
  assert.deepEqual(d.process(letterbox()), LETTERBOX)

  const due = 10000 + maxInconsistentMs + STEP + borderSwitchMs
  for (let t = 10000; t < due; t += STEP) {
    clock.set(t)
    assert.deepEqual(d.process(pillarbox()), LETTERBOX, `at ${t}`)
  }
  clock.set(due)
  assert.deepEqual(d.process(pillarbox()), PILLARBOX)
})

test('reset forgets every border and accepts the next detection at once', () => {
  const d = settledOnLetterbox()
  d.reset()
  assert.equal(d.current().unknown, true)
  assert.deepEqual(d.process(pillarbox(), 50000), PILLARBOX)
})

// ---------------------------------------------------------------------------
// Enable and hard disable.
// ---------------------------------------------------------------------------

test('disabled returns NO_BORDER and freezes the state it had', () => {
  const d = settledOnLetterbox()

  d.setDisabled(true)
  assert.equal(d.active(), false)
  assert.equal(d.current(), NO_BORDER)
  // Ten seconds of pillarbox while disabled: reported as no border, and never
  // seen by the state machine.
  for (let t = STEP; t <= 10000; t += STEP) assert.equal(d.process(pillarbox(), t), NO_BORDER)

  d.setDisabled(false)
  assert.equal(d.active(), true)
  // Hyperion would report unknown here: its process() overwrote the current
  // border while disabled (.h:76-81). Ours is exactly where it was.
  assert.deepEqual(d.current(), LETTERBOX)

  // And the pillarbox has to earn the switch from scratch: had those ten
  // seconds counted, it would have won long ago.
  const due = 10100 + maxInconsistentMs + STEP + borderSwitchMs
  assert.deepEqual(feed(d, pillarbox(), 10100, due - STEP), LETTERBOX)
  assert.deepEqual(d.process(pillarbox(), due), PILLARBOX)
})

test('the user\'s enable is a switch of its own: off from the options, on again later', () => {
  const d = make({ enabled: false })
  assert.equal(d.active(), false)
  assert.equal(d.process(letterbox(), 0), NO_BORDER)
  assert.equal(d.current(), NO_BORDER)

  d.setEnabled(true)
  assert.equal(d.active(), true)
  // Nothing was seen while off, so this is the first detection: accepted at once.
  assert.deepEqual(d.process(letterbox(), 1000), LETTERBOX)

  d.setEnabled(false)
  assert.equal(d.process(letterbox(), 1100), NO_BORDER)
  assert.equal(d.current(), NO_BORDER)
})

test('a hard disable and the user\'s enable latch separately: neither undoes the other', () => {
  const d = settledOnLetterbox()

  // An effect takes the screen; the user toggling their switch on again does
  // not bring detection back while the effect runs (.cpp:100-105).
  d.setDisabled(true)
  d.setEnabled(true)
  assert.equal(d.active(), false)
  assert.equal(d.process(letterbox(), STEP), NO_BORDER)
  // The effect ends: the user's enable was remembered (.cpp:127-129).
  d.setDisabled(false)
  assert.equal(d.active(), true)
  assert.deepEqual(d.process(letterbox(), 2 * STEP), LETTERBOX)

  // The user switches off; an effect coming and going does not switch it on.
  d.setEnabled(false)
  d.setDisabled(true)
  d.setDisabled(false)
  assert.equal(d.active(), false)
  assert.equal(d.process(letterbox(), 3 * STEP), NO_BORDER)
  d.setEnabled(true)
  assert.equal(d.active(), true)
  assert.deepEqual(d.process(letterbox(), 4 * STEP), LETTERBOX)
})

// ---------------------------------------------------------------------------
// Equality and validation.
// ---------------------------------------------------------------------------

test('unknown borders are equal regardless of size; unknown never equals a known border', () => {
  assert.equal(bordersEqual({ unknown: true, topBottom: 5, leftRight: 9 }, UNKNOWN_BORDER), true)
  assert.equal(bordersEqual(UNKNOWN_BORDER, NO_BORDER), false)
  assert.equal(bordersEqual(NO_BORDER, UNKNOWN_BORDER), false)
  assert.equal(bordersEqual(LETTERBOX, { ...LETTERBOX }), true)
  assert.equal(bordersEqual(LETTERBOX, PILLARBOX), false)
  assert.equal(bordersEqual(LETTERBOX, { ...LETTERBOX, topBottom: LETTERBOX.topBottom + 1 }), false)
})

test('rejects options that cannot work', () => {
  const clock = fixedClock().now
  assert.throws(() => createBorderDetector({ mode: 'diagonal' as BorderMode }, clock), RangeError)
  assert.throws(() => createBorderDetector({ threshold: -0.1 }, clock), RangeError)
  assert.throws(() => createBorderDetector({ threshold: 1.5 }, clock), RangeError)
  assert.throws(() => createBorderDetector({ threshold: Number.NaN }, clock), RangeError)
  assert.throws(() => createBorderDetector({ blurRemovePx: -1 }, clock), RangeError)
  assert.throws(() => createBorderDetector({ blurRemovePx: 0.5 }, clock), RangeError)
  assert.throws(() => createBorderDetector({ borderSwitchMs: -1 }, clock), RangeError)
  assert.throws(() => createBorderDetector({ unknownSwitchMs: Number.POSITIVE_INFINITY }, clock), RangeError)
  assert.throws(() => createBorderDetector({ maxInconsistentMs: Number.NaN }, clock), RangeError)
  // Zero delays are legal: a detector with no hysteresis at all.
  const instant = createBorderDetector({ borderSwitchMs: 0, maxInconsistentMs: 0, unknownSwitchMs: 0 }, clock)
  assert.deepEqual(instant.process(letterbox(), 0), LETTERBOX)
  assert.deepEqual(instant.process(pillarbox(), 1), LETTERBOX, 'a zero window still needs one frame of disagreement')
  assert.deepEqual(instant.process(pillarbox(), 2), PILLARBOX)
})

test('rejects a grid whose data does not cover its dimensions', () => {
  const short: LinearGrid = { width: W, height: H, data: new Float32Array(W * H * 3 - 3) }
  assert.throws(() => make().detect(short), RangeError)
  assert.throws(() => make().detect({ width: 0, height: H, data: new Float32Array(0) }), RangeError)
  assert.throws(() => make().detect({ width: 4.5, height: H, data: new Float32Array(W * H * 3) }), RangeError)
  // Tiny grids are legal and simply cannot find anything: the thirds are empty.
  assert.equal(make().detect(grid(BRIGHT, BRIGHT, BRIGHT, 2, 2)).unknown, true)
  assert.deepEqual(make().detect(grid(BRIGHT, BRIGHT, BRIGHT, 3, 3)), NONE)
})

// ---------------------------------------------------------------------------
// Review: adversarial cases. Each pins either a boundary the module already
// held or one it should hold. Three were findings against the module as first
// written (a one-frame hole after a candidate switch, disabled time credited
// to a run, a NaN frame time poisoning the run); the fixes landed with them.
// ---------------------------------------------------------------------------

/** A detector settled on the letterbox at t = 0 whose candidate has just become the pillarbox. */
function candidateJustSwitchedToPillarbox (): { d: BorderDetector, switched: number } {
  const d = settledOnLetterbox()
  const switched = 10000 + maxInconsistentMs + STEP
  assert.deepEqual(feed(d, pillarbox(), 10000, switched), LETTERBOX)
  return { d, switched }
}

test('a flicker frame arriving right after a candidate switch is discarded like any other', () => {
  // The flicker protection has a hole exactly one frame wide: the instant the
  // pillarbox becomes the candidate, the inconsistency run that put it there
  // is still open, so a single letterbox frame on the very next tick is
  // "inconsistent for longer than the window" and flips the candidate back,
  // throwing away the run the pillarbox had just earned. Hyperion has the same
  // hole (.cpp:170-179 never clears _inconsistentCnt); the point of the state
  // machine (.cpp:151-159) is that ONE bad frame never costs a run.
  const { d, switched } = candidateJustSwitchedToPillarbox()
  assert.deepEqual(d.process(letterbox(), switched + STEP), LETTERBOX)
  const due = switched + borderSwitchMs
  assert.deepEqual(feed(d, pillarbox(), switched + 2 * STEP, due - STEP), LETTERBOX)
  assert.deepEqual(d.process(pillarbox(), due), PILLARBOX, 'the flicker cost the pillarbox its run')
})

test('time spent disabled does not count toward the candidate\'s consistency run', () => {
  // The run is stored as the instant it began, so a hard disable that lasts
  // longer than borderSwitchMs hands the candidate a full run it never earned:
  // the first frame after re-enable switches on 1.2 s of evidence.
  const { d, switched } = candidateJustSwitchedToPillarbox()
  assert.deepEqual(d.process(pillarbox(), switched + STEP), LETTERBOX)
  d.setDisabled(true)
  d.setDisabled(false)
  const resumed = switched + STEP + 2 * borderSwitchMs
  assert.deepEqual(d.process(pillarbox(), resumed), LETTERBOX, 'switched on the first frame after re-enable')
  // The run resumes where it left off: borderSwitchMs - STEP still owed.
  const due = resumed + borderSwitchMs - STEP
  assert.deepEqual(feed(d, pillarbox(), resumed + STEP, due - STEP), LETTERBOX)
  assert.deepEqual(d.process(pillarbox(), due), PILLARBOX)
})

test('a NaN timestamp is not believed and does not poison the run that follows', () => {
  // `now - NaN` fails every comparison: a NaN frame on a disagreeing border
  // skips the inconsistency window, and the candidate it installs carries a
  // NaN start, so no later frame can ever satisfy `consistentFor >= limit`.
  // The detector is then stuck on the old border for as long as the content
  // stays put. Rejecting the frame (throw) or ignoring it both pass here.
  const d = settledOnLetterbox()
  assert.deepEqual(feed(d, pillarbox(), 10000, 10500), LETTERBOX)
  try { d.process(pillarbox(), Number.NaN) } catch { /* a RangeError is an acceptable answer */ }
  assert.deepEqual(feed(d, pillarbox(), 10600, 30000), PILLARBOX, 'twenty seconds of pillarbox never adopted')
})

test('the inconsistency window closes strictly after maxInconsistentMs and the switch fires exactly at borderSwitchMs', () => {
  const d = settledOnLetterbox()
  // Disagreement at 10000 and again exactly maxInconsistentMs later: both
  // inside the window, both discarded.
  assert.deepEqual(d.process(pillarbox(), 10000), LETTERBOX)
  assert.deepEqual(d.process(pillarbox(), 10000 + maxInconsistentMs), LETTERBOX)
  // One millisecond past it the pillarbox becomes the candidate; its run
  // starts on that frame, and ends exactly borderSwitchMs later.
  const adopted = 10000 + maxInconsistentMs + 1
  assert.deepEqual(d.process(pillarbox(), adopted), LETTERBOX)
  assert.deepEqual(d.process(pillarbox(), adopted + borderSwitchMs - 1), LETTERBOX)
  assert.deepEqual(d.process(pillarbox(), adopted + borderSwitchMs), PILLARBOX)
})

test('frames alternating between two borders never let the outsider accumulate a run', () => {
  // The window is measured from the FIRST disagreeing frame and reset by any
  // agreeing one, so a 50% duty cycle of pillarbox frames at 100 ms is a
  // stream of one-frame flickers. The letterbox run is unbroken meanwhile.
  const d = settledOnLetterbox()
  for (let t = 10000; t <= 40000; t += 2 * STEP) {
    assert.deepEqual(d.process(pillarbox(), t), LETTERBOX, `pillarbox at ${t}`)
    assert.deepEqual(d.process(letterbox(), t + STEP), LETTERBOX, `letterbox at ${t + STEP}`)
  }
})

test('an out-of-order timestamp delays a switch but does not break it', () => {
  const { d, switched } = candidateJustSwitchedToPillarbox()
  // A frame stamped before the run began: negative age, not due, nothing else.
  assert.deepEqual(d.process(pillarbox(), switched - 500), LETTERBOX)
  const due = switched + borderSwitchMs
  assert.deepEqual(feed(d, pillarbox(), switched + STEP, due - STEP), LETTERBOX)
  assert.deepEqual(d.process(pillarbox(), due), PILLARBOX)
})

test('rapid enable and disable churn leaves the settled state untouched', () => {
  const d = settledOnLetterbox()
  for (let i = 0; i < 1000; i++) {
    d.setDisabled(i % 2 === 0)
    d.setEnabled(i % 3 !== 0)
    assert.equal(d.active(), i % 2 !== 0 && i % 3 !== 0, `at ${i}`)
    assert.equal(d.current(), d.active() ? d.process(letterbox(), STEP) : NO_BORDER)
  }
  d.setDisabled(false)
  d.setEnabled(true)
  assert.deepEqual(d.current(), LETTERBOX)
  assert.deepEqual(d.process(pillarbox(), 2 * STEP), LETTERBOX, 'one frame after the churn is still one frame')
})

/** Wraps a grid so any read past the end of its data throws instead of yielding undefined. */
function guarded (g: LinearGrid): { grid: LinearGrid, reads: () => number } {
  let reads = 0
  const data = new Proxy(g.data, {
    get (target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        reads++
        if (Number(prop) >= target.length) throw new RangeError(`read ${prop} of ${target.length}`)
      }
      return Reflect.get(target, prop)
    }
  })
  return { grid: { width: g.width, height: g.height, data }, reads: () => reads }
}

test('every probe stays inside the grid for every size up to 40x40 in every mode, lit or black', () => {
  // `undefined < t` is false, so a read past the end would silently count as
  // a non-black pixel and invent a border edge; the guard makes it throw.
  for (let w = 1; w <= 40; w++) {
    for (let h = 1; h <= 40; h++) {
      for (const mode of BORDER_MODES) {
        const d = make({ mode })
        for (const g of [grid(0, 0, 0, w, h), grid(BRIGHT, BRIGHT, BRIGHT, w, h)]) {
          const r = d.detect(guarded({ ...g, data: new Float32Array(g.data) }).grid)
          assert.ok(r.unknown || (r.topBottom >= 0 && r.leftRight >= 0), `${mode} ${w}x${h}`)
        }
        // A picture in the bottom-right quadrant only: the mirrored probes
        // (w-1-x, h-1-y) are the ones that reach it.
        const q = paint(grid(0, 0, 0, w, h), Math.floor(w / 2), Math.floor(h / 2), w, h, BRIGHT, BRIGHT, BRIGHT)
        d.detect(guarded(q).grid)
      }
    }
  }
})

test('detection on a 1080p grid reads a few lines, never the frame', () => {
  const w = 1920
  const h = 1080
  // 2.39:1 in 16:9 at 1080p: 803 rows of picture, 138 rows of bar each end.
  const bars = Math.floor((h - Math.round(w / 2.39)) / 2)
  const g = paint(grid(0, 0, 0, w, h), 0, bars, w, h - bars, BRIGHT, BRIGHT, BRIGHT)
  for (const mode of Y_MODES) {
    assert.deepEqual(make({ mode }).detect(g), { unknown: false, topBottom: bars, leftRight: 0 }, mode)
  }
  // Worst case is an all-black frame, where every loop runs to its limit: at
  // most four probes of three channels per index over w/3 + h/3 indices
  // (.h:75-76), against six million floats in the frame.
  const budget = 12 * (Math.floor(w / 3) + Math.floor(h / 3))
  for (const mode of BORDER_MODES) {
    const { grid: black1080, reads } = guarded(grid(0, 0, 0, w, h))
    assert.equal(make({ mode }).detect(black1080).unknown, true, mode)
    assert.ok(reads() <= budget, `${mode}: ${reads()} channel reads, budget ${budget}`)
  }
})

test('NaN, infinite and out-of-range channels: only a value provably under the threshold is black', () => {
  // The rule is `channel < threshold` on all three, nothing more (.h:297).
  // A NaN cannot be under anything, so an undecoded pixel reads as picture
  // and never invents a bar; a negative one is as black as black gets.
  for (const mode of Y_MODES) {
    assert.deepEqual(make({ mode }).detect(grid(Number.NaN, Number.NaN, Number.NaN)), NONE, `${mode}: NaN`)
    assert.deepEqual(make({ mode }).detect(grid(0, 0, Number.NaN)), NONE, `${mode}: one NaN channel`)
    assert.deepEqual(make({ mode }).detect(grid(2, 2, 2)), NONE, `${mode}: above range`)
    assert.deepEqual(make({ mode }).detect(grid(Number.POSITIVE_INFINITY, 0, 0)), NONE, `${mode}: +inf`)
    assert.equal(make({ mode }).detect(grid(-1, -1, -1)).unknown, true, `${mode}: negative`)
    assert.equal(make({ mode }).detect(grid(Number.NEGATIVE_INFINITY, 0, 0)).unknown, true, `${mode}: -inf`)
  }
  // A NaN bar next to a real picture: the picture's edge is still found from
  // the other probes, and the NaN pixels do not shrink it.
  const g = paint(letterbox(), 0, 0, W, 2, Number.NaN, Number.NaN, Number.NaN)
  assert.deepEqual(make({ mode: 'osd' }).detect(g), NONE, 'NaN in the bar is picture')
})

test('threshold 0 makes nothing black and threshold 1 makes everything short of full white black', () => {
  // Both ends are legal and both match Hyperion's byte rule (`< 0` never,
  // `< 255` for everything but 255; BlackBorderDetector.cpp:18-22).
  const zero = make({ threshold: 0 })
  assert.equal(zero.linearThreshold, 0)
  assert.deepEqual(zero.detect(black()), NONE)
  assert.deepEqual(zero.process(black(), 0), NONE)
  const one = make({ threshold: 1 })
  assert.equal(one.linearThreshold, 1)
  assert.equal(one.detect(grid(0.999, 0.999, 0.999)).unknown, true)
  assert.deepEqual(one.detect(grid(1, 1, 1)), NONE)
})

/** The largest float32 strictly below a positive float32. */
function float32Below (v: number): number {
  const f = new Float32Array([v])
  const u = new Uint32Array(f.buffer)
  u[0] = u[0]! - 1
  return f[0]!
}

test('the largest float32 under the threshold is black, so the boundary is exact in the grid\'s own precision', () => {
  const t = linearBlackThreshold(BORDER_DEFAULTS.threshold)
  assert.equal(Math.fround(t), t, 'the threshold is itself a float32')
  const below = float32Below(t)
  assert.ok(below < t)
  assert.equal(make().detect(grid(below, below, below)).unknown, true)
  assert.deepEqual(make().detect(grid(t, t, t)), NONE)
  // A double a hair under the threshold rounds UP to it in a Float32Array and
  // reads as picture: that is the grid's precision, not the compare's.
  const hair = t * (1 - 1e-9)
  assert.ok(hair < t)
  assert.equal(Math.fround(hair), t)
  assert.deepEqual(make().detect(grid(hair, hair, hair)), NONE)
})

test('asymmetric bars report the smaller side: the probes read both ends and stop at the first picture', () => {
  // 7 rows of bar on top, 3 at the bottom; 12 columns on the left, 5 on the
  // right. Default reads the bottom up the middle column and the right along
  // the middle row, so the smaller bar wins on each axis (.h:92, :104).
  const g = paint(grid(), 12, 7, W - 5, H - 3, BRIGHT, BRIGHT, BRIGHT)
  assert.deepEqual(make({ mode: 'default' }).detect(g), { unknown: false, topBottom: 3, leftRight: 5 })
  assert.deepEqual(make({ mode: 'osd' }).detect(g), { unknown: false, topBottom: 3, leftRight: 5 })
  // Classic looks only at the top-left corner and reports the LARGER bars.
  assert.deepEqual(make({ mode: 'classic' }).detect(g), { unknown: false, topBottom: 7, leftRight: 12 })
  // Letterbox reads the quarter columns from both ends: the bottom wins.
  assert.deepEqual(make({ mode: 'letterbox' }).detect(g), { unknown: false, topBottom: 3, leftRight: 0 })
})

test('a caption wide enough to reach the quarter columns fools letterbox mode after all', () => {
  // The centre column is read from the top only, but w/4 and 3w/4 are read
  // from the bottom (.h:266-267): a caption spanning them is a picture edge.
  const wide = paint(letterbox(), 20, H - 4, 76, H - 1, BRIGHT, BRIGHT, BRIGHT)
  assert.deepEqual(make({ mode: 'letterbox' }).detect(wide), { unknown: false, topBottom: 1, leftRight: 0 })
  // One column short of the quarter on each side and the rule holds.
  const narrow = paint(letterbox(), 25, H - 4, 72, H - 1, BRIGHT, BRIGHT, BRIGHT)
  assert.deepEqual(make({ mode: 'letterbox' }).detect(narrow), LETTERBOX_RAW)
})

test('an overlay flush against the picture\'s corner column defeats osd, as in Hyperion', () => {
  // osd reads Y at the detected x and its mirror (.h:220-223): a logo drawn
  // on column 0 of a letterboxed frame sits exactly on the probe.
  const flush = paint(letterbox(), 0, 1, 8, 4, BRIGHT, BRIGHT, BRIGHT)
  assert.deepEqual(make({ mode: 'osd' }).detect(flush), { unknown: false, topBottom: 1, leftRight: 0 })
  // The same logo one column in is invisible to osd and still fools default
  // only if it crosses w/3; this one does not.
  const inset = paint(letterbox(), 1, 1, 9, 4, BRIGHT, BRIGHT, BRIGHT)
  assert.deepEqual(make({ mode: 'osd' }).detect(inset), LETTERBOX_RAW)
  assert.deepEqual(make({ mode: 'default' }).detect(inset), LETTERBOX_RAW)
})

test('grids one pixel wide or tall never throw, and only the probes that fit can find a picture', () => {
  // 1 x 54: no X third, so default and osd are unknown whatever the content;
  // letterbox and classic read column 0 and find the bar.
  const column = paint(grid(0, 0, 0, 1, H), 0, LETTERBOX_BARS, 1, H - LETTERBOX_BARS, BRIGHT, BRIGHT, BRIGHT)
  assert.equal(make({ mode: 'default' }).detect(column).unknown, true)
  assert.equal(make({ mode: 'osd' }).detect(column).unknown, true)
  assert.deepEqual(make({ mode: 'letterbox' }).detect(column), LETTERBOX_RAW)
  assert.deepEqual(make({ mode: 'classic' }).detect(column), LETTERBOX_RAW)
  // 96 x 1: no Y third; classic alone walks row 0 and finds the pillarbox.
  const row = paint(grid(0, 0, 0, W, 1), PILLARBOX_BARS, 0, W - PILLARBOX_BARS, 1, BRIGHT, BRIGHT, BRIGHT)
  for (const mode of ['default', 'osd', 'letterbox'] as const) {
    assert.equal(make({ mode }).detect(row).unknown, true, mode)
  }
  assert.deepEqual(make({ mode: 'classic' }).detect(row), PILLARBOX_RAW)
  // 1 x 1 in every mode: nothing to probe, unknown, no throw.
  for (const mode of BORDER_MODES) {
    assert.equal(make({ mode }).detect(grid(BRIGHT, BRIGHT, BRIGHT, 1, 1)).unknown, true, mode)
  }
})

test('a first frame that is black, then a picture: the picture waits out the window but not borderSwitchMs', () => {
  // The boot case: black screen, then letterboxed content. Unknown is the
  // first detection and is accepted at once (trivially: it was the state);
  // the letterbox then needs maxInconsistentMs of disagreement, and switches
  // on the frame past it because there is no known border to protect.
  const d = make()
  assert.equal(d.process(black(), 0).unknown, true)
  const adopted = STEP + maxInconsistentMs + STEP
  assert.equal(feed(d, letterbox(), STEP, adopted - STEP).unknown, true)
  assert.deepEqual(d.process(letterbox(), adopted), LETTERBOX)
})

test('a switch to unknown and back reports fresh frozen objects that compare equal to the constants', () => {
  const d = settledOnLetterbox()
  const gone = feed(d, black(), 10000, 10000 + maxInconsistentMs + STEP + unknownSwitchMs)
  assert.deepEqual(gone, UNKNOWN_BORDER)
  assert.ok(Object.isFrozen(gone))
  // A known border replaces unknown as soon as its window closes.
  const back = feed(d, letterbox(), 80000, 80000 + maxInconsistentMs + STEP)
  assert.deepEqual(back, LETTERBOX)
  assert.ok(Object.isFrozen(back))
  assert.throws(() => { (back as Border).topBottom = 0 }, TypeError)
})

// ---------------------------------------------------------------------------
// Spec review: probes and formulas pinned exactly.
// ---------------------------------------------------------------------------

test('osd probes all four picture corners: a block flush against the right edge column is seen too', () => {
  // Columns 90..95 - the edge column included - rows 1..3 inside the top bar.
  // Two-corner probing (left column only) would report the intact bar.
  const topRight = paint(letterbox(), 90, 1, W, 4, BRIGHT, BRIGHT, BRIGHT)
  assert.deepEqual(make({ mode: 'osd' }).detect(topRight), { unknown: false, topBottom: 1, leftRight: 0 })
  const bottomRight = paint(letterbox(), 90, H - 4, W, H - 1, BRIGHT, BRIGHT, BRIGHT)
  assert.deepEqual(make({ mode: 'osd' }).detect(bottomRight), { unknown: false, topBottom: 1, leftRight: 0 })
})

test('the probes stop exactly at a third: a bar of w/3 columns or h/3 rows is unknown, one pixel less is found', () => {
  // w/3 = 32: x runs 0..31, all bar. A loop bound of `<=` would read column 32.
  const wide32 = paint(grid(), 32, 0, W - 32, H, BRIGHT, BRIGHT, BRIGHT)
  for (const mode of X_MODES) assert.equal(make({ mode }).detect(wide32).unknown, true, `${mode} at 32 columns`)
  const wide31 = paint(grid(), 31, 0, W - 31, H, BRIGHT, BRIGHT, BRIGHT)
  for (const mode of X_MODES) {
    assert.deepEqual(make({ mode }).detect(wide31), { unknown: false, topBottom: 0, leftRight: 31 }, `${mode} at 31 columns`)
  }
  // h/3 = 18 for the three modes whose Y loop runs y < h/3. Classic walks a
  // diagonal clamped to (w/3, h/3) itself (.h:136-149) and so does reach row
  // 18; it is the one mode that finds an 18-row bar.
  const deep18 = paint(grid(), 0, 18, W, H - 18, BRIGHT, BRIGHT, BRIGHT)
  for (const mode of ['default', 'osd', 'letterbox'] as const) assert.equal(make({ mode }).detect(deep18).unknown, true, `${mode} at 18 rows`)
  assert.deepEqual(make({ mode: 'classic' }).detect(deep18), { unknown: false, topBottom: 18, leftRight: 0 })
  const deep17 = paint(grid(), 0, 17, W, H - 17, BRIGHT, BRIGHT, BRIGHT)
  for (const mode of Y_MODES) {
    assert.deepEqual(make({ mode }).detect(deep17), { unknown: false, topBottom: 17, leftRight: 0 }, `${mode} at 17 rows`)
  }
})

test('the probe columns and rows are Hyperion\'s doubled floors, not the naive fractions', () => {
  // 98 wide: w/4 = 24 and 3 * 24 = 72 (.h:252), where floor(3 * 98 / 4) is 73.
  // Letterbox mode reads column 72 from the top; a lone lit pixel there is
  // seen, one at 73 is not.
  const at72 = paint(paint(grid(0, 0, 0, 98, H), 0, LETTERBOX_BARS, 98, H - LETTERBOX_BARS, BRIGHT, BRIGHT, BRIGHT), 72, 1, 73, 2, BRIGHT, BRIGHT, BRIGHT)
  assert.deepEqual(make({ mode: 'letterbox' }).detect(at72), { unknown: false, topBottom: 1, leftRight: 0 })
  const at73 = paint(paint(grid(0, 0, 0, 98, H), 0, LETTERBOX_BARS, 98, H - LETTERBOX_BARS, BRIGHT, BRIGHT, BRIGHT), 73, 1, 74, 2, BRIGHT, BRIGHT, BRIGHT)
  assert.deepEqual(make({ mode: 'letterbox' }).detect(at73), LETTERBOX_RAW)

  // 56 high: h/3 = 18 and 2 * 18 = 36 (.h:77-78), where floor(2 * 56 / 3) is 37.
  // Default's X loop reads row 36 from the left.
  const tallPillar = (): LinearGrid => paint(grid(0, 0, 0, W, 56), PILLARBOX_BARS, 0, W - PILLARBOX_BARS, 56, BRIGHT, BRIGHT, BRIGHT)
  const at36 = paint(tallPillar(), 2, 36, 3, 37, BRIGHT, BRIGHT, BRIGHT)
  assert.deepEqual(make({ mode: 'default' }).detect(at36), { unknown: false, topBottom: 0, leftRight: 2 })
  const at37 = paint(tallPillar(), 2, 37, 3, 38, BRIGHT, BRIGHT, BRIGHT)
  assert.deepEqual(make({ mode: 'default' }).detect(at37), { unknown: false, topBottom: 0, leftRight: PILLARBOX_BARS })
})

test('an oversized blurRemovePx is clamped so a picture always remains', () => {
  assert.deepEqual(make({ blurRemovePx: 30 }).process(letterbox(), 0), { unknown: false, topBottom: Math.floor((H - 1) / 2), leftRight: 0 })
  assert.deepEqual(make({ blurRemovePx: 60 }).process(pillarbox(), 0), { unknown: false, topBottom: 0, leftRight: Math.floor((W - 1) / 2) })
})
