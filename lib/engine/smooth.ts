import type { Clock, LedColors } from '#lib/engine/types'
import { allocLedColors } from '#lib/engine/types'

/**
 * Temporal smoothing: turns a stream of per-frame LED targets into a steady
 * stream of output frames that move towards them without flicker.
 *
 * Three modes. `linear` and `decay` are ports of Hyperion's
 * LinearColorSmoothing.cpp (cited by line below); `asymmetric` is ours, and the
 * reason is in docs/hyperion-port-plan.md: a symmetric 150 ms filter kills
 * everything above ~7 Hz, at which point capturing at 120 Hz buys nothing. A
 * fast attack with a slow release keeps flashes and cuts crisp while still
 * hiding the frame-to-frame shimmer that makes an unsmoothed strip unwatchable.
 *
 * Two design rules hold for every mode, and they are where this departs from
 * Hyperion's structure rather than its maths:
 *
 * 1. The smoother runs on ITS OWN clock and only ever reads the target.
 *    `setTarget` stores; `tick` advances. Hyperion's `write()`
 *    (LinearColorSmoothing.cpp:213-234) both stores and, on first use, snaps
 *    the output to the input and starts the timer, so input arrival and output
 *    progress are coupled; a stalled input can leave it half-way through a
 *    transition. Here a transition always completes because ticks keep coming
 *    whether or not frames do.
 *
 * 2. There is exactly ONE rate limiter: `outputHz`. The plan (section 10,
 *    "three rate limiters in series") records why Hyperion cannot reach 120 Hz:
 *    a grabber cap, a coalescing gate that drops frames while processing is
 *    busy, the smoothing interval and a device latch time all narrow the flow
 *    one after another. None of those gates exist here; whoever calls `tick`
 *    gets a frame whenever one is due and null otherwise, nothing else.
 *
 * Representation: linear light, floats 0..1, flat Float32Arrays (see
 * lib/engine/types.ts). Hyperion smooths uint8 sRGB, which is why its linear
 * mode needs `ceil()` to one LSB to converge; the float analogue is `minStep`.
 */

export type SmoothingMode = 'linear' | 'decay' | 'asymmetric'

export interface SmootherBaseOptions {
  /** Number of LEDs; the frames are `count * 3` floats. */
  count: number
  /** Output frame rate. The only rate limiter in the pipeline. Default 120. */
  outputHz?: number
}

/** Port of Hyperion's `linear` type: a straight-line approach to the target. */
export interface LinearSmootherOptions extends SmootherBaseOptions {
  mode: 'linear'
  /**
   * Time from a CHANGE of target to reaching it. Default 150. Measured from
   * the last frame that differed from the one before: a still image re-sent
   * every frame does not restart the clock. (Hyperion re-arms on every write,
   * cpp:215, under which a streaming input never lands - see LinearSmoother.)
   */
  settlingMs?: number
  /**
   * Smallest per-channel move while not at the target. Float analogue of
   * Hyperion's `ceil()` to one uint8 LSB; default one 16-bit LSB, 1/65535.
   */
  minStep?: number
}

/** Port of Hyperion's `decay` type: a weighted moving average over a window. */
export interface DecaySmootherOptions extends SmootherBaseOptions {
  mode: 'decay'
  /** Averaging window. Default 150. Must be positive. */
  settlingMs?: number
  /** Weighting power: 1 = plain time share, higher favours newer frames. Default 1. */
  decay?: number
  /** How often the average is recomputed. Default = outputHz. */
  interpolationHz?: number
  /**
   * Whether to divide by the actual weight sum when the window is not yet
   * covered by frames. Default false = Hyperion: the output fades in from
   * black at start-up.
   */
  normalizePartialWindow?: boolean
}

/**
 * Ours: first-order IIR with separate attack and release, deadband, cut bypass.
 *
 * The deadband is applied to the TARGET the output heads for, not to the
 * output's motion: a new frame within `max(absFloor, relFloor * accepted)` of
 * the accepted target is capture noise and is ignored; one outside it becomes
 * the new accepted target. The output then runs all the way to the accepted
 * target and lands on it exactly (the last sub-`absFloor` remainder is
 * snapped), so a still image is reproduced to the bit rather than held up to
 * `relFloor` short of it.
 */
