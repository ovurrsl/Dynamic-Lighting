import type { LedRect } from '#lib/engine/types'

/**
 * Classic TV-frame layout generator.
 *
 * Produces one sampling rectangle per LED for a strip that runs around the
 * monitor's edge. This is Hyperion's "classic" generator reduced to the knobs
 * that decide where a LED looks; gap length/position, per-corner keystone and
 * overlap are Kademe 2 work and slot in here without changing the output type.
 *
 * Along each edge the bands tile uniformly without overlapping, which is
 * deliberately different from the original HID sketch's `buildLampAttributes()`:
 * that placed top LEDs at inclusive endpoints (`i/(TOP-1)`) and side LEDs at
 * interior fractions (`(i+1)/(RIGHT+1)`). Uniform bands are what you want for
 * averaging.
 *
 * The four CORNERS are covered twice, on purpose: the top band spans the full
 * width and the side bands span the full height, so the last top LED and the
 * first right LED both see the top-right corner. That is how a corner reads as
 * one colour across the bend instead of two unrelated ones.
 */

export type Corner = 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left'

export interface ClassicLayoutSpec {
  top: number
  right: number
  bottom: number
  left: number
  /** Fraction of screen HEIGHT that top/bottom LEDs sample (Hyperion: hdepth). */
  depthTopBottom: number
  /** Fraction of screen WIDTH that left/right LEDs sample (Hyperion: vdepth). */
  depthLeftRight: number
  /** Which corner LED 0 sits in. */
  start: Corner
  /** Direction the strip runs from that corner, seen from the front. */
  clockwise: boolean
}

/** The reference rig: 108 LEDs on a 27" 16:9 panel, strip starting top-left. */
export const REFERENCE_LAYOUT: Readonly<ClassicLayoutSpec> = Object.freeze({
  top: 35,
  right: 19,
  bottom: 35,
  left: 19,
  depthTopBottom: 0.12,
  depthLeftRight: 0.08,
  start: 'top-left',
  clockwise: true
})

export function ledCount (spec: ClassicLayoutSpec): number {
  return spec.top + spec.right + spec.bottom + spec.left
}

/**
 * Builds the rectangles in canonical order - clockwise from the top-left corner:
 * top edge left-to-right, right edge top-to-bottom, bottom edge right-to-left,
 * left edge bottom-to-top - then rotates and optionally reverses that sequence
 * so that index 0 is the requested corner running the requested way.
 */
export function classicLayout (spec: ClassicLayoutSpec): LedRect[] {
  validate(spec)
  const { top, right, bottom, left, depthTopBottom: dh, depthLeftRight: dv } = spec
  const canonical: LedRect[] = []

  for (let j = 0; j < top; j++) {
    canonical.push({ xMin: j / top, xMax: (j + 1) / top, yMin: 0, yMax: dh })
  }
  for (let j = 0; j < right; j++) {
    canonical.push({ xMin: 1 - dv, xMax: 1, yMin: j / right, yMax: (j + 1) / right })
  }
  for (let j = 0; j < bottom; j++) {
    canonical.push({ xMin: 1 - (j + 1) / bottom, xMax: 1 - j / bottom, yMin: 1 - dh, yMax: 1 })
  }
  for (let j = 0; j < left; j++) {
    canonical.push({ xMin: 0, xMax: dv, yMin: 1 - (j + 1) / left, yMax: 1 - j / left })
  }

  const total = canonical.length
  // Index of each corner's first LED in the canonical (clockwise) sequence.
  const cornerIndex: Record<Corner, number> = {
    'top-left': 0,
    'top-right': top,
    'bottom-right': top + right,
    'bottom-left': top + right + bottom
  }

  // Reversing the clockwise sequence yields the counter-clockwise one, and in
  // it every corner sits at `total - canonicalIndex` (top-left stays at 0).
  const sequence = spec.clockwise ? canonical : [...canonical].reverse()
  const startAt = spec.clockwise
    ? cornerIndex[spec.start]
    : (total - cornerIndex[spec.start]) % total

  return sequence.slice(startAt).concat(sequence.slice(0, startAt))
}

function validate (spec: ClassicLayoutSpec): void {
  for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
    const n = spec[edge]
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`layout: ${edge} must be a non-negative integer, got ${n}`)
  }
  if (ledCount(spec) === 0) throw new RangeError('layout: at least one LED is required')
  for (const depth of ['depthTopBottom', 'depthLeftRight'] as const) {
    const d = spec[depth]
    if (!(d > 0 && d <= 0.5)) throw new RangeError(`layout: ${depth} must be in (0, 0.5], got ${d}`)
  }
}
