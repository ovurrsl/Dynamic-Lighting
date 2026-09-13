import type { Border, LedColors, LedRect, LinearGrid, LinearRgb } from '#lib/engine/types'
import { NO_BORDER } from '#lib/engine/types'

/**
 * Image to LED colour: reduces one captured frame to one colour per LED.
 *
 * Port of Hyperion's ImageToLedsMap - libsrc/hyperion/ImageToLedsMap.cpp for
 * the index map and include/hyperion/ImageToLedsMap.h for the seven
 * reductions; bare `.cpp:line` and `.h:line` references below point into those
 * two files. The shape is Hyperion's: an index map built once per grid size
 * and border - for every LED, the list of pixel offsets its rectangle covers -
 * and a per-frame pass that reduces each list to a colour. The map is what
 * makes 108 LEDs at 120 Hz affordable: the per-frame work is one add per
 * channel per pixel, with no rectangle maths and no bounds checks.
 *
 * The grid is LINEAR light (lib/engine/types.ts), and that changes what the
 * simplest mode means. Hyperion averages sRGB bytes (.h:419-438), which is not
 * an average of light: a region half black and half white averages to sRGB
 * 127, about a fifth of the light actually on screen. Here the mean of the
 * linear values IS the area average - the colour a diffuser in front of that
 * region would produce - which is what Hyperion's "mean squared" mode
 * approximates from the wrong side (docs/hyperion-port-plan.md section 9).
 * That mode is ported for configuration compatibility and does nothing useful
 * on linear input; see `SampleMode`.
 *
 * Deviations from Hyperion, each deliberate and each pinned by a test in
 * test/engine-sample.test.ts that fails on the Hyperion behaviour:
 *
 * - Row stride. Pixel offsets are `y * width + x` with the FULL grid width.
 *   Hyperion uses the width of the border-reduced area (.cpp:96) while the
 *   image it indexes is still the full frame, so the moment a left/right
 *   border exists every row after the first is read from the wrong place and
 *   the sampled region drifts diagonally (defect #1, plan section 11).
 * - Modes are a string union. Hyperion maps the names to numbers
 *   (ImageProcessor.cpp:59-90) and dispatches on the numbers
 *   (ImageProcessor.h:142-164) with cases 1 and 2 swapped, so choosing "mean
 *   squared" in its UI runs the uniform mean and vice versa (defect #2).
 * - The large-region guard is reported, not logged. A region over 1600 pixels
 *   with no reduction requested is sampled at every second pixel (.cpp:83-88);
 *   Hyperion writes one log line about it (.cpp:108-111) that a user of the
 *   web UI never sees (defect #10). Here it lands in `warnings`, as does an
 *   out-of-range accuracy level (.cpp:134-144).
 * - `dominant` keys its histogram on 5-bit quantised linear channels.
 *   Hyperion keys on the exact 24-bit sRGB value (.h:586), which only finds a
 *   mode in flat content: a gradient or a dither spreads the votes over
 *   hundreds of keys and a tiny solid patch wins. 32 levels per channel pool
 *   the shades of one flat colour and still keep apart anything a LED could
 *   show apart. The returned colour is the mean of the winning bin, so flat
 *   content still comes back exactly.
 * - k-means stops when the centroids stop MOVING - largest move under 1/255 -
 *   or after 20 iterations. Hyperion stops when the largest move is within one
 *   step of the previous iteration's (.h:717), which a centroid walking in
 *   equal steps satisfies while still walking, and it has no cap (defect #6).
 *   Centroids are floats rather than the int-truncated means of .h:708, and an
 *   empty cluster keeps its centroid rather than being reset to black (.h:677).
 * - A border that leaves no picture is a RangeError in every build. Hyperion
 *   asserts it in debug builds only (.cpp:31-32) and indexes off the frame in
 *   release.
 *
 * Nothing here knows about time: the map depends on grid size, layout and
 * border only, and `sample` is a pure function of one frame.
 */

