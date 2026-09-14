import { srgbToLinear } from '#lib/light'
import type { LedColors, LedRect } from '#lib/engine/types'

/**
 * Effects: light with no screen behind it.
 *
 * This is what makes the application usable when nothing is being captured -
 * an ambient wash while music plays, a warm glow in the evening, something on
 * the strip while a board is being wired up. Hyperion has had this for years
 * and it is the feature people actually leave running.
 *
 * **We are not doing what Hyperion did.** Its effect engine embeds a CPython 3
 * interpreter (`Effect.cpp`, `PyImport_ImportModule`) so that effects can be
 * written as Python scripts. That is an enormous dependency for a handful of
 * animations, and in a browser it would mean shipping a WASM Python. Everything
 * below is a few lines of arithmetic per effect, deterministic, and tested.
 *
 * Three rules, each of which is a decision rather than a detail:
 *
 * - **Geometry, not index order.** Effects are given where each LED actually
 *   looks - the same rectangles the sampler uses - so a rainbow travels around
 *   the frame and a comet runs along the strip in the direction the strip is
 *   physically wired. An effect written against `i / count` looks right only on
 *   the rig it was written for, and wrong on a strip that starts in another
 *   corner.
 * - **Linear light, like everything else.** Colours are built in sRGB where
 *   that is how a human picks them (a hue wheel) and decoded once, because the
 *   rest of the engine works in linear and doing it anywhere else would apply
 *   the transfer function twice.
 * - **No `Math.random`, ever.** The flicker effects use a seeded generator, so
 *   a candle is reproducible frame for frame in a test. Nondeterminism here
 *   would make the difference between "the fire effect is too twitchy" and "the
 *   fire effect has a bug" impossible to tell.
 *
 * These are NOT the test patterns in `lib/engine/patterns.ts`. Those exist to
 * be diagnostic and deliberately bypass smoothing and the channel-order stage;
 * an effect is content and goes through the whole output path like a captured
 * frame does.
 */

export const EFFECT_KINDS = [
  'rainbow',
  'blobs',
  'breathe',
  'candle',
  'comet',
  'police',
  'plasma'
] as const

export type EffectKind = (typeof EFFECT_KINDS)[number]

export function isEffectKind (value: unknown): value is EffectKind {
  return typeof value === 'string' && (EFFECT_KINDS as readonly string[]).includes(value)
}

export interface EffectSpec {
  kind: EffectKind
  /**
   * How fast, as a multiplier on each effect's natural rate. 1 is the designed
   * speed; the bounds are wide because "too slow to see" and "a strobe" are
   * both legitimate things to want and neither is dangerous.
   */
  speed?: number
  /** A ceiling on the output, 0..1 in linear light. */
  brightness?: number
  /** sRGB 0..255, for the effects that take one. */
  color?: { r: number, g: number, b: number }
}

export const SPEED_MIN = 0.05
export const SPEED_MAX = 8
export const DEFAULT_SPEED = 1
export const DEFAULT_BRIGHTNESS = 1

export interface Effect {
  readonly kind: EffectKind
  /** Fills `out` with linear 0..1 for the given moment. Never allocates. */
  render: (out: LedColors, nowMs: number) => void
}

/**
 * Where each LED is, in the two forms effects need.
 *
 * Built once per layout rather than per frame: at 120 Hz and 108 LEDs the
 * alternative is thirteen thousand divisions a second to recompute numbers that
 * did not change.
 */
export interface EffectGeometry {
  readonly count: number
  /** Centre of each LED's rectangle, 0..1. `x` at `2i`, `y` at `2i + 1`. */
  readonly centres: Float32Array
  /**
   * Position along the strip, following the WIRE order: 0 at the first LED and
   * approaching - but never reaching - 1 at the last.
   *
   * Not the same as the index divided by the count when a layout has gaps or
   * uneven edges, and that is the point: it is what makes a comet move at a
   * constant speed in SPACE rather than in indices, on a rig whose edges have
   * different LED densities.
   *
   * Normalised over the CLOSED loop - the distance from the last LED back to
   * the first is counted in the total. Every effect that uses this wraps at 1,
   * so leaving the closing segment out would put the last LED exactly on top of
   * the first: at the wrap, two LEDs would light as the head instead of one,
   * and on a real frame those two sit next to each other in the corner.
   */
  readonly along: Float32Array
}

