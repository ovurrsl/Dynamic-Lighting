/**
 * Frame arrival measurement: delivered rate and inter-arrival percentiles.
 *
 * The plan's rule for every rate the engine reports: count frames and report
 * p50/p99 of the gap between them, and never trust `getSettings().frameRate`
 * or an average. The mean of the inter-arrival hides exactly the stalls a
 * bias light makes visible - ten smooth frames and one 100 ms freeze average
 * to a fine number and look terrible.
 *
 * A "gap" is one inter-arrival longer than `gapMs`; it is counted for ever,
 * while the rate and the percentiles describe only the recent window.
 */

export interface ArrivalMeterOptions {
  /** How much history the rate and percentiles cover. Default 2000. */
  windowMs?: number
  /** An inter-arrival above this is a gap. Default 50 (six frames at 120 Hz). */
  gapMs?: number
  /** Most arrivals remembered. Default 1024 (8.5 s at 120 Hz). */
  capacity?: number
}

export interface ArrivalSnapshot {
  /** Arrivals in the window divided by the time they span; 0 with fewer than two. */
  fps: number
  /** Percentiles of the inter-arrival in the window, ms; 0 with fewer than two arrivals. */
  p50: number
  p99: number
  max: number
  /** Arrivals in the window. */
  samples: number
  /** Inter-arrivals above gapMs since creation or reset. */
  gaps: number
  /** Arrivals since creation or reset. */
  total: number
}

export interface ArrivalMeter {
  /** Records an arrival at `now` (ms, monotonic). */
  mark (now: number): void
  snapshot (now: number): ArrivalSnapshot
  reset (): void
}

export interface ValueSnapshot {
  p50: number
  p99: number
  max: number
  samples: number
}

/** Percentiles over the last `capacity` values of anything: processing time, queue depth. */
export interface ValueMeter {
  add (value: number): void
  snapshot (): ValueSnapshot
  reset (): void
}

export function createValueMeter (capacity = 256): ValueMeter {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`stats: capacity must be a positive integer, got ${capacity}`)
  const values = new Float64Array(capacity)
  const scratch = new Float64Array(capacity)
  let head = 0
  let size = 0
  return {
    add (value: number): void {
      values[head] = value
      head = (head + 1) % capacity
      if (size < capacity) size++
    },
    snapshot (): ValueSnapshot {
      if (size === 0) return { p50: 0, p99: 0, max: 0, samples: 0 }
      const sorted = scratch.subarray(0, size)
      sorted.set(values.subarray(0, size))
      sorted.sort()
      const at = (q: number): number => sorted[Math.min(size - 1, Math.floor(q * size))] as number
      return { p50: at(0.5), p99: at(0.99), max: sorted[size - 1] as number, samples: size }
    },
    reset (): void {
      head = 0
      size = 0
    }
  }
}

export function createArrivalMeter (options: ArrivalMeterOptions = {}): ArrivalMeter {
  const windowMs = options.windowMs ?? 2000
  const gapMs = options.gapMs ?? 50
  const capacity = options.capacity ?? 1024
  if (!(windowMs > 0) || !(gapMs > 0) || !Number.isInteger(capacity) || capacity < 2) {
    throw new RangeError(`stats: windowMs and gapMs must be positive and capacity an integer >= 2, got ${windowMs}/${gapMs}/${capacity}`)
  }

  // Ring of arrival times. `head` is the next slot to write; `size` how many
  // are valid. Scratch for the sorted intervals is allocated once.
  const times = new Float64Array(capacity)
  const scratch = new Float64Array(capacity)
  let head = 0
  let size = 0
  let total = 0
  let gaps = 0
  let last: number | null = null

  return {
    mark (now: number): void {
      if (last !== null && now - last > gapMs) gaps++
      last = now
      total++
      times[head] = now
      head = (head + 1) % capacity
      if (size < capacity) size++
    },
    snapshot (now: number): ArrivalSnapshot {
      // Walk the ring from newest to oldest, keeping what is inside the window.
      const from = now - windowMs
      let n = 0
      let newest = -Infinity
      let oldest = Infinity
      let previous: number | null = null
      for (let k = 0; k < size; k++) {
        const t = times[(head - 1 - k + capacity) % capacity] as number
        if (t < from) break
        if (previous !== null) scratch[n - 1] = previous - t
        if (k === 0) newest = t
        oldest = t
        previous = t
        n++
      }
      if (n < 2) return { fps: 0, p50: 0, p99: 0, max: 0, samples: n, gaps, total }

      const intervals = scratch.subarray(0, n - 1)
      intervals.sort()
      const at = (q: number): number => intervals[Math.min(n - 2, Math.floor(q * (n - 1)))] as number
      return {
        fps: (n - 1) / (newest - oldest) * 1000,
        p50: at(0.5),
        p99: at(0.99),
        max: intervals[n - 2] as number,
        samples: n,
        gaps,
        total
      }
    },
    reset (): void {
      head = 0
      size = 0
      total = 0
      gaps = 0
      last = null
    }
  }
}