/**
 * The seven reductions, under Hyperion's names with the `multicolor_` and
 * `_color` noise removed (ImageProcessor.cpp:59-90).
 *
 * - `mean`: per-LED average of the region. In linear light this is the area
 *   average, and the mode to use.
 * - `meanSquared`: per-LED root mean square (.h:488-524). Hyperion offers it
 *   because RMS in sRGB is a cheap stand-in for "average in linear, re-encode"
 *   (plan section 9); applied to values that are already linear it merely
 *   over-weights the bright pixels. Ported for compatibility.
 * - `unicolorMean`: the mean of EVERY pixel of the grid on every LED. The
 *   index map, the border and the pixel-skip factor are all ignored, as in
 *   Hyperion (.h:449-476).
 * - `dominant`: the modal colour of each region (.h:572-605).
 * - `unicolorDominant`: the modal colour of the whole grid on every LED.
 * - `dominantAdvanced`: k-means over each region with `accuracyLevel + 1`
 *   clusters; the centroid of the most-populated cluster (.h:653-744).
 * - `unicolorDominantAdvanced`: the same over the whole grid on every LED.
 */
export type SampleMode =
  | 'mean'
  | 'meanSquared'
  | 'unicolorMean'
  | 'dominant'
  | 'unicolorDominant'
  | 'dominantAdvanced'
  | 'unicolorDominantAdvanced'

export const SAMPLE_MODES: readonly SampleMode[] = Object.freeze([
  'mean', 'meanSquared', 'unicolorMean', 'dominant', 'unicolorDominant', 'dominantAdvanced', 'unicolorDominantAdvanced'
])

export interface SamplerOptions {
  /** One rectangle per LED, in normalised screen coordinates (lib/engine/layout.ts). */
  layout: readonly LedRect[]
  /** The grid size the map is built for; `sample` rejects any other. */
  width: number
  height: number
  /**
   * 0..3: read every 1st, 2nd, 3rd or 4th pixel along both axes of every
   * region - Hyperion's reducedPixelSetFactorFactor, "disabled / low / medium
   * / high" (schema-color.json:31-41, .cpp:83). Default 0. A region over
   * `LARGE_REGION_PIXELS` is read at every 2nd pixel even at 0; see `warnings`.
   */
  reducedPixelSetFactor?: number
  /**
   * 0..4: `dominantAdvanced` runs `accuracyLevel + 1` clusters (.cpp:134-144).
   * Outside the range it is clamped and reported in `warnings`. Default 2.
   */
  accuracyLevel?: number
}

export interface Sampler {
  readonly width: number
  readonly height: number
  /** Number of LEDs; `sample` writes `count * 3` floats. */
  readonly count: number
  /**
   * What Hyperion logs: the large-region guard and a clamped accuracy level.
   * One array for the life of the sampler, rewritten by every rebuild - read
   * it after `setBorder`, not once at creation.
   */
  readonly warnings: readonly string[]
  /** The inset the map is currently built for; `unknown` is never set. */
  border (): Readonly<Border>
  /**
   * Rebuilds the index map for a new inset and says whether it did. An
   * unchanged border returns false at once, and a rebuild is arithmetic per
   * LED plus one write per covered pixel with no per-pixel allocation, so
   * the detector's result can be passed in every frame. An `unknown` border
   * means no border, as in Hyperion (ImageProcessor.h:264-268). A border
   * that leaves no picture (`2 * inset >= size` on either axis) is a
   * RangeError.
   */
  setBorder (border: Readonly<Border>): boolean
  /**
   * Reduces one frame into `out` and returns it. The `mean` and `meanSquared`
   * paths allocate nothing; the dominant modes allocate their scratch once,
   * on first use.
   */
  sample (grid: LinearGrid, out: LedColors, mode: SampleMode): LedColors
  /**
   * The pixel offsets (`y * width + x`) LED `led` reads, in row-major order.
   * A view into the map, valid until the next rebuild. For tests and
   * diagnostics; the sampler does not need anyone to look.
   */
  pixelIndices (led: number): Int32Array
}

export const SAMPLER_DEFAULTS = Object.freeze({
  reducedPixelSetFactor: 0,
  accuracyLevel: 2
})

/** .cpp:84: a region above this many pixels is read at every second pixel unless a reduction was asked for. */
export const LARGE_REGION_PIXELS = 1600

/** .cpp:136: the highest accuracy level, five clusters - one per seed. */
export const MAX_ACCURACY_LEVEL = 4

/**
 * k-means stops once no centroid moved further than this in linear rgb. One
 * 8-bit step, Hyperion's unit (.h:717) - below it the LED cannot show the
 * difference, so another iteration would be work for nothing.
 */