export function effectGeometry (layout: readonly LedRect[]): EffectGeometry {
  const count = layout.length
  const centres = new Float32Array(Math.max(1, count) * 2)
  const along = new Float32Array(Math.max(1, count))
  if (count === 0) return { count: 0, centres, along }

  for (let i = 0; i < count; i++) {
    const rect = layout[i] as LedRect
    centres[i * 2] = (rect.xMin + rect.xMax) / 2
    centres[i * 2 + 1] = (rect.yMin + rect.yMax) / 2
  }

  // Cumulative distance between neighbouring centres. A single LED, or a layout
  // where every LED sits in the same place, degrades to 0 rather than dividing
  // by zero.
  let total = 0
  for (let i = 1; i < count; i++) {
    const dx = (centres[i * 2] as number) - (centres[(i - 1) * 2] as number)
    const dy = (centres[i * 2 + 1] as number) - (centres[(i - 1) * 2 + 1] as number)
    total += Math.hypot(dx, dy)
    along[i] = total
  }
  // Plus the closing segment, so the last LED lands just short of 1 rather than
  // exactly on the first one. See the note on `along`.
  const closing = count > 1
    ? Math.hypot(
      (centres[0] as number) - (centres[(count - 1) * 2] as number),
      (centres[1] as number) - (centres[(count - 1) * 2 + 1] as number)
    )
    : 0
  const perimeter = total + closing
  if (perimeter > 0) {
    for (let i = 0; i < count; i++) along[i] = (along[i] as number) / perimeter
  }
  return { count, centres, along }
}

/** A clock in milliseconds. Injected everywhere: `Date.now` appears nowhere. */
export type Clock = () => number

/**
 * Hue to linear RGB.
 *
 * The hue wheel is an sRGB idea - it is how a person chooses a colour - so the
 * wheel is evaluated there and decoded once. Doing it in linear directly would
 * give a wheel with a washed-out middle and a green that swamps everything.
 */
function hue (h: number, out: Float32Array, at: number, value = 1): void {
  const t = ((h % 1) + 1) % 1
  const sector = t * 6
  const c = Math.floor(sector)
  const f = sector - c
  const rising = f
  const falling = 1 - f
  let r = 0
  let g = 0
  let b = 0
  switch (c % 6) {
    case 0: r = 1; g = rising; break
    case 1: r = falling; g = 1; break
    case 2: g = 1; b = rising; break
    case 3: g = falling; b = 1; break
    case 4: r = rising; b = 1; break
    default: r = 1; b = falling; break
  }
  out[at] = srgbToLinear(r) * value
  out[at + 1] = srgbToLinear(g) * value
  out[at + 2] = srgbToLinear(b) * value
}

/**
 * A small deterministic generator.
 *
 * mulberry32: four lines, good enough for a candle, and - the entire reason it
 * is here rather than `Math.random` - reproducible. A flicker nobody can
 * reproduce is a flicker nobody can debug.
 */
