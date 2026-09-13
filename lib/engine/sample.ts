import type { Border, LedColors, LedRect, LinearGrid } from '#lib/engine/types'
import { NO_BORDER, allocLedColors } from '#lib/engine/types'

/**
 * Sampling: one colour per LED from the downscaled, linear-light grid.
 *
 * Port of Hyperion's ImageToLedsMap (libsrc/hyperion/ImageToLedsMap.cpp and
 * include/hyperion/ImageToLedsMap.h; bare `cpp:`/`h:` references below point
 * into those files). The shape is the same - rectangles in normalised
 * coordinates are resolved to grid pixel ranges once, and every frame is a
 * plain box average over those ranges - and so is the rounding, so that a
 * layout tuned against Hyperion lands on the same pixels here.
 *
 * Where it departs, on purpose:
 *
 * - The grid is LINEAR light (see lib/engine/types.ts), so the mean here is a
 *   mean of light. Hyperion averages sRGB bytes and offers `mean_squared`
 *   (h:calcMeanColorSqrt, sqrt of the mean of squares) as a cheap gamma-2
 *   approximation of exactly this; neither is needed once the input is linear.
 *   There is one mode, and it is the physically right one.
 * - Sums are doubles, not `uint_fast32_t`, and the result is a float, not a
 *   truncated byte (h:calcMeanColor truncates twice: the integer division and
 *   the uint8 cast). A region of 12 pixels reading 255,255,...,254 is 254.9,
 *   not 254. This also removes the plan's defect #5 (section 11): the squared
 *   sum that overflows 32 bits at ~66 000 pixels.
 * - Ranges, not index lists. Hyperion stores every pixel index of every LED
 *   (`_colorsMap`, cpp:88-98) because it strides through huge source images
 *   (`reducedPixelSetFactor`, and defect #10: a silent every-second-pixel
 *   skip above 1600). Our grid is 128x72 and a LED sees ~30 cells; four
 *   integers per LED and two nested loops read every pixel, in order.
 * - The border is applied as an inset to the ranges, as in Hyperion, but the
 *   pixel address is `y * width + x` on the FULL grid. Hyperion computes
 *   `y * actualWidth + x` (cpp:96) with border-offset x and y - defect #1,
 *   the one that drags every sampled region diagonally the moment a side
 *   border is detected. The centre test in test/engine-sample.test.ts runs
 *   with a side border for exactly that reason.
 */

/** One LED's pixel range on the grid. `x1`/`y1` are exclusive; `x0 === x1` means no area. */
export interface LedRegion {
  readonly x0: number
  readonly x1: number
  readonly y0: number
  readonly y1: number
}

export interface SamplerOptions {
  /** Grid size the sampler is built for; a frame of another size is rejected. */
  width: number
  height: number
  border?: Readonly<Border>
}

export interface Sampler {
  readonly width: number
  readonly height: number
  readonly count: number
  /** The border the ranges are currently built for. */
  border (): Readonly<Border>
  /**
   * Re-resolves the ranges for a new border. Returns whether anything was
   * rebuilt; an equal border (or an unknown one, which insets nothing) is a
   * no-op so the caller can pass the detector's output every frame.
   */
  setBorder (border: Readonly<Border>): boolean
  /** The resolved ranges, in LED order. Rebuilt only by setBorder. */
  regions (): readonly LedRegion[]
  /**
   * Averages each LED's region of `grid` into `out` (allocated when absent).
   * A LED without area reads black, as Hyperion's empty index list does
   * (h:calcMeanColor returns BLACK for zero pixels).
   */
  sample (grid: LinearGrid, out?: LedColors): LedColors
}

/** Below this normalised extent a rectangle has no area (cpp:53). */
const MIN_EXTENT = 1e-6

export function createSampler (rects: readonly LedRect[], options: SamplerOptions): Sampler {
  return new BoxSampler(rects, options)
}

/**
 * Resolves normalised rectangles to grid pixel ranges, Hyperion's way
 * (cpp:40-85): the picture inside the border is `actualWidth` wide, a
 * rectangle's edges are `round(actualWidth * frac)` from the border offset, and
 * every LED with area gets at least one pixel even when its rectangle is
 * narrower than a cell. Returns `count * 4` integers, x0 x1 y0 y1 per LED.
 */
export function resolveRegions (rects: readonly LedRect[], width: number, height: number, border: Readonly<Border> = NO_BORDER): Int32Array {
  validateGridSize(width, height)
  const inset = effectiveInset(border, width, height)
  const xOffset = inset.leftRight
  const yOffset = inset.topBottom
  const actualWidth = width - 2 * xOffset
  const actualHeight = height - 2 * yOffset

  const regions = new Int32Array(rects.length * 4)
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i] as LedRect
    validateRect(rect, i)
    if (rect.xMax - rect.xMin < MIN_EXTENT || rect.yMax - rect.yMin < MIN_EXTENT) continue

    let x0 = xOffset + Math.round(actualWidth * rect.xMin)
    let x1 = xOffset + Math.round(actualWidth * rect.xMax)
    let y0 = yOffset + Math.round(actualHeight * rect.yMin)
    let y1 = yOffset + Math.round(actualHeight * rect.yMax)

    // At least one pixel (cpp:64-72): pull the start inside the picture, and
    // if rounding collapsed the range, open it by one.
    if (x0 > xOffset + actualWidth - 1) x0 = xOffset + actualWidth - 1
    if (x0 === x1) x1++
    if (y0 > yOffset + actualHeight - 1) y0 = yOffset + actualHeight - 1
    if (y0 === y1) y1++

    // Never past the picture (cpp:75-76).
    if (x1 > xOffset + actualWidth) x1 = xOffset + actualWidth
    if (y1 > yOffset + actualHeight) y1 = yOffset + actualHeight

    regions[i * 4] = x0
    regions[i * 4 + 1] = x1
    regions[i * 4 + 2] = y0
    regions[i * 4 + 3] = y1
  }
  return regions
}