export interface AsymmetricSmootherOptions extends SmootherBaseOptions {
  mode: 'asymmetric'
  /** Time constant when a channel rises. Default 15. */
  attackMs?: number
  /** Time constant when a channel falls. Default 90. */
  releaseMs?: number
  /** Absolute deadband floor, linear. Default 4/65535 (four 16-bit LSBs). */
  absFloor?: number
  /** Relative deadband, fraction of the accepted target. Default 0.01. */
  relFloor?: number
  /** Mean |target - output| over all channels above which the frame snaps. Default 0.25. */
  cutThreshold?: number
}

export type SmootherOptions = LinearSmootherOptions | DecaySmootherOptions | AsymmetricSmootherOptions

export interface Smoother {
  readonly mode: SmoothingMode
  /** Current LED count; changes when `setTarget` sees a frame of another size. */
  readonly count: number
  /**
   * Stores a new target. Copies the input, so the caller may reuse its buffer.
   * Never emits and never moves the output; that is `tick`'s job. A frame of a
   * different size resets the smoother to that size first.
   */
  setTarget (colors: LedColors, now?: number): void
  /**
   * Advances the smoother to `now` and returns the frame to send if an output
   * slot has opened (one every `1000 / outputHz` ms, phase-locked to the first
   * tick), else null. The returned buffer is owned by the smoother and is
   * overwritten by the next emitted frame; copy it to keep it.
   */
  tick (now?: number): LedColors | null
  /** The last emitted frame. Black until the first emission. Same buffer rules as `tick`. */
  current (): LedColors
  /**
   * Forgets all colour state (output, targets, history) and starts again from
   * black, optionally with a new LED count. The output cadence is kept: the
   * rate limiter belongs to the link, not to the colours. The first frame
   * after a reset integrates from the next target's arrival, not from the
   * last emission before the reset, so it really does start from black.
   */
  reset (count?: number): void
}

export const SMOOTHING_DEFAULTS = Object.freeze({
  outputHz: 120,
  settlingMs: 150,
  minStep: 1 / 65535,
  decay: 1,
  attackMs: 15,
  releaseMs: 90,
  absFloor: 4 / 65535,
  relFloor: 0.01,
  cutThreshold: 0.25
})

/**
 * Tolerance on the "is a slot open" comparison, in ms. A caller that steps its
 * clock by k * period accumulates a few ulps of drift and would otherwise miss
 * a period every so often; a nanosecond is far below anything a clock resolves.
 */
const TIME_EPS = 1e-6

/**
 * A fixed-rate schedule: one slot per period, phase-locked to the first tick.
 *
 * "Due" means a slot has opened since the last one was taken, not that a whole
 * period has passed since the last take. The distinction matters as soon as the
 * caller's ticks do not land exactly on the grid: a 1 ms timer driving a
 * "period since last emit" gate would emit every 9 ms - 111 Hz, not 120 - and
 * leave one period in twelve without a frame. Locking to the grid gives
 * exactly one frame per period slot for any tick spacing finer than the period.
 *
 * After a stall of a period or more (tab throttled, GC pause) the schedule
 * re-anchors to `now` rather than paying the missed slots back as a burst; a
 * burst is the one thing a rate limiter exists to prevent. A shorter stall
 * that ends late inside a slot keeps the grid, and the next slot would then
 * open moments later - so on top of the grid no two takes may be closer than
 * half a period. That floor never bites for tick spacings under a period and
 * only ever drops the second frame of such a double.
 */
class Cadence {
  private readonly period: number
  private nextDue: number | null = null
  private lastTaken = -Infinity

  constructor (period: number) {
    this.period = period
  }

