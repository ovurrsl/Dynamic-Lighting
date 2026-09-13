import type { Border, Clock, LinearGrid } from '#lib/engine/types'
import { NO_BORDER } from '#lib/engine/types'
import { srgbToLinear } from '#lib/light'

/**
 * Black border detection: finds the letterbox and pillarbox bars in a captured
 * frame so the sampling stage can inset every LED's rectangle past them.
 * Without it a 2.39:1 film holds the whole top and bottom row of LEDs at black
 * for two hours, which is the most-reported ambilight complaint there is.
 *
 * Port of Hyperion's BlackBorderDetector.h (the four probe patterns) and
 * BlackBorderProcessor.cpp (the hysteresis that keeps a border from twitching),
 * nightly c9f12db. Citations: bare `.h:line` points into
 * BlackBorderDetector.h, `Processor.h:line` into BlackBorderProcessor.h and
 * `.cpp:line` into BlackBorderProcessor.cpp. The detectors are stateless, one
 * call per frame, and by design read a handful of lines rather than the whole
 * frame - O(lines), not O(pixels) - so running them at 120 Hz costs nothing
 * worth measuring.
 *
 * Where this port departs from Hyperion, on purpose:
 *
 * - Hysteresis counts MILLISECONDS on the injected clock, not frames. Hyperion's
 *   limits are frame counts (600 / 50 / 10, .cpp:15-17) tuned for its 10 FPS
 *   grabber: 50 frames is five seconds there and 0.42 s at our 120 Hz, so the
 *   same numbers would make the filter twelve times twitchier here. The
 *   defaults are those counts converted at 10 FPS.
 * - Deadlines are `>=`, not `==` (.cpp:194, :203). Equality on a counter fires
 *   only on the one frame where it lands exactly; in time there is no such
 *   frame, and even in Hyperion a limit lowered at runtime below the running
 *   count is never hit again until the next inconsistency resets it.
 * - The threshold is compared in linear light. The user's value is a fraction
 *   of sRGB, as Hyperion's percent is (.cpp:79; BlackBorderDetector.cpp:16-27
 *   rounds it up to a byte, 5% -> 13). It is converted ONCE with srgbToLinear
 *   and compared against the grid's linear channels, so "5%" means the same
 *   darkness as in Hyperion without re-encoding a pixel to test it.
 * - A disabled detector returns NO_BORDER and touches nothing. Hyperion's
 *   process() overwrites its current border with "unknown" while disabled
 *   (Processor.h:76-81), throwing away the consistent run it had built; here
 *   the state is frozen and resumes where it was when the effect ends - and
 *   the time spent disabled is not credited to any run: the runs are shifted
 *   forward by the gap on the first frame after re-enabling, so a candidate
 *   cannot win on evidence nobody looked at.
 * - Adopting a new candidate closes the disagreeing run that installed it.
 *   Hyperion leaves the counter at its maximum (.cpp:170-179), so ONE frame
 *   of the old border on the very next tick counts as "inconsistent for too
 *   long" and flips the candidate straight back, discarding the run the new
 *   border had just earned - the one thing the state machine exists to
 *   prevent (.cpp:151-159).
 * - A non-finite frame time is refused. NaN fails every comparison, so a
 *   NaN-stamped disagreeing frame skipped the window and installed a
 *   candidate whose run could never become due.
 * - The very first detection is accepted at once whatever maxInconsistentMs
 *   is. Hyperion gets its fast start from the literal `_inconsistentCnt(10)`
 *   (.cpp:24) happening to equal the default limit (.cpp:17); a config with a
 *   larger limit silently loses it.
 * - An unknown border carries zero sizes, never -1 (.cpp:21-22). Hyperion's
 *   consumer maps unknown to 0/0 before use (ImageProcessor.h:264-267); a
 *   consumer here that forgets to check `unknown` still gets a harmless inset.
 *
 * Representation: the grid is linear light, floats 0..1 (see lib/engine/types).
 * The border is in GRID pixels of the grid that was passed; the capture stage
 * keeps the grid size fixed, so a border stays meaningful from frame to frame.
 */