export const KMEANS_CONVERGENCE = 1 / 255

/**
 * Hyperion has no cap (.h:671). Lloyd's algorithm converges in finitely many
 * steps, but "finitely" is not a frame budget; 20 is far more than flat or
 * two-tone content needs and bounds the worst case at 120 Hz.
 */
export const KMEANS_MAX_ITERATIONS = 20

/**
 * .h:637-641, DEFAULT_CLUSTER_COLORS, in Hyperion's order: `accuracyLevel + 1`
 * of them are used, from the front. They are corners of the RGB cube, so they
 * are the same points in linear light as in sRGB and need no conversion.
 */
export const CLUSTER_SEEDS: readonly Readonly<LinearRgb>[] = Object.freeze([
  Object.freeze({ r: 0, g: 0, b: 0 }),
  Object.freeze({ r: 0, g: 1, b: 0 }),
  Object.freeze({ r: 1, g: 1, b: 1 }),
  Object.freeze({ r: 1, g: 0, b: 0 }),
  Object.freeze({ r: 1, g: 1, b: 0 })
])

/** Levels per channel for the `dominant` histogram: 5 bits, 32^3 bins. */
export const DOMINANT_LEVELS = 32

export function createSampler (options: SamplerOptions): Sampler {
  return new LedSampler(options)
}

// ---------------------------------------------------------------------------
// Implementation.
// ---------------------------------------------------------------------------

/** How many forced-skip LEDs a warning names before it says "and more". */
const NAMED_LEDS_IN_WARNING = 8

class LedSampler implements Sampler {
  readonly width: number
  readonly height: number
  readonly count: number
  readonly warnings: string[] = []

  private readonly rects: readonly Readonly<LedRect>[]
  /** Pixels stepped along each axis: reducedPixelSetFactor + 1 (.cpp:83). */
  private readonly step: number
  private readonly clusterCount: number
  /** How many leading entries of `warnings` were produced at construction and survive every rebuild. */
  private readonly fixedWarnings: number
  private currentBorder: Readonly<Border> = NO_BORDER

  /** `starts[led] .. starts[led + 1]` is LED `led`'s slice of `indices`. */
  private readonly starts: Int32Array
  /** Every LED's pixel offsets back to back. Grows when a rebuild needs more, never shrinks. */
  private indices = new Int32Array(0)
  /** Rebuild scratch, five ints per LED: minX, endX, minY, endY, step. */
  private readonly bounds: Int32Array
  /** Rebuild scratch: the first few LEDs the large-region guard fired on. */
  private readonly forced = new Int32Array(NAMED_LEDS_IN_WARNING)

  // Scratch for the modes that need it, allocated on first use so a sampler
  // that only ever runs `mean` pays for none of it.
  /** The identity map 0..width*height-1: the "region" of the unicolor modes. */
  private wholeGrid: Int32Array | null = null
  /** 32^3 bin counts for `dominant`, zero between calls. */
  private histogram: Int32Array | null = null
  /** The bin of each pixel of the region in hand, so the winning bin can be averaged and the histogram cleared without recomputing keys. */
  private keys: Int32Array | null = null
  private readonly centroids = new Float64Array(CLUSTER_SEEDS.length * 3)
  private readonly sums = new Float64Array(CLUSTER_SEEDS.length * 3)
  private readonly members = new Int32Array(CLUSTER_SEEDS.length)

  constructor (options: SamplerOptions) {
    const { width, height, layout } = options
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError(`sample: grid must be at least 1x1, got ${width}x${height}`)
    }
    this.width = width
    this.height = height
    this.rects = layout.map(validateRect)
    this.count = this.rects.length

    const factor = options.reducedPixelSetFactor ?? SAMPLER_DEFAULTS.reducedPixelSetFactor
    if (!Number.isInteger(factor) || factor < 0 || factor > 3) {
      throw new RangeError(`sample: reducedPixelSetFactor must be an integer in 0..3, got ${factor}`)
    }
    this.step = factor + 1

