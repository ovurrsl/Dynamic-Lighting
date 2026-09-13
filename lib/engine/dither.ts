import type { LedColors } from '#lib/engine/types'

/**
 * Temporal error diffusion: quantises a linear float frame to integer codes so
 * that the TIME AVERAGE of what the strip shows equals the target rather than
 * the target's rounding.
 *
 * Port of Hyperion's `assembleAndDitherFrame` (LinearColorSmoothing.cpp:293-326),
 * which the port plan (section 10) calls the most valuable idea in that file,
 * and it is: Floyd-Steinberg error diffusion applied across time instead of
 * space, per channel, each channel independent of every other:
 *
 *   f           = value * levels + residual[i]
 *   out[i]      = clamp(round(f), 0, levels)
 *   residual[i] = f - out[i]
 *
 * A target of 10.4/255 goes out as 10, 11, 10, 11, 10, 10, 11, 10, 11, 10, ...
 * - two 11s in every five frames - and the eye integrates 10.4. Because the
 * value is in [0, 1] and rounding is to nearest, the residual is bounded to
 * [-0.5, 0.5): the error never winds up, so there is nothing to tune and no
 * state to age out. The thing to get right is WHEN it runs. Hyperion dithers
 * at the write rate, not the interpolation rate (cpp:451-460: the call sits
 * under `writePending`, not `interpolatePending`), so every frame that reaches
 * the wire carries a fresh residual and no residual is spent on a frame nobody
 * saw. Call `apply` once per frame actually sent, never once per frame merely
 * computed.
 *
 * WHERE THIS RUNS - the decision the plan takes, recorded here so nobody wires
 * it in twice: the firmware dithers when it receives 16-bit (a sigma-delta on
 * the strip's own refresh), so on the 16-bit `Afx` path the HOST DOES NOT
 * DITHER. Doing it in both places is double dithering - two error diffusers
 * with independent residuals fighting over the same LSB, which reads as noise,
 * not as extra resolution. This module is for the 8-bit Adalight/AWA
 * compatibility path, where 255 levels of linear light band badly in exactly
 * the dark scenes a bias light lives in, and for a firmware that cannot dither.
 * It is exported and wired into nothing; the link layer decides.
 *
 * Representation: the input is linear light, floats 0..1, a flat Float32Array
 * (lib/engine/types.ts). Hyperion's `meanValues` are already in 0..255 units
 * because its whole pipeline is uint8 sRGB; here `levels` is the scale, 255 or
 * 65535, and the residual is kept in level units in doubles, as Hyperion's
 * `floatT` is (LinearColorSmoothing.h:25). Nothing here is clocked: the
 * caller's frame cadence is the dither's clock.
 *
 * Two deliberate departures from the source, each with a test:
 *
 * 1. The INPUT is clamped, not just the output. `clampRounded` (cpp:23-25)
 *    clamps the rounded code and the residual is `f - code`, so an input above
 *    range would push the overshoot into the residual on every frame. Harmless
 *    in Hyperion, whose mean is in range by construction; here a smoother
 *    overshoot or a NaN from an upstream bug would poison a channel until reset.
 *    Clamping the value first makes the residual bound unconditional.
 *
 * 2. A representation deadband on the scaled input. `k / levels` is in general
 *    not representable as a float32, so an integer-exact target arrives with a
 *    fractional error of up to one float32 ULP - about 2e-3 of a level at 16
 *    bits - which the residual would faithfully accumulate into a lone off-by-one
 *    frame every few hundred frames on a value that is supposed to be static.
 *    Hyperion never sees this because its means are integer sums in doubles. A
 *    fractional part smaller than the input's own precision cannot be signal,
 *    so it is treated as zero.
 */

/** 8-bit codes, the Adalight/AWA path. */
export const LEVELS_8BIT = 255
/** 16-bit codes, the `Afx` path; only for a firmware that does not dither itself. */
export const LEVELS_16BIT = 65535

/** The quantised frame: one integer code per channel. `Uint16Array` for levels above 255. */
export type DitherOutput = Uint8Array | Uint16Array