/**
 * Which lines are probed. All four scan at most the first third of the width
 * and of the height (.h:75-76, :129-130, :191-192, :251): a bar deeper than
 * that is not a bar, and reporting it unknown is the safe answer.
 *
 * - `default` (.h:65-119): three lines per axis, both sides. X walks in from
 *   the left along rows h/3 and 2h/3 and in from the right along the middle
 *   row, all in one loop; Y walks down columns w/3 and 2w/3 and up the middle
 *   column. Mixing the two sides into one loop is what makes the result
 *   symmetric without doing the work twice.
 * - `classic` (.h:122-177): walk the diagonal of the top-left third to the
 *   first non-black pixel, then slide left along that row and up that column
 *   while pixels stay non-black. Cheap, and fooled by any dark content in the
 *   top-left corner - a night sky, a vignette - because it never looks
 *   anywhere else. Ported as-is; the plan (section 10) records the weakness
 *   and the tests pin it.
 * - `osd` (.h:180-236): X exactly as `default`; Y is then probed only at the
 *   picture's own corner columns (x and w-1-x), top and bottom, instead of the
 *   fixed screen columns w/3, w/2, 2w/3 where centred overlays - volume bars,
 *   subtitles, channel banners - are drawn. Any one corner being non-black is
 *   enough (.h:220-223), so the protection is against overlays that keep to
 *   the title-safe area, which is where they live; one flush against the very
 *   edge column still counts.
 * - `letterbox` (.h:239-280): top and bottom only, never a side inset. Columns
 *   w/4 and 3w/4 are read from both ends; the centre column from the TOP only,
 *   in Hyperion's words "to minimise false detection of captions".
 */
export type BorderMode = 'default' | 'classic' | 'osd' | 'letterbox'

export const BORDER_MODES: readonly BorderMode[] = Object.freeze(['default', 'classic', 'osd', 'letterbox'])

export interface BorderDetectorOptions {
  /** Probe pattern. Default 'default'. */
  mode?: BorderMode
  /**
   * Darkness below which a channel counts as black, as a fraction of sRGB
   * (Hyperion's percent / 100). A pixel is black when ALL THREE channels are
   * under it (.h:293-298) - not a luma, so a deep blue bar stays a bar.
   * Default 0.05, Hyperion's 5%.
   */
  threshold?: number
  /**
   * Pixels added to every non-zero detected border, to step past the soft
   * edge a scaler leaves between bar and picture (Processor.h:92-100). Zero
   * stays zero, and the result is clamped so at least one row and one column
   * of picture remain; Hyperion's is unclamped. Default 1.
   */
  blurRemovePx?: number
  /** Time an unknown result must persist before it replaces a known border. Default 60000 (Hyperion: 600 frames). */
  unknownSwitchMs?: number
  /** Time a new border must persist before it replaces a known one. Default 5000 (Hyperion: 50 frames). */
  borderSwitchMs?: number
  /**
   * Time a run of detections disagreeing with the candidate is ignored before
   * the disagreeing border becomes the candidate. Default 1000 (Hyperion: 10
   * frames). The author's reason is the best comment in the repository
   * (.cpp:155-159): a capture card's flaky power supply produced "random"
   * frames with smaller bars every few frames, even on a frozen image.
   *
   * Measured from the first disagreeing frame, inclusively: at 10 FPS the
   * switch lands on the twelfth disagreeing frame where Hyperion's count
   * (incremented before it is compared, .cpp:170-171) lands on the eleventh,
   * and 0 still discards the first disagreeing frame rather than disabling
   * the filter.
   */
  maxInconsistentMs?: number
  /** The user's switch. Default true. See `setDisabled` for the other one. */
  enabled?: boolean
}