    // .cpp:134-144 clamps the top end and logs; the bottom end is unchecked
    // there and would allocate zero clusters (.h:661) and index cluster -1.
    let accuracy = options.accuracyLevel ?? SAMPLER_DEFAULTS.accuracyLevel
    if (!Number.isInteger(accuracy)) throw new RangeError(`sample: accuracyLevel must be an integer, got ${accuracy}`)
    if (accuracy > MAX_ACCURACY_LEVEL) {
      this.warnings.push(`sample: accuracyLevel ${accuracy} is above the maximum ${MAX_ACCURACY_LEVEL}; using ${MAX_ACCURACY_LEVEL}`)
      accuracy = MAX_ACCURACY_LEVEL
    } else if (accuracy < 0) {
      this.warnings.push(`sample: accuracyLevel ${accuracy} is below 0; using 0`)
      accuracy = 0
    }
    this.clusterCount = accuracy + 1
    this.fixedWarnings = this.warnings.length

    this.starts = new Int32Array(this.count + 1)
    this.bounds = new Int32Array(this.count * 5)
    this.rebuild(0, 0)
  }

  border (): Readonly<Border> {
    return this.currentBorder
  }

  setBorder (border: Readonly<Border>): boolean {
    const leftRight = border.unknown ? 0 : border.leftRight
    const topBottom = border.unknown ? 0 : border.topBottom
    if (!Number.isInteger(leftRight) || !Number.isInteger(topBottom) || leftRight < 0 || topBottom < 0) {
      throw new RangeError(`sample: border insets must be non-negative integers, got ${leftRight}/${topBottom}`)
    }
    // .cpp:31-32, as a check that exists in release builds too. The detector
    // never probes past a third of either axis, so this is a caller bug.
    if (2 * leftRight >= this.width || 2 * topBottom >= this.height) {
      throw new RangeError(`sample: border ${leftRight}/${topBottom} leaves no picture on a ${this.width}x${this.height} grid`)
    }
    if (leftRight === this.currentBorder.leftRight && topBottom === this.currentBorder.topBottom) return false
    this.rebuild(leftRight, topBottom)
    return true
  }

  pixelIndices (led: number): Int32Array {
    if (!Number.isInteger(led) || led < 0 || led >= this.count) throw new RangeError(`sample: no LED ${led} in a layout of ${this.count}`)
    return this.indices.subarray(this.starts[led]!, this.starts[led + 1]!)
  }

  sample (grid: LinearGrid, out: LedColors, mode: SampleMode): LedColors {
    const { width, height, count } = this
    if (grid.width !== width || grid.height !== height) {
      throw new RangeError(`sample: grid is ${grid.width}x${grid.height}, the map was built for ${width}x${height}`)
    }
    if (grid.data.length < width * height * 3) {
      throw new RangeError(`sample: grid data holds ${grid.data.length} floats, ${width}x${height} needs ${width * height * 3}`)
    }
    if (out.length < count * 3) throw new RangeError(`sample: out holds ${out.length} floats, ${count} LEDs need ${count * 3}`)

    const data = grid.data
    const starts = this.starts
    const indices = this.indices
    switch (mode) {
      case 'mean':
        for (let led = 0; led < count; led++) this.meanInto(data, indices, starts[led]!, starts[led + 1]!, out, led * 3)
        break
      case 'meanSquared':
        for (let led = 0; led < count; led++) this.meanSquaredInto(data, indices, starts[led]!, starts[led + 1]!, out, led * 3)
        break
      case 'dominant':
        for (let led = 0; led < count; led++) this.dominantInto(data, indices, starts[led]!, starts[led + 1]!, out, led * 3)
        break
      case 'dominantAdvanced':
        for (let led = 0; led < count; led++) this.kMeansInto(data, indices, starts[led]!, starts[led + 1]!, out, led * 3)
        break
      case 'unicolorMean': {
        const all = this.allPixels()
        this.meanInto(data, all, 0, all.length, out, 0)
        fillFromFirst(out, count)
        break
      }
      case 'unicolorDominant': {
        const all = this.allPixels()
        this.dominantInto(data, all, 0, all.length, out, 0)
        fillFromFirst(out, count)
        break
      }
      case 'unicolorDominantAdvanced': {
        const all = this.allPixels()
        this.kMeansInto(data, all, 0, all.length, out, 0)
        fillFromFirst(out, count)
        break
      }
      default:
        throw new RangeError(`sample: unknown mode ${String(mode)}`)
    }
    return out
  }

  /**
   * Port of the constructor's index loop (.cpp:39-111), run again for every
   * border. Two passes: the first computes each LED's pixel box and the size
   * of the map, the second fills it, so the one buffer grows at most once
   * per size and there is nothing to allocate per pixel.
   */
  private rebuild (leftRight: number, topBottom: number): void {
    const { width, height, count, rects, starts, bounds, forced } = this
    this.warnings.length = this.fixedWarnings
    this.currentBorder = Object.freeze({ unknown: false, leftRight, topBottom })

    // .cpp:39-42. Hyperion calls the left/right inset `verticalBorder`
    // (types.ts explains why the names were dropped).
    const xOffset = leftRight
    const activeW = width - 2 * leftRight
    const yOffset = topBottom
    const activeH = height - 2 * topBottom

    let total = 0
    let forcedCount = 0
    for (let led = 0; led < count; led++) {
      const rect = rects[led]!
      const b = led * 5
      // .cpp:51-55: a rectangle without area maps to no pixels, and samples black.
      if (rect.xMax - rect.xMin < 1e-6 || rect.yMax - rect.yMin < 1e-6) {
        bounds[b] = 0
        bounds[b + 1] = 0
        bounds[b + 2] = 0
        bounds[b + 3] = 0
        bounds[b + 4] = 1
        continue
      }

      // .cpp:58-61. Math.round and qRound agree on non-negative input: both
      // take .5 upwards.
      let minX = xOffset + Math.round(activeW * rect.xMin)
      let maxX = xOffset + Math.round(activeW * rect.xMax)
      let minY = yOffset + Math.round(activeH * rect.yMin)
      let maxY = yOffset + Math.round(activeH * rect.yMax)

      // .cpp:63-73: a rectangle thinner than a pixel still gets one pixel,
      // and a min that rounded onto the far edge is pulled back inside.
      minX = Math.min(minX, xOffset + activeW - 1)
      if (minX === maxX) maxX++
      minY = Math.min(minY, yOffset + activeH - 1)
      if (minY === maxY) maxY++

      // .cpp:76-77: the exclusive ends, kept inside the active area.
      const endX = Math.min(maxX, xOffset + activeW)
      const endY = Math.min(maxY, yOffset + activeH)

      // .cpp:79-88: the guard. Ours is the same rule with a record kept.
      let step = this.step
      if (step === 1 && (endY - minY) * (endX - minX) > LARGE_REGION_PIXELS) {
        step = 2
        if (forcedCount < forced.length) forced[forcedCount] = led
        forcedCount++
      }

      bounds[b] = minX
      bounds[b + 1] = endX
      bounds[b + 2] = minY
      bounds[b + 3] = endY
      bounds[b + 4] = step
      total += Math.ceil((endY - minY) / step) * Math.ceil((endX - minX) / step)
    }

    if (total > this.indices.length) this.indices = new Int32Array(total)
    const indices = this.indices
    let n = 0
    for (let led = 0; led < count; led++) {
      const b = led * 5
      const minX = bounds[b]!
      const endX = bounds[b + 1]!
      const endY = bounds[b + 3]!
      const step = bounds[b + 4]!
      starts[led] = n
      // .cpp:92-98, with the stride that matches the buffer. Hyperion's
      // `y * actualWidth + x` is defect #1: correct only while there is no
      // left/right border, which is exactly when the map is not rebuilt.
      for (let y = bounds[b + 2]!; y < endY; y += step) {
        for (let x = minX; x < endX; x += step) indices[n++] = y * width + x
      }
    }
    starts[count] = n

    if (forcedCount > 0) {
      const named = Array.from(forced.subarray(0, Math.min(forcedCount, forced.length))).join(', ')
      const more = forcedCount > forced.length ? ` and ${forcedCount - forced.length} more` : ''
      this.warnings.push(
        `sample: ${forcedCount} LED region(s) exceed ${LARGE_REGION_PIXELS} pixels (LED ${named}${more}); ` +
        'every 2nd pixel is skipped for them. Set reducedPixelSetFactor to choose the reduction yourself.'
      )
    }
  }

  private allPixels (): Int32Array {
    if (this.wholeGrid === null) {
      const all = new Int32Array(this.width * this.height)
      for (let i = 0; i < all.length; i++) all[i] = i
      this.wholeGrid = all
    }
    return this.wholeGrid
  }

  /**
   * .h:409-439 in floats. The float sum of linear values divided by the count
   * is the area average of the light; Hyperion's `uint8_t(cumm / pixelNum)`
   * truncates, and its accumulator is wide enough only for regions under
   * about 16 million pixels (defect #5 is the squared variant, which is not).
   */
  private meanInto (data: Float32Array, idx: Int32Array, from: number, to: number, out: LedColors, o: number): void {
    const n = to - from
    if (n === 0) {
      black(out, o)
      return
    }
    let r = 0
    let g = 0
    let b = 0
    for (let i = from; i < to; i++) {
      const p = idx[i]! * 3
      r += data[p]!
      g += data[p + 1]!
      b += data[p + 2]!
    }
    out[o] = r / n
    out[o + 1] = g / n
    out[o + 2] = b / n
  }

  /**
   * .h:488-524: root of the mean of the squares, per channel. Hyperion divides
   * the integer sum before the sqrt and overflows a 32-bit accumulator past
   * ~66 000 pixels (.h:508, .h:518; defect #5); floats have neither problem.
   * On linear input the result is simply biased towards the bright pixels.
   */
  private meanSquaredInto (data: Float32Array, idx: Int32Array, from: number, to: number, out: LedColors, o: number): void {
    const n = to - from
    if (n === 0) {
      black(out, o)
      return
    }
    let r = 0
    let g = 0
    let b = 0
    for (let i = from; i < to; i++) {
      const p = idx[i]! * 3
      const pr = data[p]!
      const pg = data[p + 1]!
      const pb = data[p + 2]!
      r += pr * pr
      g += pg * pg
      b += pb * pb
    }
    out[o] = Math.sqrt(r / n)
    out[o + 1] = Math.sqrt(g / n)
    out[o + 2] = Math.sqrt(b / n)
  }

  /**
   * .h:572-605 on quantised keys. Three passes over the region: count the
   * bins and find the winner, average the pixels that fell into it, zero
   * the touched bins. The histogram stays allocated and zero between calls,
   * which is what makes the clear cost O(region) rather than O(32^3).
   */
  private dominantInto (data: Float32Array, idx: Int32Array, from: number, to: number, out: LedColors, o: number): void {
    const n = to - from
    if (n === 0) {
      black(out, o)
      return
    }
    const histogram = (this.histogram ??= new Int32Array(DOMINANT_LEVELS * DOMINANT_LEVELS * DOMINANT_LEVELS))
    const keys = (this.keys ??= new Int32Array(this.width * this.height))

    // .h:596-601: strictly greater, so the first bin to reach a count keeps
    // the lead over a later bin that only ties it.
    let best = 0
    let bestCount = 0
    for (let i = from; i < to; i++) {
      const p = idx[i]! * 3
      const key = (quantise(data[p]!) << 10) | (quantise(data[p + 1]!) << 5) | quantise(data[p + 2]!)
      keys[i - from] = key
      const c = histogram[key]! + 1
      histogram[key] = c
      if (c > bestCount) {
        bestCount = c
        best = key
      }
    }

    let r = 0
    let g = 0
    let b = 0
    for (let i = from; i < to; i++) {
      if (keys[i - from] !== best) continue
      const p = idx[i]! * 3
      r += data[p]!
      g += data[p + 1]!
      b += data[p + 2]!
    }
    out[o] = r / bestCount
    out[o + 1] = g / bestCount
    out[o + 2] = b / bestCount

    for (let i = 0; i < n; i++) histogram[keys[i]!] = 0
  }

  /**
   * .h:653-744, Lloyd's k-means from fixed seeds. Per iteration: assign every
   * pixel to the nearest centroid, move every populated centroid to the mean
   * of its pixels, stop when the largest move is under `KMEANS_CONVERGENCE`
   * or the cap is reached. The answer is the centroid of the most-populated
   * cluster after the last update, which is what Hyperion returns too
   * (.h:725-740).
   */
  private kMeansInto (data: Float32Array, idx: Int32Array, from: number, to: number, out: LedColors, o: number): void {
    if (from === to) {
      black(out, o)
      return
    }
    const k = this.clusterCount
    const c = this.centroids
    const s = this.sums
    const m = this.members
    for (let j = 0; j < k; j++) {
      const seed = CLUSTER_SEEDS[j]!
      c[j * 3] = seed.r
      c[j * 3 + 1] = seed.g
      c[j * 3 + 2] = seed.b
    }

    let dominant = 0
    for (let iteration = 0; iteration < KMEANS_MAX_ITERATIONS; iteration++) {
      s.fill(0, 0, k * 3)
      m.fill(0, 0, k)

      // .h:681-700. Squared distance orders the same as Hyperion's Euclidean
      // (ColorSys.h:110-118) and skips a sqrt per pixel per cluster; ties go
      // to the lower-indexed cluster there and here (.h:691, strict <).
      for (let i = from; i < to; i++) {
        const p = idx[i]! * 3
        const r = data[p]!
        const g = data[p + 1]!
        const b = data[p + 2]!
        let best = 0
        let bestDistance = Infinity
        for (let j = 0; j < k; j++) {
          const dr = r - c[j * 3]!
          const dg = g - c[j * 3 + 1]!
          const db = b - c[j * 3 + 2]!
          const distance = dr * dr + dg * dg + db * db
          if (distance < bestDistance) {
            bestDistance = distance
            best = j
          }
        }
        s[best * 3] = s[best * 3]! + r
        s[best * 3 + 1] = s[best * 3 + 1]! + g
        s[best * 3 + 2] = s[best * 3 + 2]! + b
        m[best] = m[best]! + 1
      }

      // .h:702-715, with the movement itself as the stopping quantity. An
      // empty cluster stays where it is: Hyperion leaves it at the black it
      // zeroed the accumulator to (.h:677), which next iteration puts a
      // second centroid on the black seed's spot.
      let maxMove = 0
      dominant = 0
      for (let j = 0; j < k; j++) {
        const n = m[j]!
        if (n === 0) continue
        const nr = s[j * 3]! / n
        const ng = s[j * 3 + 1]! / n
        const nb = s[j * 3 + 2]! / n
        const dr = nr - c[j * 3]!
        const dg = ng - c[j * 3 + 1]!
        const db = nb - c[j * 3 + 2]!
        const move = Math.sqrt(dr * dr + dg * dg + db * db)
        if (move > maxMove) maxMove = move
        c[j * 3] = nr
        c[j * 3 + 1] = ng
        c[j * 3 + 2] = nb
        // .h:728-736: strictly greater, first cluster wins a tie.
        if (n > m[dominant]!) dominant = j
      }
      if (maxMove < KMEANS_CONVERGENCE) break
    }

    out[o] = c[dominant * 3]!
    out[o + 1] = c[dominant * 3 + 1]!
    out[o + 2] = c[dominant * 3 + 2]!
  }
}

