import type { LedRect } from '#lib/engine/types'

/**
 * Where each LED looks: the layout generators.
 *
 * Port of Hyperion's layout builders, which live in its web UI rather than in
 * the C++ core - `assets/webconfig/js/content_leds.js`, nightly c9f12db:
 * `createClassicLedLayout()` (:286-424), `createMatrixLayout()` (:472-547) and
 * `blackListLeds()` (:574-599). Bare `:line` references below point into that
 * file. The output is normalised rectangles (lib/engine/types.ts), which
 * lib/engine/sample.ts resolves to grid pixels.
 *
 * This is the part that decides whether the product fits anyone's monitor but
 * the one on this desk, so every knob Hyperion exposes is here: per-edge
 * counts, band depths, a gap where the strip does not reach, the wire's entry
 * point and direction, band overlap, an inset at the edge ends, and the four
 * keystone corners for a strip that is not a perfect rectangle.
 *
 * Where this port departs from Hyperion, on purpose:
 *
 * - The wire's entry is `start` (a corner) + `offset` (LEDs past it) +
 *   `clockwise`, not Hyperion's raw `position` count and separate `reverse`
 *   flag. Its two knobs interact in a way nobody expects: `reverse` is applied
 *   AFTER the rotation (:417-421), so with it set the LED you positioned ends
 *   up LAST. Here index 0 is the first LED the strip meets on leaving `start`
 *   in the direction `clockwise` names, plus `offset`, either way round.
 * - The gap is validated, not silently reshaped. Hyperion clamps an
 *   out-of-range gap position by assigning to an undeclared global
 *   (`ledsgpos = mpos`, :404 - the `params.` is missing), so the clamp is dead
 *   code and the splice quietly uses the original value; and when the gap is
 *   longer than the strip it computes `length - glength - 1` (:410), which is
 *   negative for any such gap. Both throw here.
 * - The edge inset is derived from a configurable `aspectRatio`. Hyperion
 *   hardcodes 16:9 (`edgeVGap / (16 / 9)`, :287), so on a 21:9 or 4:3 panel
 *   its horizontal inset is wrong by the ratio of the ratios.
 * - Coordinates keep full float precision. Hyperion rounds every edge to four
 *   decimals (`round()`, :33-38) to keep its JSON readable; at 128 grid
 *   columns that is 0.013 px, so nothing is gained by dropping it and a band
 *   edge that lands exactly between two pixels stays exactly there.
 * - A blacklisted LED keeps its index and gets a zero-area rectangle, as in
 *   Hyperion (:593), because the wire position of every later LED depends on
 *   it. But a rule naming LEDs the strip does not have throws rather than
 *   being ignored (:585): "LED 200 is off" is not a safe thing to be wrong
 *   about on a 108-LED strip.
 */

export type Corner = 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left'

export const CORNERS: readonly Corner[] = Object.freeze(['top-left', 'top-right', 'bottom-right', 'bottom-left'])

/** A keystone corner, in the same normalised coordinates as `LedRect`. */
export interface LayoutPoint {
  x: number
  y: number
}

/**
 * The four corners of the area the strip frames. The default is the whole
 * frame; moving them models a strip that is not a rectangle - mounted on a
 * curved panel, or set back from the edge on one side only. Hyperion calls
 * these the trapezoid points (`pttlh`/`pttlv` and friends, :277-278).
 */
export interface Keystone {
  topLeft: LayoutPoint
  topRight: LayoutPoint
  bottomRight: LayoutPoint
  bottomLeft: LayoutPoint
}

export const NO_KEYSTONE: Readonly<Keystone> = Object.freeze({
  topLeft: Object.freeze({ x: 0, y: 0 }),
  topRight: Object.freeze({ x: 1, y: 0 }),
  bottomRight: Object.freeze({ x: 1, y: 1 }),
  bottomLeft: Object.freeze({ x: 0, y: 1 })
})

/** Where the strip does not reach: `length` LEDs missing from `position` on. */
export interface LayoutGap {
  /** Index in the geometric (clockwise from top-left) order where the gap starts. */
  position: number
  /** How many LED positions are missing. 0 disables the gap. */
  length: number
}