export interface BorderDetector {
  readonly mode: BorderMode
  /** Linear-light value all three channels must sit under for a pixel to be black. */
  readonly linearThreshold: number
  /**
   * Raw detection on one frame: stateless, no blur removal, no hysteresis.
   * What `process` feeds its state machine; exposed for tests and diagnostics.
   */
  detect (grid: LinearGrid): Readonly<Border>
  /**
   * The stable border after this frame. Runs detection, adds blur removal and
   * feeds the hysteresis; returns NO_BORDER without touching any state while
   * disabled. The returned object keeps its identity until the border changes,
   * so a consumer may compare by reference to know when to rebuild its map.
   * `now` defaults to the injected clock and exists so a caller that already
   * read the clock for this frame can pass the same instant.
   */
  process (grid: LinearGrid, now?: number): Readonly<Border>
  /** The border in effect: the stable one, or NO_BORDER while disabled. */
  current (): Readonly<Border>
  /** The user's switch (.cpp:95-117). */
  setEnabled (enabled: boolean): void
  /**
   * The pipeline's switch, latched separately from the user's (.cpp:119-132):
   * an effect or a solid colour must never have a border cut out of it
   * (Hyperion.cpp:659), and when it ends the user still has the last word.
   */
  setDisabled (disabled: boolean): void
  /** True when detection runs: enabled by the user and not hard-disabled (.cpp:139-142). */
  active (): boolean
  /** Forgets every border seen; the next detection is accepted at once again. */
  reset (): void
}

export const BORDER_DEFAULTS = Object.freeze({
  mode: 'default' as BorderMode,
  threshold: 0.05,
  blurRemovePx: 1,
  unknownSwitchMs: 60000,
  borderSwitchMs: 5000,
  maxInconsistentMs: 1000,
  enabled: true
})

/** What every detector returns when no probed line found a non-black pixel. */
export const UNKNOWN_BORDER: Readonly<Border> = Object.freeze({ unknown: true, topBottom: 0, leftRight: 0 })

/**
 * Border equality as the hysteresis sees it (.h:29-37): an unknown result
 * equals only another unknown result, whatever sizes either carries; known
 * borders compare by size.
 */
export function bordersEqual (a: Border, b: Border): boolean {
  if (a.unknown || b.unknown) return a.unknown && b.unknown
  return a.topBottom === b.topBottom && a.leftRight === b.leftRight
}

/**
 * The sRGB threshold as a linear-light value, rounded to float32.
 *
 * The rounding is not cosmetic: the grid is a Float32Array, so a pixel painted
 * at exactly the threshold is stored rounded, and comparing it against the
 * unrounded double would make "exactly at threshold" black or not depending
 * on which way the rounding went. Rounding both the same way keeps the rule
 * exact: at the threshold is not black, below it is.
 */
export function linearBlackThreshold (threshold: number): number {
  return Math.fround(srgbToLinear(threshold))
}

/** Raw detection with no state: what `BorderDetector.detect` calls. */
export function detectBorder (grid: LinearGrid, mode: BorderMode, linearThreshold: number): Readonly<Border> {
  validateGrid(grid)
  switch (mode) {
    case 'default': return detectDefault(grid, linearThreshold)
    case 'classic': return detectClassic(grid, linearThreshold)
    case 'osd': return detectOsd(grid, linearThreshold)
    case 'letterbox': return detectLetterbox(grid, linearThreshold)
    default: throw new RangeError(`border: unknown mode ${String(mode)}`)
  }
}

export function createBorderDetector (options: BorderDetectorOptions, clock: Clock): BorderDetector {
  return new BorderProcessor(options, clock)
}

// ---------------------------------------------------------------------------
// Detectors. Every probe below stays inside the grid for any width and height
// of at least one pixel: floor(n/3), 2*floor(n/3), floor(n/2), 3*floor(n/4) are
// all below n, and the mirrored `last - i` indices are bounded by the loop
// limits. validateGrid() establishes the size, so the reads need no guards.
// ---------------------------------------------------------------------------

/** .h:293-298: black is every channel under the threshold, not a luma. */
function isBlack (grid: LinearGrid, t: number, x: number, y: number): boolean {
  const i = (y * grid.width + x) * 3
  const d = grid.data
  return d[i]! < t && d[i + 1]! < t && d[i + 2]! < t
}

/**
 * Packs the two loop results the way .h:113-118 does, except that a failed
 * axis (index -1) yields the zero-sized UNKNOWN_BORDER rather than a -1 that a
 * consumer could apply as an inset.
 */
function border (leftRight: number, topBottom: number): Readonly<Border> {
  if (leftRight < 0 || topBottom < 0) return UNKNOWN_BORDER
  return { unknown: false, topBottom, leftRight }
}