  /** True when a slot is open at `now`, and takes it. */
  take (now: number): boolean {
    if (this.nextDue !== null && now + TIME_EPS < this.nextDue) return false
    if (now - this.lastTaken < this.period / 2) return false
    this.nextDue = this.nextDue === null || now - this.nextDue >= this.period
      ? now + this.period
      : this.nextDue + this.period
    this.lastTaken = now
    return true
  }
}

/**
 * Time after a step at which decay-mode output is half-way to the new value:
 * `(1 - 2^(-1/decay)) * settlingMs` (LinearColorSmoothing.cpp:799). With the
 * weight function below, the old frame's share after time `t` is `s^decay`
 * where `s = 1 - t/window`, so half-way is `s^decay = 1/2`.
 */
export function halfLifeMs (decay: number, settlingMs: number): number {
  return (1 - Math.pow(0.5, 1 / decay)) * settlingMs
}

/**
 * Weight of a frame shown from `s` to `t`, both as fractions of the window
 * measured from the window start (0 = oldest edge, 1 = now). Port of the two
 * lambdas in LinearColorSmoothing.cpp:731-749.
 *
 * decay == 1 is a plain time share and sums to 1 over a full window. Any other
 * decay sums to `decay + 1` over a full window - the factor is there to keep the
 * weights of comparable magnitude, not to normalise them - which is why the
 * average divides by the weight sum afterwards.
 */
export function decayWeight (decay: number, s: number, t: number): number {
  if (decay === 1) return t - s
  return (decay + 1) * (Math.pow(t, decay) - Math.pow(s, decay))
}

export function createSmoother (options: SmootherOptions, clock: Clock): Smoother {
  switch (options.mode) {
    case 'linear': return new LinearSmoother(options, clock)
    case 'decay': return new DecaySmoother(options, clock)
    case 'asymmetric': return new AsymmetricSmoother(options, clock)
    default: throw new RangeError(`smooth: unknown mode ${String((options as { mode: unknown }).mode)}`)
  }
}

/**
 * What every mode shares: the target, the output buffer, the single output
 * rate limiter, and the reset-on-count-change rule. Subclasses own `state` -
 * the colours the smoother is currently at - and only ever touch it from
 * `observe` (every tick) and `advance` (ticks that emit).
 */
abstract class SmootherBase implements Smoother {
  abstract readonly mode: SmoothingMode

  protected readonly clock: Clock
  protected readonly outputHz: number
  protected ledCount: number
  /** Where the output is now. Float32 so the emitted frame is bit-identical to it. */
  protected state: LedColors
  protected target: LedColors
  /** Time the current target arrived; null before the first `setTarget`. */
  protected targetSetTime: number | null = null
  /** Time of the last emitted frame; null before the first. */
  protected lastEmit: number | null = null
  private readonly output: Cadence
  private out: LedColors

  constructor (options: SmootherBaseOptions, clock: Clock) {
    this.clock = clock
    this.outputHz = options.outputHz ?? SMOOTHING_DEFAULTS.outputHz
    requirePositive('outputHz', this.outputHz)
    this.output = new Cadence(1000 / this.outputHz)
    this.ledCount = validateCount(options.count)
    this.state = allocLedColors(this.ledCount)
    this.target = allocLedColors(this.ledCount)
    this.out = allocLedColors(this.ledCount)
  }

  get count (): number {
    return this.ledCount
  }

  setTarget (colors: LedColors, now: number = this.clock()): void {
    if (colors.length !== this.ledCount * 3) {
      if (colors.length % 3 !== 0) throw new RangeError(`smooth: frame length ${colors.length} is not a multiple of 3`)
      this.reset(colors.length / 3)
    }
    // Whether anything in the frame differs from the target already held: a
    // still image re-sent every frame is not a new target, and the modes that
    // time their approach from the target's arrival must not restart on it.
    let changed = this.targetSetTime === null
    if (!changed) {
      const target = this.target
      for (let i = 0; i < target.length; i++) {
        if (target[i] !== colors[i]) {
          changed = true
          break
        }
      }
    }
    this.target.set(colors)
    this.targetSetTime = now
    this.onTarget(now, changed)
  }