function seeded (seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Smooth 1D value noise over time, from a fixed table. Cheap and continuous. */
function noiseTable (size: number, seed: number): Float32Array {
  const random = seeded(seed)
  const table = new Float32Array(size)
  for (let i = 0; i < size; i++) table[i] = random()
  return table
}

function noiseAt (table: Float32Array, t: number): number {
  const size = table.length
  const scaled = ((t % size) + size) % size
  const i = Math.floor(scaled)
  const f = scaled - i
  const a = table[i] as number
  const b = table[(i + 1) % size] as number
  // Smoothstep rather than linear: a linear ramp between random values has a
  // visible kink at every table entry, which on a candle reads as a tick.
  const w = f * f * (3 - 2 * f)
  return a + (b - a) * w
}

export function createEffect (spec: EffectSpec, geometry: EffectGeometry, clock: Clock): Effect {
  const speed = clampSpeed(spec.speed ?? DEFAULT_SPEED)
  const brightness = clamp01(spec.brightness ?? DEFAULT_BRIGHTNESS)
  const { count, centres, along } = geometry
  const start = clock()

  // One table per effect instance, seeded from the effect itself so two candles
  // never flicker in lockstep but one candle is the same candle every run.
  const flicker = noiseTable(64, 0x9e3779b9)
  const base = spec.color ?? { r: 255, g: 160, b: 60 }
  const baseLinear = new Float32Array([
    srgbToLinear(base.r / 255),
    srgbToLinear(base.g / 255),
    srgbToLinear(base.b / 255)
  ])
  /**
   * Scratch for the blob effect, allocated once.
   *
   * Three blobs over 108 LEDs at 120 Hz is nearly forty thousand arrays a
   * second if this is allocated inside the loop - which is not a throughput
   * problem so much as a garbage collector pause in the middle of a frame,
   * and a pause here is a visible stutter on the strip.
   */
  const scratch = new Float32Array(3)

  const render = (out: LedColors, nowMs: number): void => {
    const t = ((nowMs - start) / 1000) * speed
    switch (spec.kind) {
      case 'rainbow': {
        // One full wheel around the whole rig, turning once every ten seconds.
        for (let i = 0; i < count; i++) {
          hue((along[i] as number) - t * 0.1, out as unknown as Float32Array, i * 3, brightness)
        }
        break
      }

      case 'blobs': {
        // Three slow blobs drifting over the geometry, summed. Hyperion's
        // "mood blobs" in spirit: the point is that neighbouring LEDs agree,
        // which is what makes it read as light rather than as pixels.
        for (let i = 0; i < count; i++) {
          const x = centres[i * 2] as number
          const y = centres[i * 2 + 1] as number
          let r = 0
          let g = 0
          let b = 0
          for (let blob = 0; blob < 3; blob++) {
            const phase = t * 0.13 + blob * 2.1
            const bx = 0.5 + 0.45 * Math.sin(phase * 1.07 + blob)
            const by = 0.5 + 0.45 * Math.cos(phase * 0.89 + blob * 1.7)
            const d = Math.hypot(x - bx, y - by)
            // A soft falloff, not a hard circle: a hard edge on a strip is a
            // line of LEDs that switch on together and it looks like a fault.
            const weight = Math.exp(-(d * d) / 0.06)
            hue(blob / 3 + t * 0.03, scratch, 0, 1)
            r += (scratch[0] as number) * weight
            g += (scratch[1] as number) * weight
            b += (scratch[2] as number) * weight
          }
          const at = i * 3
          out[at] = clamp01(r) * brightness
          out[at + 1] = clamp01(g) * brightness
          out[at + 2] = clamp01(b) * brightness
        }
        break
      }

      case 'breathe': {
        // A sine on brightness, never reaching zero: a strip that goes fully
        // dark reads as "it broke" rather than "it is breathing".
        const level = (0.15 + 0.85 * (0.5 - 0.5 * Math.cos(t * 0.9))) * brightness
        for (let i = 0; i < count; i++) {
          const at = i * 3
          out[at] = (baseLinear[0] as number) * level
          out[at + 1] = (baseLinear[1] as number) * level
          out[at + 2] = (baseLinear[2] as number) * level
        }
        break
      }

      case 'candle': {
        // Each LED gets its own slice of the noise table, so the strip flickers
        // as a body of flame rather than all together.
        for (let i = 0; i < count; i++) {
          const n = noiseAt(flicker, t * 3 + i * 0.7)
          const level = (0.45 + 0.55 * n) * brightness
          const at = i * 3
          // Warmer as it dims, the way a real flame is: the blue channel falls
          // faster than the red one.
          out[at] = (baseLinear[0] as number) * level
          out[at + 1] = (baseLinear[1] as number) * level * (0.75 + 0.25 * n)
          out[at + 2] = (baseLinear[2] as number) * level * (0.4 + 0.6 * n * n)
        }
        break
      }

      case 'comet': {
        // A head that travels the strip in the wire's own direction, with a
        // tail behind it. `along` rather than the index, so the speed is
        // constant in space even where the edges have different LED densities.
        const head = ((t * 0.35) % 1 + 1) % 1
        for (let i = 0; i < count; i++) {
          // Distance behind the head, wrapped: the tail must cross the seam.
          let d = head - (along[i] as number)
          if (d < 0) d += 1
          const level = Math.exp(-d / 0.12) * brightness
          const at = i * 3
          out[at] = (baseLinear[0] as number) * level
          out[at + 1] = (baseLinear[1] as number) * level
          out[at + 2] = (baseLinear[2] as number) * level
        }
        break
      }

      case 'police': {
        // Halves rather than alternating LEDs: alternating reads as noise at
        // any distance, halves read as a vehicle.
        const phase = Math.floor(t * 2) % 2 === 0
        for (let i = 0; i < count; i++) {
          const left = (centres[i * 2] as number) < 0.5
          const on = left === phase
          const at = i * 3
          out[at] = on && left ? brightness : 0
          out[at + 1] = 0
          out[at + 2] = on && !left ? brightness : 0
        }
        break
      }

      default: {
        // plasma: two sine fields over the geometry, read as a hue. Cheap, and
        // it is the one effect that makes the rig's actual shape visible.
        for (let i = 0; i < count; i++) {
          const x = centres[i * 2] as number
          const y = centres[i * 2 + 1] as number
          const v =
            Math.sin(x * 6 + t * 0.7) +
            Math.sin(y * 5 - t * 0.53) +
            Math.sin((x + y) * 4 + t * 0.31)
          hue(v / 6 + 0.5, out as unknown as Float32Array, i * 3, brightness)
        }
        break
      }
    }
  }

  return { kind: spec.kind, render }
}

function clampSpeed (value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPEED
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, value))
}