/**
 * The X loop shared by `default` and `osd` (.h:89-99 and .h:203-214 are the
 * same code): in from the right along the middle row, in from the left along
 * the rows at one and two thirds. Returns the first non-black column, or -1.
 */
function findLeftRight (grid: LinearGrid, t: number): number {
  const { width: w, height: h } = grid
  const w3 = Math.floor(w / 3)
  const h3 = Math.floor(h / 3)
  const h66 = h3 * 2
  const yCenter = Math.floor(h / 2)
  const lastX = w - 1
  for (let x = 0; x < w3; x++) {
    if (!isBlack(grid, t, lastX - x, yCenter) || !isBlack(grid, t, x, h3) || !isBlack(grid, t, x, h66)) return x
  }
  return -1
}

/** .h:65-119. */
function detectDefault (grid: LinearGrid, t: number): Readonly<Border> {
  const { width: w, height: h } = grid
  const w3 = Math.floor(w / 3)
  const w66 = w3 * 2
  const h3 = Math.floor(h / 3)
  const xCenter = Math.floor(w / 2)
  const lastY = h - 1

  const leftRight = findLeftRight(grid, t)

  // .h:101-111: up the middle column from the bottom, down the columns at one
  // and two thirds from the top.
  let topBottom = -1
  for (let y = 0; y < h3; y++) {
    if (!isBlack(grid, t, xCenter, lastY - y) || !isBlack(grid, t, w3, y) || !isBlack(grid, t, w66, y)) {
      topBottom = y
      break
    }
  }
  return border(leftRight, topBottom)
}

/** .h:122-177. */
function detectClassic (grid: LinearGrid, t: number): Readonly<Border> {
  const w3 = Math.floor(grid.width / 3)
  const h3 = Math.floor(grid.height / 3)
  const maxSize = Math.max(w3, h3)

  // .h:136-149: the diagonal, clamped to the third on each axis so a wide grid
  // keeps walking along row h/3 once the diagonal runs out of rows.
  let x = -1
  let y = -1
  for (let i = 0; i < maxSize; i++) {
    const px = Math.min(i, w3)
    const py = Math.min(i, h3)
    if (!isBlack(grid, t, px, py)) {
      x = px
      y = py
      break
    }
  }
  // .h:151-169: expand left, then up. Both loops are skipped on -1.
  for (; x > 0; x--) if (isBlack(grid, t, x - 1, y)) break
  for (; y > 0; y--) if (isBlack(grid, t, x, y - 1)) break
  return border(x, y)
}

/** .h:180-236. */
function detectOsd (grid: LinearGrid, t: number): Readonly<Border> {
  const leftRight = findLeftRight(grid, t)
  // Hyperion runs the Y probes even when no X was found, at x = w/3 - the
  // exhausted loop variable (.h:204-205, :220). The result is unknown either
  // way (.h:232), so the probes are skipped here; same output, fewer reads.
  if (leftRight < 0) return UNKNOWN_BORDER

  const { width: w, height: h } = grid
  const h3 = Math.floor(h / 3)
  const lastX = w - 1
  const lastY = h - 1
  const x = leftRight
  const mirrorX = lastX - leftRight

  // .h:216-228: the four corners of the picture at the detected x.
  let topBottom = -1
  for (let y = 0; y < h3; y++) {
    if (!isBlack(grid, t, x, y) || !isBlack(grid, t, x, lastY - y) ||
        !isBlack(grid, t, mirrorX, y) || !isBlack(grid, t, mirrorX, lastY - y)) {
      topBottom = y
      break
    }
  }
  return border(leftRight, topBottom)
}

/** .h:239-280. */
function detectLetterbox (grid: LinearGrid, t: number): Readonly<Border> {
  const { width: w, height: h } = grid
  const w25 = Math.floor(w / 4)
  const w75 = w25 * 3
  const h3 = Math.floor(h / 3)
  const xCenter = Math.floor(w / 2)
  const lastY = h - 1

  // .h:260-272: quarter columns from both ends, centre column from the top.
  let topBottom = -1
  for (let y = 0; y < h3; y++) {
    if (!isBlack(grid, t, xCenter, y) ||
        !isBlack(grid, t, w25, y) || !isBlack(grid, t, w75, y) ||
        !isBlack(grid, t, w25, lastY - y) || !isBlack(grid, t, w75, lastY - y)) {
      topBottom = y
      break
    }
  }
  return border(0, topBottom)
}