export interface Dither {
  /** Current LED count; changes when `apply` sees a frame of another size. */
  readonly count: number
  /** Number of codes above zero: the value 1.0 is sent as `levels`. */
  readonly levels: number
  /**
   * Quantises `colors` into `out` and carries each channel's rounding error
   * into the next call. Returns `out` for chaining. A frame of a different size
   * resets the dither to that size first. `out` must hold at least
   * `colors.length` codes and must be able to hold `levels`.
   */
  apply<T extends DitherOutput> (colors: LedColors, out: T): T
  /**
   * Forgets every residual, optionally switching to a new LED count. The next
   * frame is then a plain rounding, as if nothing had ever been sent.
   */
  reset (count?: number): void
  /**
   * The live residual buffer, `count * 3` doubles in level units, each in
   * [-0.5, 0.5). Owned by the dither and reallocated on a count change; read it,
   * do not write it.
   */
  residuals (): Float64Array
}

export function createDither (count: number, levels: number): Dither {
  return new TemporalDither(count, levels)
}

class TemporalDither implements Dither {
  readonly levels: number
  private residual: Float64Array
  /**
   * Departure 2 above, in level units. The worst representation error of
   * `fround(k / levels) * levels` over every code k is exactly `levels * 2^-25`
   * (the multiply itself is exact: a 24-bit significand times a 16-bit integer
   * fits a double), so `levels * 2^-23` is that bound with a 4x margin - two
   * float32 ULPs of an input in [0.5, 1), four in [0.25, 0.5), more below. The
   * margin is arbitrary; the most light it can swallow is 2^-23 of full scale,
   * invisible by construction. Below it a fractional part is representation
   * noise, not a request for light.
   */
  private readonly exactEps: number

  constructor (count: number, levels: number) {
    if (!Number.isInteger(levels) || levels < 1 || levels > LEVELS_16BIT) {
      throw new RangeError(`dither: levels must be an integer in 1..${LEVELS_16BIT}, got ${levels}`)
    }
    this.levels = levels
    this.exactEps = levels * 2 ** -23
    this.residual = new Float64Array(validateCount(count) * 3)
  }

  get count (): number {
    return this.residual.length / 3
  }

  apply<T extends DitherOutput> (colors: LedColors, out: T): T {
    const channels = colors.length
    // Validate before touching any state, so a refused frame leaves the
    // count and the residuals exactly as they were.
    if (out.length < channels) {
      throw new RangeError(`dither: output holds ${out.length} codes, frame needs ${channels}`)
    }
    // A typed array stores modulo its width, so 65535 into a Uint8Array would
    // silently become 255 - the one failure mode a dither must not have, since
    // the residual would still believe the full code went out. The width is
    // what matters, not the class: an `instanceof` check fails for a buffer
    // built in another realm (an iframe, a vm context).
    if (this.levels > 255 && out.BYTES_PER_ELEMENT < 2) {
      throw new RangeError(`dither: ${this.levels} levels need a 16-bit output`)
    }
    if (channels !== this.residual.length) {
      // Hyperion reallocates and zeroes on a count change too
      // (`intitializeComponentVectors`, cpp:251-265); the smoother does the same
      // on `setTarget`, so a layout change propagates without anyone having to
      // remember to reset every stage.
      if (channels % 3 !== 0) throw new RangeError(`dither: frame length ${channels} is not a multiple of 3`)
      this.reset(channels / 3)
    }

    const levels = this.levels
    const eps = this.exactEps
    const residual = this.residual
    for (let i = 0; i < channels; i++) {
      // Departure 1: clamp the value, and send NaN to black rather than into
      // the residual, where it would stick. `!(v >= 0)` is the NaN test.
      let v = colors[i] as number
      if (!(v >= 0)) v = 0
      else if (v > 1) v = 1

      // Departure 2: an integer-exact target is exactly that.
      let scaled = v * levels
      const nearest = Math.round(scaled)
      if (Math.abs(scaled - nearest) < eps) scaled = nearest

      // cpp:306-324. `Math.round` and Qt's `qRound` differ only for negative
      // half-integers, which the clamp maps to 0 in both, so the codes agree.
      // With the input in [0, 1] and the residual in [-0.5, 0.5), `f` is in
      // [-0.5, levels + 0.5) and the clamp never actually fires; it is kept as
      // the port of `clampRounded` and as the invariant's guard rail.
      const f = scaled + (residual[i] as number)
      let code = Math.round(f)
      if (code < 0) code = 0
      else if (code > levels) code = levels
      out[i] = code
      residual[i] = f - code
    }
    return out
  }

  reset (count?: number): void {
    if (count === undefined || count * 3 === this.residual.length) {
      this.residual.fill(0)
      return
    }
    this.residual = new Float64Array(validateCount(count) * 3)
  }

  residuals (): Float64Array {
    return this.residual
  }
}

function validateCount (count: number): number {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`dither: count must be a positive integer, got ${count}`)
  return count
}