  tick (now: number = this.clock()): LedColors | null {
    // Some state is clocked independently of the output (decay's interpolation
    // rate), so every tick is observed even when nothing goes out.
    this.observe(now)
    if (!this.output.take(now)) return null
    this.advance(now)
    // Emit a copy rather than `state` itself: the caller gets a buffer it cannot
    // corrupt the smoother through, and `current()` stays put between emits
    // even when the internal state keeps moving.
    this.out.set(this.state)
    this.lastEmit = now
    return this.out
  }

  current (): LedColors {
    return this.out
  }

  reset (count: number = this.ledCount): void {
    this.ledCount = validateCount(count)
    this.state = allocLedColors(this.ledCount)
    this.target = allocLedColors(this.ledCount)
    this.out = allocLedColors(this.ledCount)
    this.targetSetTime = null
    // The integration origin goes too; the cadence lives in `output` and stays.
    this.lastEmit = null
    this.onReset()
  }

  /** Called after a new target is stored; `changed` is false for a repeat of the previous one. Must not move `state`. */
  protected onTarget (_now: number, _changed: boolean): void {}
  /** Called on every tick, emitting or not. */
  protected observe (_now: number): void {}
  /** Brings `state` up to `now` for a frame that is about to go out. */
  protected abstract advance (now: number): void
  protected onReset (): void {}
}

/**
 * Port of `performLinear` (LinearColorSmoothing.cpp:488-520).
 *
 * Not a fixed-duration lerp: on every output tick the fraction of the remaining
 * distance to cover is re-derived from the time left,
 *
 *   k = 1 - (targetTime - now) / (targetTime - previousWriteTime)     (cpp:502)
 *
 * which, with `previousWriteTime` advanced on every write (cpp:279-284), is
 * `dt / (dt + remaining)`: one N-th of the way with N ticks to go, hence a
 * straight line in time. A target that changes mid-flight simply moves the
 * aim point and the next tick re-derives k.
 */
class LinearSmoother extends SmootherBase {
  readonly mode = 'linear' as const
  private readonly settlingMs: number
  private readonly minStep: number
  private targetTime = -Infinity

  constructor (options: LinearSmootherOptions, clock: Clock) {
    super(options, clock)
    this.settlingMs = options.settlingMs ?? SMOOTHING_DEFAULTS.settlingMs
    this.minStep = options.minStep ?? SMOOTHING_DEFAULTS.minStep
    requireNonNegative('settlingMs', this.settlingMs)
    requirePositive('minStep', this.minStep)
  }

  protected override onTarget (now: number, changed: boolean): void {
    // cpp:215, with one deliberate difference: Hyperion re-arms on EVERY
    // write, so under a streaming input that repeats a still image the
    // settling snap never fires and settlingMs turns into a time constant
    // (63 % at 150 ms, exact only after eight of them). Here an unchanged
    // frame leaves the clock alone. Hyperion's write() also snaps output to
    // input on first use (cpp:221-226); we do not - the first frame ramps from
    // black like any other.
    if (changed) this.targetTime = now + this.settlingMs
  }

  protected override advance (now: number): void {
    const { state, target } = this
    // Past the settling time the target is simply written (cpp:526-530,
    // writeDirect). Also covers settlingMs = 0, which makes linear a passthrough.
    if (now >= this.targetTime) {
      state.set(target)
      return
    }

    // Hyperion initialises previousWriteTime to the first write's time
    // (cpp:224); with no emission yet, the target's arrival plays that role.
    const previousWrite = this.lastEmit ?? this.targetSetTime ?? now
    const span = this.targetTime - previousWrite
    let k = span > 0 ? 1 - (this.targetTime - now) / span : 1
    if (k < 0) k = 0
    else if (k > 1) k = 1

    const minStep = this.minStep
    for (let i = 0; i < state.length; i++) {
      const prev = state[i] as number
      const goal = target[i] as number
      const diff = goal - prev
      if (diff === 0) continue
      const distance = Math.abs(diff)
      // cpp:514-516: `ceil(k * |diff|)` guarantees at least one LSB of movement
      // per tick, so a transition ends instead of stalling one step short.
      // Integer ceil can never exceed an integer |diff|; a float floor can, so
      // the cap against overshoot has to be explicit here.
      let step = k * distance
      if (step < minStep) step = minStep
      if (step > distance) step = distance
      let next = diff < 0 ? prev - step : prev + step
      // The state is Float32: a step below one ulp of `prev` would round away
      // and the tick would stall, breaking the guarantee above. Move by one
      // ulp instead, never past the target.
      if (Math.fround(next) === prev) {
        next = nudgeFloat32(prev, goal)
        if (diff < 0 ? next < goal : next > goal) next = goal
      }
      state[i] = next
    }
  }
}