function validateGrid (grid: LinearGrid): void {
  const { width, height, data } = grid
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`border: grid must be at least 1x1, got ${width}x${height}`)
  }
  if (data.length < width * height * 3) {
    throw new RangeError(`border: grid data holds ${data.length} floats, ${width}x${height} needs ${width * height * 3}`)
  }
}

// ---------------------------------------------------------------------------
// Hysteresis.
// ---------------------------------------------------------------------------

/**
 * Processor.h:92-100: step past the scaler's soft edge. Unknown has nothing
 * to grow. Clamped so that some picture always remains: an oversized
 * blurRemovePx is a configuration mistake, not a reason for the sampler to
 * refuse every frame.
 */
function withBlurRemoved (detected: Readonly<Border>, px: number, grid: LinearGrid): Readonly<Border> {
  if (detected.unknown || px === 0) return detected
  const maxTopBottom = Math.floor((grid.height - 1) / 2)
  const maxLeftRight = Math.floor((grid.width - 1) / 2)
  return {
    unknown: false,
    topBottom: detected.topBottom > 0 ? Math.min(detected.topBottom + px, maxTopBottom) : 0,
    leftRight: detected.leftRight > 0 ? Math.min(detected.leftRight + px, maxLeftRight) : 0
  }
}

/**
 * Port of BlackBorderProcessor::updateBorder (.cpp:149-211) with the two frame
 * counters replaced by the instants their runs began.
 *
 * Two borders are tracked. `currentBorder` is the one in effect. `candidate`
 * (Hyperion's _previousDetectedBorder) is the one the consistency run is
 * measuring: a detection that matches it extends the run, one that differs is
 * dropped until the disagreement has itself lasted longer than
 * maxInconsistentMs, at which point the disagreeing border becomes the
 * candidate and its run starts. The candidate replaces the current border once
 * its run is long enough - borderSwitchMs, or unknownSwitchMs for unknown, or
 * at once when there is no current border to protect.
 *
 * The point of the two-level scheme is the flaky-grabber story in .cpp:155-159:
 * a single frame with a different bar neither switches the border nor resets
 * the run of the border that was about to win.
 */
class BorderProcessor implements BorderDetector {
  readonly mode: BorderMode
  readonly linearThreshold: number

  private readonly clock: Clock
  private readonly blurRemovePx: number
  private readonly unknownSwitchMs: number
  private readonly borderSwitchMs: number
  private readonly maxInconsistentMs: number

  private userEnabled: boolean
  private hardDisabled = false

  /** The border in effect (.cpp:21). Frozen, so a consumer can keep it. */
  private currentBorder: Readonly<Border> = UNKNOWN_BORDER
  /** The border whose consistency is being measured (.cpp:22); null before the first detection. */
  private candidate: Readonly<Border> | null = null
  /** When the candidate's run began. Meaningless while `candidate` is null. */
  private consistentSince = 0
  /** When the current run of detections disagreeing with the candidate began; null while they agree. */
  private inconsistentSince: number | null = null
  /** Time of the last frame that was processed; null before the first. */
  private lastSeen: number | null = null
  /** Set when detection stops; the first frame after it resumes shifts the runs past the gap. */
  private resumePending = false

