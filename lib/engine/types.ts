/**
 * The engine's shared vocabulary. Every module under lib/engine/ speaks these
 * types and nothing else, which is what keeps them independently testable.
 *
 * Representation decision, stated once: colours are LINEAR light, channel range
 * 0..1, held in flat Float32Arrays of count*3. Linear because the wire and the
 * physics are linear (see lib/light.ts). Flat arrays because 108 LEDs at 120 Hz
 * is thirteen thousand triples a second and an object per triple would be pure
 * garbage-collector food. Objects appear only at API boundaries.
 *
 * This is also where the port departs from Hyperion, deliberately. Hyperion
 * carries uint8 sRGB through its whole pipeline, and half the defects catalogued
 * in docs/hyperion-port-plan.md - truncation losses, unclamped uint8 sums,
 * accumulator overflow - are artefacts of that choice. Floats make the entire
 * class impossible rather than merely avoided.
 */

/** One colour in linear light, each channel 0..1. Boundary type only. */
export interface LinearRgb {
  r: number
  g: number
  b: number
}

/** `count * 3` linear floats, row-major RGB. The engine's working type. */
export type LedColors = Float32Array

/**
 * One LED's sampling rectangle in normalised screen coordinates, 0..1 on both
 * axes, x to the right and y downwards. `xMax`/`yMax` are exclusive.
 */
export interface LedRect {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

/**
 * A captured frame after downscale and sRGB decode: `width * height * 3` linear
 * floats, row-major, top row first. This is what the capture stage produces and
 * what sampling consumes; nothing above this point sees screen pixels.
 */
export interface LinearGrid {
  readonly width: number
  readonly height: number
  readonly data: Float32Array
}

/**
 * Detected black bars, as insets in GRID pixels. Symmetric on purpose - the
 * detectors probe both sides and report the shared size, because letterboxing
 * and pillarboxing are symmetric in practice and an asymmetric border almost
 * always means an OSD, not a bar.
 *
 * Named for what they inset rather than Hyperion's `horizontalBorder`/
 * `verticalBorder`, whose meaning is inverted from what the words suggest and
 * which the port plan flags as a reading hazard.
 */
export interface Border {
  /** No non-black pixel was found on the probed lines. */
  unknown: boolean
  /** Rows removed from the top and from the bottom. */
  topBottom: number
  /** Columns removed from the left and from the right. */
  leftRight: number
}

export const NO_BORDER: Readonly<Border> = Object.freeze({ unknown: false, topBottom: 0, leftRight: 0 })

/**
 * A monotonic clock in milliseconds, injected everywhere time matters so tests
 * can drive it deterministically. Production uses `performance.now`. Never
 * `Date.now`: Hyperion's device latch gate compares wall-clock timestamps and
 * an NTP step or DST change skews it.
 */
export type Clock = () => number

export function allocLedColors (count: number): LedColors {
  return new Float32Array(count * 3)
}

export function fillLedColors (out: LedColors, r: number, g: number, b: number): LedColors {
  for (let i = 0; i < out.length; i += 3) {
    out[i] = r
    out[i + 1] = g
    out[i + 2] = b
  }
  return out
}
