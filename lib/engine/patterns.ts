import { srgbToLinear } from '#lib/light'
import type { Clock, LedColors } from '#lib/engine/types'

/**
 * Test patterns: the strip driven by generated colours instead of the screen.
 *
 * This is the bench run from the plan's stage 0, and it is the cheapest risk
 * reduction in the whole project - it proves the wiring with nothing but a USB
 * cable. The firmware runs the same five patterns at boot; this is the host's
 * copy, and it earns its place separately because it is what the calibration
 * wizards are built on:
 *
 * - The channel-order wizard lights the strip pure red and asks what colour you
 *   saw. `deriveColorOrder` has existed and been tested since the order stage
 *   was written, with nothing to feed it.
 * - The layout wizard walks one LED around the strip so the user can click the
 *   corners. Without a source that lights a single known index, there is
 *   nothing to click.
 *
 * Two rules, and both are the point rather than details:
 *
 * **Nothing here is smoothed.** A single LED walking the strip, put through a
 * 90 ms release, is a smear across four LEDs - which is the one thing the
 * pattern exists to make unambiguous. The same goes for the ramp: a measurement
 * you smooth is a measurement of the smoother.
 *
 * **Nothing here is sampled.** These write LED colours directly, so the border
 * detector, the sampler and the whole capture side are out of the loop. When
 * the strip shows the wrong thing under a test pattern, the fault is below the
 * pattern - wiring, channel order, LED count, firmware - and that is exactly
 * the halving this is for.
 *
 * Values are LINEAR light 0..1, like everything else in the engine.
 */

export const PATTERN_KINDS = ['walk', 'solid', 'ramp', 'flash', 'off'] as const

export type PatternKind = (typeof PATTERN_KINDS)[number]

export function isPatternKind (value: unknown): value is PatternKind {
  return typeof value === 'string' && (PATTERN_KINDS as readonly string[]).includes(value)
}

export interface PatternSpec {
  kind: PatternKind
  /**
   * 'solid' only: the colour, in linear light. Defaults to white.
   *
   * Linear rather than sRGB because a wizard that asks "is this red?" must put
   * the channel at full scale; anything less and the user is judging a dim red
   * against a dim green, which is exactly the comparison the wizard needs to be
   * unambiguous.
   */
  color?: { r: number, g: number, b: number }
  /** 'walk' only: LEDs per second. Hyperion's own walk runs at 5; so does ours. */
  ledsPerSecond?: number
  /** 'flash' only: full cycles per second. */
  hz?: number
}

export interface Pattern {
  readonly kind: PatternKind
  /** Writes `count * 3` linear floats into `out` for the moment `now`. */
  render: (out: LedColors, now: number) => void
}

const WALK_LEDS_PER_SECOND = 5
const FLASH_HZ = 1
/** The grey ramp's step count: 21 steps is 0..100% in 5% increments. */
export const RAMP_STEPS = 21

function fill (out: LedColors, count: number, r: number, g: number, b: number): void {
  for (let i = 0; i < count; i++) {
    const at = i * 3
    out[at] = r
    out[at + 1] = g
    out[at + 2] = b
  }
}

/**
 * Builds a pattern.
 *
 * `clock` is injected for the same reason it is everywhere else in the engine:
 * a pattern that reads the wall clock cannot be tested, and "the walk lights
 * index 7 at 1400 ms" is exactly the kind of thing that should be an assertion
 * rather than something someone squints at on a desk.
 */
