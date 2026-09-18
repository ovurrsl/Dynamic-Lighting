import type { BlacklistRange } from '#lib/engine/layout'
import { COLOR_ORDERS, type ColorOrder } from '#lib/engine/order'

/**
 * Two small notations for two settings that had no way in.
 *
 * The parser has accepted a blacklist (LEDs wired but never lit) and per-LED
 * channel-order overrides (a strip repaired mid-run with a reel of another
 * order) since the layout work - validated, round-trip tested, and reachable
 * from no card. Both are lists a person types rather than sliders they drag,
 * so the card takes them as text and this file is the text's grammar:
 *
 *   blacklist   "0-3, 10, 20-24"      LED indices, 0-based like everywhere
 *                                     else on the panel, ranges inclusive
 *   overrides   "5:grb, 7:brg"        index:order, the six orders the strip
 *                                     stage already knows
 *
 * Both directions live here so what the card shows after a reload is exactly
 * what the parser holds, and a stored value round-trips through the text box
 * unchanged. Errors name the piece that was wrong, because "invalid" on a
 * list of forty entries is no help at all.
 */

const RANGE = /^(\d+)(?:\s*-\s*(\d+))?$/

/** "0-3, 10, 20-24" → ranges. Empty text is an empty list, not an error. */
export function parseRangeList (text: string): BlacklistRange[] {
  const out: BlacklistRange[] = []
  for (const piece of text.split(/[,;\s]+/)) {
    if (piece === '') continue
    const m = RANGE.exec(piece)
    if (m === null) throw new RangeError(`blacklist: "${piece}" is not an index or a range like 4-7`)
    const start = Number(m[1])
    const end = m[2] === undefined ? start : Number(m[2])
    if (end < start) throw new RangeError(`blacklist: "${piece}" runs backwards`)
    out.push({ start, length: end - start + 1 })
  }
  return out
}

/** Ranges → "0-3, 10, 20-24". A one-LED range is written as the one index. */
export function formatRangeList (ranges: readonly BlacklistRange[]): string {
  return ranges
    .map((range) => (range.length === 1 ? String(range.start) : `${range.start}-${range.start + range.length - 1}`))
    .join(', ')
}

const OVERRIDE = /^(\d+)\s*:\s*([a-z]{3})$/i

/** "5:grb, 7:brg" → overrides. Empty text is no overrides. */
export function parseOverrideList (text: string): Record<number, ColorOrder> {
  const out: Record<number, ColorOrder> = {}
  for (const piece of text.split(/[,;\s]+/)) {
    if (piece === '') continue
    const m = OVERRIDE.exec(piece)
    if (m === null) throw new RangeError(`overrides: "${piece}" is not index:order like 5:grb`)
    const order = (m[2] as string).toLowerCase()
    if (!(COLOR_ORDERS as readonly string[]).includes(order)) {
      throw new RangeError(`overrides: "${m[2] as string}" is not one of ${COLOR_ORDERS.join(', ')}`)
    }
    out[Number(m[1])] = order as ColorOrder
  }
  return out
}

/** Overrides → "5:grb, 7:brg", in index order. */
export function formatOverrideList (overrides: Readonly<Record<number, ColorOrder>> | undefined): string {
  if (overrides === undefined) return ''
  return Object.entries(overrides)
    .map(([at, order]) => [Number(at), order] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([at, order]) => `${at}:${order}`)
    .join(', ')
}