export interface ClassicLayoutSpec {
  top: number
  right: number
  bottom: number
  left: number
  /** Fraction of screen HEIGHT that top/bottom LEDs sample (Hyperion: hdepth). */
  depthTopBottom: number
  /** Fraction of screen WIDTH that left/right LEDs sample (Hyperion: vdepth). */
  depthLeftRight: number
  /** Which corner the wire's LED 0 sits in (before `offset`). */
  start: Corner
  /** Direction the strip runs from that corner, seen from the front. */
  clockwise: boolean
  /**
   * LEDs between `start` and the wire's LED 0, counted the way the strip runs.
   * This is how a strip whose first LED is mid-edge - at the bottom-centre cut
   * where the power is injected, say - is expressed. May be negative (before
   * the corner) and wraps. Default 0.
   */
  offset?: number
  /**
   * Where the strip does not reach, in geometric order. Default none. A gap
   * removes those positions entirely: the LEDs after it move up, because on
   * the wire they do.
   */
  gap?: LayoutGap
  /**
   * Grows every band by this fraction along its own edge, so neighbours
   * overlap and a moving edge crosses them gradually instead of stepping
   * (Hyperion: `overlap`, :325-330). Clamped to the frame. Default 0.
   */
  overlap?: number
  /**
   * Inset at both ends of every edge, as a fraction of HEIGHT: the strip
   * usually stops short of the corners. Applied to the left and right edges as
   * given and to the top and bottom scaled by `aspectRatio`, so the inset is
   * the same physical distance on all four (Hyperion: `edgeVGap`, :287).
   * Default 0.
   */
  edgeGap?: number
  /** Width / height of the panel, for `edgeGap`. Default 16/9. */
  aspectRatio?: number
  /** The four corners of the framed area. Default `NO_KEYSTONE`. */
  keystone?: Keystone
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

export const LAYOUT_DEFAULTS = Object.freeze({
  offset: 0,
  overlap: 0,
  edgeGap: 0,
  aspectRatio: 16 / 9
})

/** LED positions the four edges describe, before any gap is taken out. */
export function ledCount (spec: ClassicLayoutSpec): number {
  return spec.top + spec.right + spec.bottom + spec.left
}

/** Index of each corner's first LED in the geometric (clockwise) order. */
export function cornerIndex (spec: ClassicLayoutSpec, corner: Corner): number {
  switch (corner) {
    case 'top-left': return 0
    case 'top-right': return spec.top
    case 'bottom-right': return spec.top + spec.right
    case 'bottom-left': return spec.top + spec.right + spec.bottom
  }
}

/**
 * One rectangle per LED, in WIRE order: index 0 is the LED the controller
 * drives first.
 *
 * Built in three steps, which is the only order in which the knobs compose:
 *
 * 1. The four edges in geometric order - top left-to-right, right top-to-
 *    bottom, bottom right-to-left, left bottom-to-top - so every rectangle
 *    knows where on the frame it is.
 * 2. The gap takes out the positions the strip does not cover.
 * 3. `start`, `offset` and `clockwise` map what is left onto wire indices.
 *
 * Within an edge the bands tile without overlapping unless `overlap` says
 * otherwise, which is deliberately different from the original HID sketch's
 * `buildLampAttributes()`: that placed top LEDs at inclusive endpoints
 * (`i/(TOP-1)`) and side LEDs at interior fractions (`(i+1)/(RIGHT+1)`).
 * Uniform bands are what you want for averaging.
 *
 * The four CORNERS are covered twice at the default depths, on purpose: the
 * top band spans the full width and the side bands the full height, so the
 * last top LED and the first right LED both see the top-right corner. That is
 * how a corner reads as one colour across the bend instead of two unrelated
 * ones. `edgeGap` is the knob that pulls them apart.
 */
export function classicLayout (spec: ClassicLayoutSpec): LedRect[] {
  validateClassic(spec)
  const { top, right, bottom, left, depthTopBottom: dh, depthLeftRight: dv } = spec
  const keystone = spec.keystone ?? NO_KEYSTONE
  const { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl } = keystone
  const overlap = spec.overlap ?? LAYOUT_DEFAULTS.overlap
  const gapV = spec.edgeGap ?? LAYOUT_DEFAULTS.edgeGap
  // :287. The inset is given as a fraction of height; on the horizontal edges
  // the same physical distance is a smaller fraction of the wider axis.
  const gapH = gapV / (spec.aspectRatio ?? LAYOUT_DEFAULTS.aspectRatio)

  const grow = (v: number, sign: 1 | -1): number => clampUnit(v + sign * overlap)
  const rects: LedRect[] = []

  // :340-352. The band follows the top keystone line, so on a tilted top edge
  // each LED's depth starts where the line is under it.
  for (let i = 0; i < top; i++) {
    const stepX = (tr.x - tl.x - 2 * gapH) / top
    const stepY = (tr.y - tl.y) / top
    const yMin = tl.y + stepY * i
    rects.push({
      xMin: grow(tl.x + stepX * i + gapH, -1),
      xMax: grow(tl.x + stepX * (i + 1) + gapH, 1),
      yMin,
      yMax: yMin + dh
    })
  }

  // :353-365.
  for (let i = 0; i < right; i++) {
    const stepX = (br.x - tr.x) / right
    const stepY = (br.y - tr.y - 2 * gapV) / right
    const xMax = tr.x + stepX * (i + 1)
    rects.push({
      xMin: xMax - dv,
      xMax,
      yMin: grow(tr.y + stepY * i + gapV, -1),
      yMax: grow(tr.y + stepY * (i + 1) + gapV, 1)
    })
  }

  // :366-378, right to left.
  for (let i = bottom - 1; i >= 0; i--) {
    const stepX = (br.x - bl.x - 2 * gapH) / bottom
    const stepY = (br.y - bl.y) / bottom
    const yMax = bl.y + stepY * i
    rects.push({
      xMin: grow(bl.x + stepX * i + gapH, -1),
      xMax: grow(bl.x + stepX * (i + 1) + gapH, 1),
      yMin: yMax - dh,
      yMax
    })
  }

  // :379-391, bottom to top.
  for (let i = left - 1; i >= 0; i--) {
    const stepX = (bl.x - tl.x) / left
    const stepY = (bl.y - tl.y - 2 * gapV) / left
    const xMin = tl.x + stepX * i
    rects.push({
      xMin,
      xMax: xMin + dv,
      yMin: grow(tl.y + stepY * i + gapV, -1),
      yMax: grow(tl.y + stepY * (i + 1) + gapV, 1)
    })
  }

  return orient(rects, spec)
}

/**
 * Steps 2 and 3: the gap, then the wire order. Separate from the geometry so
 * the anchor can be found by identity - a gap before the start corner shifts
 * every later index, and computing the rotation from the edge counts alone
 * would then point at the wrong LED.
 *
 * The anchor is the first LED the strip meets on leaving the corner in the
 * chosen direction, so it is the corner's own edge either way round: leaving
 * the top-left clockwise the first LED is the leftmost of the TOP edge, and
 * leaving it anti-clockwise the first is the topmost of the LEFT edge - the
 * last LED of the run that arrives at that corner. Each LED's band therefore
 * always lies along the edge the strip is travelling down.
 */
function orient (geometric: LedRect[], spec: ClassicLayoutSpec): LedRect[] {
  const total = geometric.length
  const gap = spec.gap
  const clockwise = spec.clockwise
  const hasGap = gap !== undefined && gap.length > 0
  const survives = (at: number): boolean =>
    !hasGap || at < gap.position || at >= gap.position + gap.length

  // Walk from the corner in the direction of travel until a LED exists there:
  // a gap that swallowed the corner hands the anchor to its neighbour.
  let at = clockwise ? cornerIndex(spec, spec.start) : mod(cornerIndex(spec, spec.start) - 1, total)
  while (!survives(at)) at = mod(at + (clockwise ? 1 : -1), total)
  const anchor = geometric[at] as LedRect

  const kept = hasGap
    ? geometric.slice(0, gap.position).concat(geometric.slice(gap.position + gap.length))
    : geometric
  const oriented = clockwise ? kept : [...kept].reverse()
  const start = mod(oriented.indexOf(anchor) + (spec.offset ?? LAYOUT_DEFAULTS.offset), oriented.length)
  return oriented.slice(start).concat(oriented.slice(0, start))
}

// ---------------------------------------------------------------------------
// Matrix: a LED wall rather than a frame.
// ---------------------------------------------------------------------------

export type Cabling = 'snake' | 'parallel'
export type MatrixDirection = 'horizontal' | 'vertical'

export interface MatrixLayoutSpec {
  columns: number
  rows: number
  /**
   * `snake` reverses every other line, which is how a single strip folded back
   * and forth is wired; `parallel` starts every line at the same side.
   */
  cabling: Cabling
  /** Which cell the wire's first LED is. */
  start: Corner
  /** Whether the wire runs along rows or along columns. */
  direction: MatrixDirection
  /** Fractions of the frame left uncovered on each side. Default none. */
  gap?: { top?: number, right?: number, bottom?: number, left?: number }
}

export const MATRIX_REFERENCE: Readonly<MatrixLayoutSpec> = Object.freeze({
  columns: 16,
  rows: 9,
  cabling: 'snake',
  start: 'top-left',
  direction: 'horizontal'
})

export function matrixLedCount (spec: MatrixLayoutSpec): number {
  return spec.columns * spec.rows
}

/**
 * One rectangle per cell of a `columns` x `rows` wall, in wire order. Port of
 * `createMatrixLayout` (:472-547), whose walk Hyperion credits to Juha
 * Rantanen; the cells tile the frame inside the gaps with no overlap.
 *
 * Secondary for this product - the strip on the desk is a frame - but the
 * generator is forty lines and a LED wall is the one layout a frame generator
 * cannot express at all.
 */
export function matrixLayout (spec: MatrixLayoutSpec): LedRect[] {
  validateMatrix(spec)
  const { columns, rows } = spec
  const gap = spec.gap ?? {}
  const gapTop = gap.top ?? 0
  const gapRight = gap.right ?? 0
  const gapBottom = gap.bottom ?? 0
  const gapLeft = gap.left ?? 0
  const cellW = (1 - gapLeft - gapRight) / columns
  const cellH = (1 - gapTop - gapBottom) / rows

  const rects: LedRect[] = []
  const cell = (x: number, y: number): void => {
    rects.push({
      xMin: gapLeft + x * cellW,
      xMax: gapLeft + (x + 1) * cellW,
      yMin: gapTop + y * cellH,
      yMax: gapTop + (y + 1) * cellH
    })
  }

  // :509-516. The start corner names the first cell; the far corner is the
  // other end of both axes, and `snake` flips one axis after every line.
  const [startEdgeY, startEdgeX] = spec.start.split('-') as ['top' | 'bottom', 'left' | 'right']
  let fromX = startEdgeX === 'right' ? columns - 1 : 0
  let fromY = startEdgeY === 'bottom' ? rows - 1 : 0
  let toX = fromX === 0 ? columns - 1 : 0
  let toY = fromY === 0 ? rows - 1 : 0
  let forward = fromX < toX
  let downward = fromY < toY
  const snake = spec.cabling === 'snake'

  if (spec.direction === 'vertical') {
    for (let x = fromX; forward ? x <= toX : x >= toX; x += forward ? 1 : -1) {
      for (let y = fromY; downward ? y <= toY : y >= toY; y += downward ? 1 : -1) cell(x, y)
      if (snake) {
        downward = !downward
        ;[fromY, toY] = [toY, fromY]
      }
    }
  } else {
    for (let y = fromY; downward ? y <= toY : y >= toY; y += downward ? 1 : -1) {
      for (let x = fromX; forward ? x <= toX : x >= toX; x += forward ? 1 : -1) cell(x, y)
      if (snake) {
        forward = !forward
        ;[fromX, toX] = [toX, fromX]
      }
    }
  }
  return rects
}

// ---------------------------------------------------------------------------
// Blacklist.
// ---------------------------------------------------------------------------

/** `length` LEDs from wire index `start` that must never light. */
export interface BlacklistRange {
  start: number
  length: number
}

/** A LED that is wired but must stay dark: no area, so it samples black. */
export const DARK_RECT: Readonly<LedRect> = Object.freeze({ xMin: 0, xMax: 0, yMin: 0, yMax: 0 })

/**
 * Replaces the named LEDs with zero-area rectangles. Port of `blackListLeds`
 * (:574-599): the indices are wire indices and every other LED keeps its own,
 * because the position of a LED on the wire is a fact about the cable.
 *
 * Unlike Hyperion, a rule that names LEDs the strip does not have throws
 * instead of being skipped (:585) or truncated (:588): a blacklist exists to
 * make certain LEDs dark, and a rule that silently does nothing defeats it.
 */
export function applyBlacklist (rects: readonly LedRect[], ranges: readonly BlacklistRange[]): LedRect[] {
  const out = [...rects]
  for (const range of ranges) {
    if (!Number.isInteger(range.start) || range.start < 0 || range.start >= out.length) {
      throw new RangeError(`layout: blacklist start ${range.start} is outside a strip of ${out.length}`)
    }
    if (!Number.isInteger(range.length) || range.length < 1) {
      throw new RangeError(`layout: blacklist length must be a positive integer, got ${range.length}`)
    }
    if (range.start + range.length > out.length) {
      throw new RangeError(`layout: blacklist ${range.start}..${range.start + range.length - 1} is outside a strip of ${out.length}`)
    }
    for (let i = 0; i < range.length; i++) out[range.start + i] = DARK_RECT
  }
  return out
}

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------

function clampUnit (v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function mod (v: number, n: number): number {
  return ((v % n) + n) % n
}

function requireCount (name: string, n: number): void {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`layout: ${name} must be a non-negative integer, got ${n}`)
}

function requireFraction (name: string, v: number, max = 1): void {
  if (!(v >= 0 && v <= max)) throw new RangeError(`layout: ${name} must be in [0, ${max}], got ${v}`)
}

function validateClassic (spec: ClassicLayoutSpec): void {
  for (const edge of ['top', 'right', 'bottom', 'left'] as const) requireCount(edge, spec[edge])
  const total = ledCount(spec)
  if (total === 0) throw new RangeError('layout: at least one LED is required')

  for (const depth of ['depthTopBottom', 'depthLeftRight'] as const) {
    const d = spec[depth]
    if (!(d > 0 && d <= 0.5)) throw new RangeError(`layout: ${depth} must be in (0, 0.5], got ${d}`)
  }
  if (!CORNERS.includes(spec.start)) throw new RangeError(`layout: unknown start corner ${String(spec.start)}`)
  if (typeof spec.clockwise !== 'boolean') throw new TypeError(`layout: clockwise must be a boolean, got ${String(spec.clockwise)}`)

  if (spec.offset !== undefined && !Number.isInteger(spec.offset)) {
    throw new RangeError(`layout: offset must be an integer, got ${spec.offset}`)
  }
  if (spec.overlap !== undefined) requireFraction('overlap', spec.overlap, 0.5)
  if (spec.edgeGap !== undefined) requireFraction('edgeGap', spec.edgeGap, 0.25)
  if (spec.aspectRatio !== undefined && !(spec.aspectRatio > 0 && Number.isFinite(spec.aspectRatio))) {
    throw new RangeError(`layout: aspectRatio must be a positive finite number, got ${spec.aspectRatio}`)
  }
  if (spec.keystone !== undefined) {
    for (const corner of ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const) {
      const point = spec.keystone[corner]
      if (point === undefined) throw new RangeError(`layout: keystone is missing ${corner}`)
      requireFraction(`keystone.${corner}.x`, point.x)
      requireFraction(`keystone.${corner}.y`, point.y)
    }
  }

  const gap = spec.gap
  if (gap !== undefined) {
    if (!Number.isInteger(gap.position) || gap.position < 0 || gap.position >= total) {
      throw new RangeError(`layout: gap position must be an integer in 0..${total - 1}, got ${gap.position}`)
    }
    requireCount('gap length', gap.length)
    if (gap.position + gap.length > total) {
      throw new RangeError(`layout: gap ${gap.position}..${gap.position + gap.length - 1} runs past the ${total} LED positions`)
    }
    if (gap.length >= total) throw new RangeError(`layout: a gap of ${gap.length} leaves nothing of ${total} LED positions`)
  }

  // Each edge needs a step it can divide: two LEDs on an edge whose ends the
  // edge gaps have crossed would run backwards.
  const gapV = spec.edgeGap ?? LAYOUT_DEFAULTS.edgeGap
  const gapH = gapV / (spec.aspectRatio ?? LAYOUT_DEFAULTS.aspectRatio)
  if (2 * gapH >= 1 || 2 * gapV >= 1) {
    throw new RangeError(`layout: edgeGap ${gapV} leaves no edge to place LEDs along`)
  }
}

function validateMatrix (spec: MatrixLayoutSpec): void {
  for (const axis of ['columns', 'rows'] as const) {
    if (!Number.isInteger(spec[axis]) || spec[axis] < 1) {
      throw new RangeError(`layout: ${axis} must be a positive integer, got ${spec[axis]}`)
    }
  }
  if (spec.cabling !== 'snake' && spec.cabling !== 'parallel') {
    throw new RangeError(`layout: unknown cabling ${String(spec.cabling)}`)
  }
  if (spec.direction !== 'horizontal' && spec.direction !== 'vertical') {
    throw new RangeError(`layout: unknown direction ${String(spec.direction)}`)
  }
  if (!CORNERS.includes(spec.start)) throw new RangeError(`layout: unknown start corner ${String(spec.start)}`)

  const gap = spec.gap ?? {}
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const v = gap[side]
    if (v !== undefined) requireFraction(`gap.${side}`, v)
  }
  if ((gap.left ?? 0) + (gap.right ?? 0) >= 1) throw new RangeError('layout: the left and right gaps leave no width')
  if ((gap.top ?? 0) + (gap.bottom ?? 0) >= 1) throw new RangeError('layout: the top and bottom gaps leave no height')
}