  constructor (options: BorderDetectorOptions, clock: Clock) {
    this.clock = clock
    this.mode = options.mode ?? BORDER_DEFAULTS.mode
    if (!BORDER_MODES.includes(this.mode)) throw new RangeError(`border: unknown mode ${String(this.mode)}`)

    const threshold = options.threshold ?? BORDER_DEFAULTS.threshold
    if (!(threshold >= 0 && threshold <= 1)) throw new RangeError(`border: threshold must be in [0, 1], got ${threshold}`)
    this.linearThreshold = linearBlackThreshold(threshold)

    this.blurRemovePx = options.blurRemovePx ?? BORDER_DEFAULTS.blurRemovePx
    if (!Number.isInteger(this.blurRemovePx) || this.blurRemovePx < 0) {
      throw new RangeError(`border: blurRemovePx must be a non-negative integer, got ${this.blurRemovePx}`)
    }
    this.unknownSwitchMs = requireDuration('unknownSwitchMs', options.unknownSwitchMs ?? BORDER_DEFAULTS.unknownSwitchMs)
    this.borderSwitchMs = requireDuration('borderSwitchMs', options.borderSwitchMs ?? BORDER_DEFAULTS.borderSwitchMs)
    this.maxInconsistentMs = requireDuration('maxInconsistentMs', options.maxInconsistentMs ?? BORDER_DEFAULTS.maxInconsistentMs)
    this.userEnabled = options.enabled ?? BORDER_DEFAULTS.enabled
  }

  detect (grid: LinearGrid): Readonly<Border> {
    return detectBorder(grid, this.mode, this.linearThreshold)
  }

  process (grid: LinearGrid, now: number = this.clock()): Readonly<Border> {
    if (!this.active()) return NO_BORDER
    if (!Number.isFinite(now)) throw new RangeError(`border: frame time must be finite, got ${now}`)
    if (this.resumePending) {
      // Detection was off between the last frame and this one; the runs are
      // moved forward by that gap so it counts for nothing.
      this.resumePending = false
      if (this.lastSeen !== null) {
        const gap = now - this.lastSeen
        if (gap > 0) {
          this.consistentSince += gap
          if (this.inconsistentSince !== null) this.inconsistentSince += gap
        }
      }
    }
    this.update(withBlurRemoved(this.detect(grid), this.blurRemovePx, grid), now)
    this.lastSeen = now
    return this.currentBorder
  }

  current (): Readonly<Border> {
    return this.active() ? this.currentBorder : NO_BORDER
  }

  setEnabled (enabled: boolean): void {
    const wasActive = this.active()
    this.userEnabled = enabled
    if (wasActive && !this.active()) this.resumePending = true
  }

  setDisabled (disabled: boolean): void {
    const wasActive = this.active()
    this.hardDisabled = disabled
    if (wasActive && !this.active()) this.resumePending = true
  }

  // Hyperion keeps a third, derived flag up to date in both setters
  // (.cpp:100-109, :121-130); it always equals this conjunction.
  active (): boolean {
    return this.userEnabled && !this.hardDisabled
  }

  reset (): void {
    this.currentBorder = UNKNOWN_BORDER
    this.candidate = null
    this.consistentSince = 0
    this.inconsistentSince = null
    this.lastSeen = null
    this.resumePending = false
  }

  private update (detected: Readonly<Border>, now: number): void {
    // .cpp:162-180: extend the candidate's run, or discard the disagreement
    // until it has lasted long enough to be believed.
    if (this.candidate !== null && bordersEqual(detected, this.candidate)) {
      this.inconsistentSince = null
    } else {
      // A null candidate means nothing has been seen yet, and the first
      // detection is believed at once; Hyperion does the same by starting its
      // counter at the limit (.cpp:24), which only works for the default limit.
      if (this.candidate !== null) {
        this.inconsistentSince ??= now
        if (now - this.inconsistentSince <= this.maxInconsistentMs) return
      }
      this.candidate = detected
      this.consistentSince = now
      // The disagreeing run has done its job. Hyperion leaves its counter at
      // the maximum here (.cpp:170-179), which lets a single frame of the old
      // border on the next tick flip the candidate straight back.
      this.inconsistentSince = null
    }

    // .cpp:182-188.
    if (bordersEqual(this.currentBorder, detected)) {
      this.inconsistentSince = null
      return
    }

    // .cpp:190-208 with `>=` for `==`.
    const consistentFor = now - this.consistentSince
    const due = detected.unknown
      ? consistentFor >= this.unknownSwitchMs
      : this.currentBorder.unknown || consistentFor >= this.borderSwitchMs
    if (due) this.currentBorder = Object.freeze({ ...detected })
  }
}

function requireDuration (name: string, value: number): number {
  if (!(Number.isFinite(value) && value >= 0)) throw new RangeError(`border: ${name} must be a finite non-negative number of ms, got ${value}`)
  return value
}