/** 0..1 -> 0..31, the bin centres at k/31 so 0 and 1 sit on centres. Out-of-range input lands in the end bins. */
function quantise (v: number): number {
  return v <= 0 ? 0 : v >= 1 ? DOMINANT_LEVELS - 1 : Math.round(v * (DOMINANT_LEVELS - 1))
}

function black (out: LedColors, o: number): void {
  out[o] = 0
  out[o + 1] = 0
  out[o + 2] = 0
}

/** The unicolor modes: LED 0 holds the answer, every other LED gets a copy (.h:212, std::fill). */
function fillFromFirst (out: LedColors, count: number): void {
  const r = out[0]!
  const g = out[1]!
  const b = out[2]!
  for (let led = 1; led < count; led++) {
    out[led * 3] = r
    out[led * 3 + 1] = g
    out[led * 3 + 2] = b
  }
}

/**
 * Rectangles must lie in the unit square so every computed index is inside
 * the grid; nothing in `sample` checks bounds. An inverted rectangle is not
 * an error: it has no area and maps to no pixels, as in Hyperion (.cpp:51).
 */
function validateRect (rect: LedRect, led: number): Readonly<LedRect> {
  for (const edge of ['xMin', 'xMax', 'yMin', 'yMax'] as const) {
    const v = rect[edge]
    if (!(v >= 0 && v <= 1)) throw new RangeError(`sample: LED ${led} ${edge} must be in [0, 1], got ${v}`)
  }
  return Object.freeze({ xMin: rect.xMin, xMax: rect.xMax, yMin: rect.yMin, yMax: rect.yMax })
}