/**
 * Validates a specification off the wire.
 *
 * The panel and the engine are separate processes in the extension, so what
 * arrives here is not trusted: an unknown effect name would otherwise fall
 * through a switch and leave the strip on whatever it was showing, with nothing
 * saying why.
 */
export function parseEffectSpec (value: unknown): EffectSpec {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('effects: a spec must be an object')
  }
  const raw = value as Record<string, unknown>
  if (!isEffectKind(raw.kind)) {
    throw new RangeError(`effects: kind must be one of ${EFFECT_KINDS.join(', ')}, got ${String(raw.kind)}`)
  }
  const spec: EffectSpec = { kind: raw.kind }
  if (raw.speed !== undefined) {
    if (typeof raw.speed !== 'number' || !Number.isFinite(raw.speed)) {
      throw new TypeError('effects: speed must be a finite number')
    }
    spec.speed = clampSpeed(raw.speed)
  }
  if (raw.brightness !== undefined) {
    if (typeof raw.brightness !== 'number' || !Number.isFinite(raw.brightness)) {
      throw new TypeError('effects: brightness must be a finite number')
    }
    spec.brightness = clamp01(raw.brightness)
  }
  if (raw.color !== undefined) {
    const color = raw.color as Record<string, unknown>
    if (typeof color !== 'object' || color === null) throw new TypeError('effects: color must be an object')
    spec.color = { r: channel(color.r), g: channel(color.g), b: channel(color.b) }
  }
  return spec
}

function channel (value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`effects: a colour channel is an integer 0..255, got ${String(value)}`)
  }
  return value
}