/** One float32 ulp from `value` towards `towards`. */
function nudgeFloat32 (value: number, towards: number): number {
  const magnitude = Math.abs(value)
  const ulp = magnitude === 0 ? 2 ** -149 : 2 ** (Math.floor(Math.log2(magnitude)) - 23)
  return towards > value ? value + ulp : value - ulp
}

interface RememberedFrame {
  time: number
  colors: LedColors
}

/**
 * Port of Hyperion's decay type: `rememberFrame` (LinearColorSmoothing.cpp:
 * 543-566), `interpolateFrame` (cpp:375-425) and the two clocks of
 * `performDecay` (cpp:427-449).
 *
 * The output is a weighted average of every frame shown during the last
 * `settlingMs`, each weighted by how long it was on screen (and, for decay > 1,
 * by how recently). Frames are remembered with their arrival time; each is
 * considered shown from then until the next one arrived.
 */
class DecaySmoother extends SmootherBase {
  readonly mode = 'decay' as const
  private readonly window: number
  private readonly decay: number
  private readonly interpolation: Cadence
  private readonly normalizePartialWindow: boolean
  private history: RememberedFrame[] = []
  /** Buffers of pruned frames, reused so a 120 Hz input does not churn the heap. */
  private pool: LedColors[] = []
  /** Float64 accumulator: the sum is over up to hundreds of frames and Float32 would lose the small weights. */
  private acc: Float64Array

  constructor (options: DecaySmootherOptions, clock: Clock) {
    super(options, clock)
    this.window = options.settlingMs ?? SMOOTHING_DEFAULTS.settlingMs
    this.decay = options.decay ?? SMOOTHING_DEFAULTS.decay
    // Hyperion's schema defaults interpolationRate to 1.0 while the C++
    // fallback is 25 (plan section 11, defect 7); a freshly saved config
    // recomputes the average once a second and the output stair-steps. The
    // only default that makes sense is the output rate itself.
    const interpolationHz = options.interpolationHz ?? this.outputHz
    this.normalizePartialWindow = options.normalizePartialWindow ?? false
    requirePositive('settlingMs', this.window)
    // Below 1 the weight function inverts: the oldest slice of the window
    // would outweigh the newest, the opposite of what the knob promises.
    if (!(this.decay >= 1) || !Number.isFinite(this.decay)) throw new RangeError(`smooth: decay must be a finite number of at least 1, got ${this.decay}`)
    requirePositive('interpolationHz', interpolationHz)
    this.interpolation = new Cadence(1000 / interpolationHz)
    this.acc = new Float64Array(this.ledCount * 3)
  }

  protected override onTarget (now: number, _changed: boolean): void {
    // cpp:543-566. Prune frames that ended before the window starts, but keep
    // the newest of them: it was still on screen when the window opened, and
    // without it the oldest slice of the window would have no colour at all.
    // Hyperion starts its count at p = -1 for exactly this (cpp:550).
    const windowStart = now - this.window
    let stale = -1
    for (const frame of this.history) {
      if (frame.time >= windowStart) break
      stale++
    }
    if (stale > 0) {
      for (const frame of this.history.splice(0, stale)) this.pool.push(frame.colors)
    }
    const colors = this.pool.pop() ?? allocLedColors(this.ledCount)
    colors.set(this.target)
    this.history.push({ time: now, colors })
  }