class BoxSampler implements Sampler {
  readonly width: number
  readonly height: number
  readonly count: number
  private readonly rects: readonly LedRect[]
  private current: Readonly<Border>
  private ranges: Int32Array
  private views: readonly LedRegion[] | null = null

  constructor (rects: readonly LedRect[], options: SamplerOptions) {
    this.width = options.width
    this.height = options.height
    this.count = rects.length
    this.rects = rects.map((r) => ({ xMin: r.xMin, xMax: r.xMax, yMin: r.yMin, yMax: r.yMax }))
    this.current = options.border ?? NO_BORDER
    this.ranges = resolveRegions(this.rects, this.width, this.height, this.current)
  }

  border (): Readonly<Border> {
    return this.current
  }

  setBorder (border: Readonly<Border>): boolean {
    const next = effectiveInset(border, this.width, this.height)
    const prev = effectiveInset(this.current, this.width, this.height)
    if (next.topBottom === prev.topBottom && next.leftRight === prev.leftRight) {
      this.current = border
      return false
    }
    this.ranges = resolveRegions(this.rects, this.width, this.height, border)
    this.views = null
    this.current = border
    return true
  }

  regions (): readonly LedRegion[] {
    if (this.views === null) {
      const views: LedRegion[] = []
      for (let i = 0; i < this.count; i++) {
        views.push(Object.freeze({
          x0: this.ranges[i * 4] as number,
          x1: this.ranges[i * 4 + 1] as number,
          y0: this.ranges[i * 4 + 2] as number,
          y1: this.ranges[i * 4 + 3] as number
        }))
      }
      this.views = Object.freeze(views)
    }
    return this.views
  }

  sample (grid: LinearGrid, out: LedColors = allocLedColors(this.count)): LedColors {
    const { width, height, count, ranges } = this
    if (grid.width !== width || grid.height !== height) {
      throw new RangeError(`sample: grid is ${grid.width}x${grid.height}, sampler was built for ${width}x${height}`)
    }
    if (grid.data.length < width * height * 3) {
      throw new RangeError(`sample: grid data has ${grid.data.length} floats, ${width * height * 3} needed`)
    }
    if (out.length < count * 3) {
      throw new RangeError(`sample: output holds ${out.length} floats, ${count * 3} needed`)
    }

    const data = grid.data
    const stride = width * 3
    for (let i = 0; i < count; i++) {
      const x0 = ranges[i * 4] as number
      const x1 = ranges[i * 4 + 1] as number
      const y0 = ranges[i * 4 + 2] as number
      const y1 = ranges[i * 4 + 3] as number
      const cells = (x1 - x0) * (y1 - y0)
      if (cells <= 0) {
        out[i * 3] = 0
        out[i * 3 + 1] = 0
        out[i * 3 + 2] = 0
        continue
      }
      let r = 0
      let g = 0
      let b = 0
      for (let y = y0; y < y1; y++) {
        let at = y * stride + x0 * 3
        for (let x = x0; x < x1; x++) {
          r += data[at] as number
          g += data[at + 1] as number
          b += data[at + 2] as number
          at += 3
        }
      }
      out[i * 3] = r / cells
      out[i * 3 + 1] = g / cells
      out[i * 3 + 2] = b / cells
    }
    return out
  }
}

/**
 * The inset a border actually applies. An unknown border (nothing but black on
 * the probed lines) insets nothing: the detector reports zero sizes for it and
 * this makes that explicit rather than relied upon.
 */
function effectiveInset (border: Readonly<Border>, width: number, height: number): { topBottom: number, leftRight: number } {
  if (border.unknown) return { topBottom: 0, leftRight: 0 }
  const { topBottom, leftRight } = border
  if (!Number.isInteger(topBottom) || topBottom < 0 || !Number.isInteger(leftRight) || leftRight < 0) {
    throw new RangeError(`sample: border sizes must be non-negative integers, got ${topBottom}/${leftRight}`)
  }
  // Hyperion asserts these (cpp:30-31); a border that leaves no picture is a
  // detector bug, not a condition to survive.
  if (width <= 2 * leftRight || height <= 2 * topBottom) {
    throw new RangeError(`sample: border ${topBottom}/${leftRight} leaves nothing of a ${width}x${height} grid`)
  }
  return { topBottom, leftRight }
}

function validateGridSize (width: number, height: number): void {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError(`sample: grid size must be positive integers, got ${width}x${height}`)
  }
}

function validateRect (rect: LedRect, index: number): void {
  for (const edge of ['xMin', 'xMax', 'yMin', 'yMax'] as const) {
    const v = rect[edge]
    if (!(v >= 0 && v <= 1)) throw new RangeError(`sample: LED ${index} ${edge} must be in [0, 1], got ${v}`)
  }
}