export function createPattern (spec: PatternSpec, count: number, clock: Clock): Pattern {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`patterns: count must be a positive integer, got ${String(count)}`)
  }
  if (!isPatternKind(spec.kind)) {
    throw new RangeError(`patterns: unknown kind ${String(spec.kind)}`)
  }

  const started = clock()
  const colour = spec.color ?? { r: 1, g: 1, b: 1 }
  const perSecond = spec.ledsPerSecond ?? WALK_LEDS_PER_SECOND
  if (!(perSecond > 0)) {
    throw new RangeError(`patterns: ledsPerSecond must be positive, got ${String(perSecond)}`)
  }
  const hz = spec.hz ?? FLASH_HZ
  if (!(hz > 0)) throw new RangeError(`patterns: hz must be positive, got ${String(hz)}`)

  /**
   * The ramp's steps, precomputed. Even steps in sRGB, not in linear: the fault
   * this pattern looks for is a crushed low end, and to see it the steps have to
   * be evenly spaced to the EYE. A linear ramp spends most of its length looking
   * bright and would hide the very thing it is for.
   */
  const ramp = new Float32Array(RAMP_STEPS)
  for (let i = 0; i < RAMP_STEPS; i++) ramp[i] = srgbToLinear(i / (RAMP_STEPS - 1))

  const render = (out: LedColors, now: number): void => {
    if (out.length < count * 3) {
      throw new RangeError(`patterns: out holds ${out.length} floats, needs ${count * 3}`)
    }
    const elapsed = Math.max(0, now - started) / 1000

    switch (spec.kind) {
      case 'off':
        fill(out, count, 0, 0, 0)
        return

      case 'solid':
        fill(out, count, colour.r, colour.g, colour.b)
        return

      case 'walk': {
        fill(out, count, 0, 0, 0)
        // Floor, not round: the lit index must change exactly once per step and
        // at the step boundary, so "the 8th LED lit is the 8th LED on the wire"
        // is a statement someone can check with a stopwatch.
        const at = Math.floor(elapsed * perSecond) % count
        const base = at * 3
        out[base] = 1
        out[base + 1] = 1
        out[base + 2] = 1
        return
      }

      case 'ramp': {
        // The ramp is spread ALONG the strip, so all 21 steps are visible at
        // once and a non-monotonic curve shows up as a dip you can point at.
        for (let i = 0; i < count; i++) {
          const step = Math.min(RAMP_STEPS - 1, Math.floor((i / count) * RAMP_STEPS))
          const v = ramp[step] ?? 0
          const at = i * 3
          out[at] = v
          out[at + 1] = v
          out[at + 2] = v
        }
        return
      }

      case 'flash': {
        // The latency pattern: the whole strip, hard on and hard off, so a
        // 240 fps phone camera can count frames between the screen and the LEDs.
        const on = (elapsed * hz) % 1 < 0.5
        const v = on ? 1 : 0
        fill(out, count, v, v, v)
      }
    }
  }

  return { kind: spec.kind, render }
}

/**
 * Validates a spec that arrived over a message port.
 *
 * The panel and the extension are separately installed programs that can be
 * different versions of themselves, so this is a trust boundary like any other:
 * an unparsed spec would reach `createPattern` and throw inside the render
 * timer, where nobody is listening.
 */
export function parsePatternSpec (value: unknown): PatternSpec {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('patterns: spec must be an object')
  }
  const raw = value as Record<string, unknown>
  if (!isPatternKind(raw.kind)) {
    throw new RangeError(`patterns: unknown kind ${String(raw.kind)}`)
  }
  const spec: PatternSpec = { kind: raw.kind }

  if (raw.color !== undefined) {
    const colour = raw.color as Record<string, unknown>
    if (typeof colour !== 'object' || colour === null) throw new TypeError('patterns: color must be an object')
    const channels = ['r', 'g', 'b'] as const
    const parsed = { r: 0, g: 0, b: 0 }
    for (const channel of channels) {
      const v = colour[channel]
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
        throw new RangeError(`patterns: color.${channel} must be a number in 0..1, got ${String(v)}`)
      }
      parsed[channel] = v
    }
    spec.color = parsed
  }

  for (const key of ['ledsPerSecond', 'hz'] as const) {
    const v = raw[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new RangeError(`patterns: ${key} must be a positive number, got ${String(v)}`)
    }
    spec[key] = v
  }

  return spec
}

/** The three solid colours the channel-order wizard asks about, in linear light. */
export const WIZARD_COLORS = Object.freeze({
  red: Object.freeze({ r: 1, g: 0, b: 0 }),
  green: Object.freeze({ r: 0, g: 1, b: 0 }),
  blue: Object.freeze({ r: 0, g: 0, b: 1 })
})