  protected override observe (now: number): void {
    // The average is recomputed on its own clock (cpp:428, 436-439), the frame
    // goes out on the output clock. Checked on every tick, not only on emitting
    // ones, so the two really are independent.
    if (this.interpolation.take(now)) this.interpolate(now)
  }

  protected override advance (_now: number): void {
    // Nothing: `state` is the latest average and the base copies it out.
  }

  protected override onReset (): void {
    this.history = []
    this.pool = []
    this.acc = new Float64Array(this.ledCount * 3)
  }

  /** Port of `interpolateFrame` (cpp:375-425). */
  private interpolate (now: number): void {
    const { acc, history, window, decay } = this
    const windowStart = now - window
    acc.fill(0)
    let fs = 0

    // Newest to oldest. Each frame was shown from its own time until the next
    // frame's time, clipped to the window; the loop ends once the window start
    // is reached, which is inside the straddling frame if there is one.
    let frameEnd = now
    for (let i = history.length - 1; i >= 0 && frameEnd > windowStart; i--) {
      const frame = history[i] as RememberedFrame
      let frameStart = frame.time > windowStart ? frame.time : windowStart
      // A frame stamped later than `now` (a caller's clock went backwards) would
      // get a negative weight; treat it as not shown yet instead.
      if (frameStart > frameEnd) frameStart = frameEnd
      const weight = decayWeight(decay, (frameStart - windowStart) / window, (frameEnd - windowStart) / window)
      fs += weight
      if (weight > 0) {
        const colors = frame.colors
        for (let c = 0; c < acc.length; c++) acc[c] = (acc[c] as number) + weight * (colors[c] as number)
      }
      frameEnd = frameStart
    }

    // cpp:415-416: `inv_fs = fs < 1 ? 1 : 1/fs`. While the window is not yet
    // covered, Hyperion leaves the sum un-normalised, so the output fades in
    // from black over the first `settlingMs`. Kept as the default because it is
    // a defensible start-up behaviour, not a defect; `normalizePartialWindow`
    // divides by the real sum instead and shows the first frame at full value.
    let divisor: number
    if (this.normalizePartialWindow) divisor = fs > 0 ? fs : 1
    else divisor = fs < 1 ? 1 : fs

    const state = this.state
    for (let c = 0; c < state.length; c++) state[c] = (acc[c] as number) / divisor
  }
}

/**
 * Ours. A first-order IIR per channel with a different time constant for
 * rising and for falling: `y += (x - y) * (1 - exp(-dt / tau))`, tau = attack
 * when x > y, release otherwise. The exact discretisation makes the response
 * independent of tick spacing, so the same content looks the same at 60 and
 * 120 Hz output.
 *
 * Two additions a plain IIR needs to be usable on captured video:
 *
 * - A perceptual deadband, on the target. Capture noise (compression, the
 *   source's own dither) jitters every channel a little on every frame; a
 *   15 ms attack passes most of that through and the strip shimmers on a
 *   still image. So the IIR does not chase the raw frame but an ACCEPTED
 *   target: a new value within `max(absFloor, relFloor * accepted)` of it is
 *   noise and leaves it alone, one outside it replaces it. Relative because
 *   contrast perception is: a fixed absolute band big enough to matter at
 *   full brightness would freeze the dark end, where the whole signal is
 *   that size, and one small enough for the dark end does nothing at the
 *   top. The absolute floor only takes over where relative would shrink
 *   below the wire's resolution. Putting the band on the target rather than
 *   on the output's motion is what lets the output LAND: it runs all the way
 *   to the accepted value, and the final remainder under `absFloor` - below
 *   anything the wire can show - is snapped, so a still image comes out
 *   exact and a fade to black ends at 0, not four LSBs above it.
 *
 * - A scene-cut bypass. When the whole frame moves at once the release tail
 *   is a visible smear of the previous scene; if the mean |x - y| over ALL
 *   channels exceeds `cutThreshold` every channel snaps this tick. Judged on
 *   the whole frame so a single flashing element does not trip it. Hyperion
 *   has no equivalent.
 *
 * A non-finite channel in a frame is ignored - the accepted target keeps its
 * last value - because NaN is absorbing in an IIR: `y + NaN` is NaN for ever,
 * and one such channel would also poison the cut mean for the whole strip.
 */
