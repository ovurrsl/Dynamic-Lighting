import type { LedColors } from '#lib/engine/types'

/**
 * Channel order: which of the three bytes a LED expects first.
 *
 * Port of Hyperion's `applyColorOrder` (libsrc/hyperion/Hyperion.cpp:718-750)
 * and the `ColorOrder` enum (include/hyperion/LedString.h:15-18), with the
 * per-LED override its layout carries (LedString.cpp:75).
 *
 * This exists because WS2812B strips are not all wired alike - the common ones
 * want GREEN first - and a strip that shows red when asked for green is not
 * broken, it is wired differently. The order is a fact about the wire, so this
 * is the LAST stage before the bytes are framed: everything upstream, the
 * corner calibration in lib/engine/adjust.ts included, works in real colours.
 *
 * Hyperion writes the permutation as chains of `std::swap` (RGB->GBR is
 * swap(r,g) then swap(g,b)), which is the same map as reading the name as a
 * spelling of the output: `gbr` means "green first, then blue, then red". A
 * table of index triples is that statement directly, and cannot be misread.
 *
 * The per-LED form matters on a real desk: a strip cut and rejoined at a
 * corner can come back with a different order on the second run, and the panel
 * needs to fix one stretch without touching the rest.
 */

export type ColorOrder = 'rgb' | 'rbg' | 'grb' | 'gbr' | 'brg' | 'bgr'

export const COLOR_ORDERS: readonly ColorOrder[] = Object.freeze(['rgb', 'rbg', 'grb', 'gbr', 'brg', 'bgr'])

export const DEFAULT_COLOR_ORDER: ColorOrder = 'rgb'

/**
 * The source index of each output channel: `out[k] = in[PERMUTATIONS[order][k]]`
 * with 0 = red, 1 = green, 2 = blue. Reading a name as the output spelling is
 * the whole definition.
 */
export const PERMUTATIONS: Readonly<Record<ColorOrder, readonly [number, number, number]>> = Object.freeze({
  rgb: Object.freeze([0, 1, 2] as const),
  rbg: Object.freeze([0, 2, 1] as const),
  grb: Object.freeze([1, 0, 2] as const),
  gbr: Object.freeze([1, 2, 0] as const),
  brg: Object.freeze([2, 0, 1] as const),
  bgr: Object.freeze([2, 1, 0] as const)
})

export interface ColorOrderStage {
  readonly count: number
  /** True when every LED is `rgb`, so `apply` is a no-op and can be skipped. */
  readonly identity: boolean
  /** The order in force for each LED. */
  orders (): readonly ColorOrder[]
  /** Permutes each LED's channels in place and returns `colors`. */
  apply (colors: LedColors): LedColors
}

export interface ColorOrderOptions {
  /** The order every LED uses unless overridden. Default `rgb`. */
  order?: ColorOrder
  /**
   * Per-LED overrides by wire index, for a strip that is not uniform: a run
   * rejoined at a corner, or two strips soldered together.
   */
  overrides?: Readonly<Record<number, ColorOrder>>
}

export function createColorOrder (count: number, options: ColorOrderOptions = {}): ColorOrderStage {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`order: count must be a positive integer, got ${count}`)
  const base = options.order ?? DEFAULT_COLOR_ORDER
  requireOrder(base)

  const orders: ColorOrder[] = new Array<ColorOrder>(count).fill(base)
  for (const [at, order] of Object.entries(options.overrides ?? {})) {
    const led = Number(at)
    if (!Number.isInteger(led) || led < 0 || led >= count) {
      throw new RangeError(`order: override index must be an integer 0..${count - 1}, got ${at}`)
    }
    requireOrder(order)
    orders[led] = order
  }

  // The permutation per LED, flattened: three source indices each, so the hot
  // path is an indexed read and no branch.
  const table = new Uint8Array(count * 3)
  let identity = true
  for (let led = 0; led < count; led++) {
    const permutation = PERMUTATIONS[orders[led] as ColorOrder]
    for (let k = 0; k < 3; k++) table[led * 3 + k] = permutation[k] as number
    if (orders[led] !== 'rgb') identity = false
  }

  const frozen = Object.freeze([...orders])
  return {
    count,
    identity,
    orders: () => frozen,
    apply (colors: LedColors): LedColors {
      if (identity) return colors
      if (colors.length < count * 3) {
        throw new RangeError(`order: frame holds ${colors.length} channels, ${count} LEDs need ${count * 3}`)
      }
      for (let led = 0; led < count; led++) {
        const at = led * 3
        const r = colors[at] as number
        const g = colors[at + 1] as number
        const b = colors[at + 2] as number
        // Written out rather than indexed through a scratch triple: an array
        // per LED is 13 000 allocations a second at 108 LEDs and 120 Hz.
        const p0 = table[at] as number
        const p1 = table[at + 1] as number
        const p2 = table[at + 2] as number
        colors[at] = p0 === 0 ? r : p0 === 1 ? g : b
        colors[at + 1] = p1 === 0 ? r : p1 === 1 ? g : b
        colors[at + 2] = p2 === 0 ? r : p2 === 1 ? g : b
      }
      return colors
    }
  }
}

/** What the user saw when the strip was asked for one pure channel. */
export type SeenChannel = 'red' | 'green' | 'blue'

/**
 * Derives the order from two questions, which is the only way to find it
 * without a datasheet: light pure RED, ask what colour the strip showed; light
 * pure GREEN, ask again. Hyperion has no such wizard - it offers the six names
 * in a dropdown and lets you guess.
 *
 * The reasoning, in one line: if asking for red lit green, then the strip's
 * FIRST byte drives its green emitter, so the first byte we send must carry
 * the green value - and the name of an order is the spelling of its output.
 * The third channel is whatever is left.
 */
export function deriveColorOrder (sawWhenRed: SeenChannel, sawWhenGreen: SeenChannel): ColorOrder {
  const initial: Record<SeenChannel, string> = { red: 'r', green: 'g', blue: 'b' }
  for (const [name, seen] of [['sawWhenRed', sawWhenRed], ['sawWhenGreen', sawWhenGreen]] as const) {
    if (initial[seen] === undefined) throw new RangeError(`order: ${name} must be red, green or blue, got ${String(seen)}`)
  }
  if (sawWhenRed === sawWhenGreen) {
    throw new RangeError(`order: red and green cannot both have shown ${sawWhenRed}; one of the answers is wrong`)
  }
  const third = (['red', 'green', 'blue'] as const).find((c) => c !== sawWhenRed && c !== sawWhenGreen) as SeenChannel
  const order = `${initial[sawWhenRed]}${initial[sawWhenGreen]}${initial[third]}` as ColorOrder
  // Every pair of distinct answers spells one of the six, so this cannot fail;
  // it is here so a future edit to the naming cannot silently produce garbage.
  requireOrder(order)
  return order
}

function requireOrder (order: ColorOrder): void {
  if (!COLOR_ORDERS.includes(order)) throw new RangeError(`order: unknown colour order ${String(order)}`)
}
