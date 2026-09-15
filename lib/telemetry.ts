/**
 * Turning a stream of samples into a line you can look at.
 *
 * The engine already reports everything worth knowing, and the device page
 * already shows it - as numbers, one instant at a time. That is enough to
 * answer "is it working" and no use at all for "it was fine and then it
 * wasn't", which is the question anyone actually has. A number that was 59 and
 * is now 41 looks exactly like a number that has always been 41.
 *
 * So: a small history in the panel, and a path to draw it with. No charting
 * library - the same reasoning as the sidebar glyphs. A dependency whose whole
 * job is to draw a polyline is a dependency to keep updated forever, and the
 * polyline is eleven lines of arithmetic.
 *
 * **What this cannot show, and the card says so.** Samples arrive about once a
 * second, because that is how often the engine reports. A stutter shorter than
 * that is invisible here and always will be - which is exactly why the engine
 * reports p99 and max of the inter-arrival rather than a mean, and why those
 * numbers sit beside the graph rather than being replaced by it.
 */

/** How many samples a track keeps: about two minutes at one a second. */
export const HISTORY_LIMIT = 120

/**
 * Appends a sample, dropping the oldest past the limit.
 *
 * Returns a NEW array rather than mutating: the caller is React state, and a
 * mutated array is a re-render that does not happen.
 */
export function pushSample (history: readonly number[], value: number, limit = HISTORY_LIMIT): number[] {
  // A non-finite sample is dropped rather than stored. One NaN in the history
  // makes the whole path NaN, and the graph disappears with no explanation -
  // and a report that arrived mid-restart can legitimately carry one.
  if (!Number.isFinite(value)) return history.slice(-limit)
  const next = [...history, value]
  return next.length <= limit ? next : next.slice(next.length - limit)
}

export interface SparklineOptions {
  width: number
  height: number
  /** Floor of the value axis. Default 0, because a rate that starts at 40 is not a rate that starts at 0. */
  min?: number
  /** Ceiling. Default the highest sample, so the line uses the whole box. */
  max?: number
}

export interface Sparkline {
  /** An SVG path, or null when there is nothing to draw. */
  d: string | null
  /** The axis actually used, for a label beside the graph. */
  min: number
  max: number
}

/**
 * An SVG path through the samples, oldest at the left.
 *
 * The value axis is padded to a non-zero span even when every sample is
 * identical: a constant 120 fps is the healthy case and it has to draw as a
 * flat line through the middle rather than as a division by zero.
 */
export function sparklinePath (values: readonly number[], options: SparklineOptions): Sparkline {
  const { width, height } = options
  const usable = values.filter((value) => Number.isFinite(value))
  if (usable.length === 0 || width <= 0 || height <= 0) {
    return { d: null, min: options.min ?? 0, max: options.max ?? 1 }
  }

  const low = options.min ?? 0
  const derivedHigh = Math.max(...usable)
  const high = options.max ?? derivedHigh
  let base = low
  let span = high - low

  if (span <= 0) {
    // An explicit min equal to the max, or an axis of nothing. Give the box a
    // span so the arithmetic is defined at all.
    base = low - 0.5
    span = 1
  } else if (options.max === undefined && Math.min(...usable) === derivedHigh) {
    // Every sample is identical AND the ceiling was derived from them, so "at
    // the top" would be an accident of the data rather than a fact about it -
    // a steady 120 and a steady 40 would draw the same line in the same place.
    // Centred reads as "steady", which is what it is.
    //
    // Only when the axis was derived: with a ceiling the caller chose, sitting
    // at it means something and the line belongs there.
    base = derivedHigh - 1
    span = 2
  }

  const step = usable.length === 1 ? 0 : width / (usable.length - 1)
  const points = usable.map((value, i) => {
    const x = usable.length === 1 ? width / 2 : i * step
    const clamped = Math.min(base + span, Math.max(base, value))
    // SVG's y grows downward, so a high value is a low y.
    const y = height - ((clamped - base) / span) * height
    return `${round(x)},${round(y)}`
  })

  // A single sample is a dot, which `L` to itself draws as nothing - so it gets
  // a short horizontal stroke instead of vanishing until the second report.
  const d = points.length === 1
    ? `M ${round(width / 2 - 2)},${points[0]?.split(',')[1] ?? '0'} L ${round(width / 2 + 2)},${points[0]?.split(',')[1] ?? '0'}`
    : `M ${points.join(' L ')}`

  return { d, min: base, max: base + span }
}

/** Two decimals is below anything an SVG renderer resolves; more is just bytes. */
function round (value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * The four processing stages as fractions of the budget, for a stacked bar.
 *
 * The budget is what one capture frame is allowed to cost before the pipeline
 * is the bottleneck rather than the screen. Reporting the stages against it
 * rather than against each other is the difference between "the downscale is
 * the biggest one" - which is always true and says nothing - and "the downscale
 * alone is most of the budget", which is a decision.
 */
export function stageShares (
  stages: { downscale: number, readback: number, decode: number, sample: number },
  budgetMs: number
): Array<{ key: 'downscale' | 'readback' | 'decode' | 'sample', ms: number, share: number }> {
  const budget = budgetMs > 0 ? budgetMs : 1
  return (['downscale', 'readback', 'decode', 'sample'] as const).map((key) => {
    const ms = Number.isFinite(stages[key]) ? Math.max(0, stages[key]) : 0
    return { key, ms, share: ms / budget }
  })
}