class AsymmetricSmoother extends SmootherBase {
  readonly mode = 'asymmetric' as const
  private readonly attackMs: number
  private readonly releaseMs: number
  private readonly absFloor: number
  private readonly relFloor: number
  private readonly cutThreshold: number
  /** The deadbanded target the output heads for. */
  private accepted: LedColors

  constructor (options: AsymmetricSmootherOptions, clock: Clock) {
    super(options, clock)
    this.attackMs = options.attackMs ?? SMOOTHING_DEFAULTS.attackMs
    this.releaseMs = options.releaseMs ?? SMOOTHING_DEFAULTS.releaseMs
    this.absFloor = options.absFloor ?? SMOOTHING_DEFAULTS.absFloor
    this.relFloor = options.relFloor ?? SMOOTHING_DEFAULTS.relFloor
    this.cutThreshold = options.cutThreshold ?? SMOOTHING_DEFAULTS.cutThreshold
    requirePositive('attackMs', this.attackMs)
    requirePositive('releaseMs', this.releaseMs)
    requireNonNegative('absFloor', this.absFloor)
    requireNonNegative('relFloor', this.relFloor)
    requireNonNegative('cutThreshold', this.cutThreshold)
    this.accepted = allocLedColors(this.ledCount)
  }

  protected override onTarget (_now: number, _changed: boolean): void {
    const { target, accepted, absFloor, relFloor } = this
    for (let i = 0; i < target.length; i++) {
      const x = target[i] as number
      if (!Number.isFinite(x)) continue
      const a = accepted[i] as number
      const diff = x - a
      const eps = Math.max(absFloor, relFloor * a)
      if (diff < eps && diff > -eps) continue
      accepted[i] = x
    }
  }

  protected override onReset (): void {
    this.accepted = allocLedColors(this.ledCount)
  }

  protected override advance (now: number): void {
    const { state, accepted, absFloor } = this

    let totalDistance = 0
    for (let i = 0; i < state.length; i++) totalDistance += Math.abs((accepted[i] as number) - (state[i] as number))
    if (totalDistance / state.length > this.cutThreshold) {
      state.set(accepted)
      return
    }

    // Integrate from the last emission; before the first one, from the moment
    // the target existed, so a late-starting output loop lands where a running
    // one would have. A target stamped later than this tick has not been shown
    // yet and contributes nothing (a negative dt would flip the sign of the
    // whole step).
    let dt = now - (this.lastEmit ?? this.targetSetTime ?? now)
    if (dt < 0) dt = 0
    const attack = 1 - Math.exp(-dt / this.attackMs)
    const release = 1 - Math.exp(-dt / this.releaseMs)

    for (let i = 0; i < state.length; i++) {
      const y = state[i] as number
      const x = accepted[i] as number
      const diff = x - y
      if (diff === 0) continue
      // Below the wire's resolution: land, do not creep.
      if (diff < absFloor && diff > -absFloor) {
        state[i] = x
        continue
      }
      state[i] = y + diff * (diff > 0 ? attack : release)
    }
  }
}

function validateCount (count: number): number {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`smooth: count must be a positive integer, got ${count}`)
  return count
}

function requirePositive (name: string, value: number): void {
  if (!(value > 0) || !Number.isFinite(value)) throw new RangeError(`smooth: ${name} must be a positive finite number, got ${value}`)
}

function requireNonNegative (name: string, value: number): void {
  if (!(value >= 0) || !Number.isFinite(value)) throw new RangeError(`smooth: ${name} must be a non-negative finite number, got ${value}`)
}
