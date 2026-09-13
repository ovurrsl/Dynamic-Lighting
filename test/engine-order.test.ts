import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COLOR_ORDERS,
  DEFAULT_COLOR_ORDER,
  PERMUTATIONS,
  createColorOrder,
  deriveColorOrder,
  type ColorOrder,
  type SeenChannel
} from '#lib/engine/order'
import { REFERENCE_LAYOUT, ledCount } from '#lib/engine/layout'
import { allocLedColors } from '#lib/engine/types'

const LEDS = ledCount(REFERENCE_LAYOUT)

/**
 * A frame where every LED carries a distinguishable triple. The fractions are
 * negative powers of two so every value is exact in Float32 and the
 * assertions can compare for equality rather than for nearness - a permutation
 * that moved a channel by an epsilon would be a permutation that lost data.
 */
const R = 0.125
const G = 0.25
const B = 0.5

function ramp (count: number): Float32Array {
  const colors = allocLedColors(count)
  for (let led = 0; led < count; led++) {
    colors[led * 3] = R + led
    colors[led * 3 + 1] = G + led
    colors[led * 3 + 2] = B + led
  }
  return colors
}

function triple (colors: Float32Array, led: number): [number, number, number] {
  return [colors[led * 3] as number, colors[led * 3 + 1] as number, colors[led * 3 + 2] as number]
}

/**
 * Hyperion's `applyColorOrder` (Hyperion.cpp:718-750) verbatim: chains of
 * swaps on a mutable triple, so the table-driven permutation is checked
 * against the source rather than against itself.
 */
function hyperionSwap (order: ColorOrder, rgb: [number, number, number]): [number, number, number] {
  let [red, green, blue] = rgb
  const swapRedGreen = (): void => { [red, green] = [green, red] }
  const swapRedBlue = (): void => { [red, blue] = [blue, red] }
  const swapGreenBlue = (): void => { [green, blue] = [blue, green] }
  switch (order) {
    case 'rgb': break
    case 'bgr': swapRedBlue(); break
    case 'rbg': swapGreenBlue(); break
    case 'grb': swapRedGreen(); break
    case 'gbr': swapRedGreen(); swapGreenBlue(); break
    case 'brg': swapRedBlue(); swapGreenBlue(); break
  }
  return [red, green, blue]
}

test('the six orders are the six spellings, and each permutation is its own name', () => {
  assert.deepEqual([...COLOR_ORDERS].sort(), ['bgr', 'brg', 'gbr', 'grb', 'rbg', 'rgb'])
  assert.equal(DEFAULT_COLOR_ORDER, 'rgb')
  const letters = { r: 0, g: 1, b: 2 } as const
  for (const order of COLOR_ORDERS) {
    const spelled = [...order].map((c) => letters[c as 'r' | 'g' | 'b'])
    assert.deepEqual([...PERMUTATIONS[order]], spelled, `${order} must permute as it is spelled`)
  }
  // A permutation, not a mapping: every channel is used exactly once.
  for (const order of COLOR_ORDERS) {
    assert.deepEqual([...PERMUTATIONS[order]].sort(), [0, 1, 2], order)
  }
})

test('every order matches Hyperion\'s chain of swaps, channel for channel', () => {
  for (const order of COLOR_ORDERS) {
    const stage = createColorOrder(1, { order })
    const colors = new Float32Array([0.25, 0.5, 0.75])
    stage.apply(colors)
    assert.deepEqual(Array.from(colors), hyperionSwap(order, [0.25, 0.5, 0.75]), order)
  }
})

test('rgb is the identity and is skipped: the frame comes back untouched and the stage says so', () => {
  const stage = createColorOrder(LEDS)
  assert.equal(stage.identity, true)
  const colors = ramp(LEDS)
  const before = Array.from(colors)
  assert.equal(stage.apply(colors), colors, 'returns the frame it was given')
  assert.deepEqual(Array.from(colors), before)
  assert.equal(createColorOrder(LEDS, { order: 'grb' }).identity, false)
  assert.deepEqual(stage.orders(), new Array<ColorOrder>(LEDS).fill('rgb'))
})

test('a whole-strip order permutes every LED, and applying it twice is not the identity unless it is an involution', () => {
  // grb swaps two channels, so twice is the identity; gbr is a 3-cycle, so
  // three times is. Both are checked because a stage that quietly cached the
  // wrong triple would pass one and fail the other.
  const grb = createColorOrder(LEDS, { order: 'grb' })
  const colors = ramp(LEDS)
  const original = Array.from(colors)
  grb.apply(colors)
  for (let led = 0; led < LEDS; led++) {
    assert.deepEqual(triple(colors, led), [G + led, R + led, B + led], `LED ${led}`)
  }
  grb.apply(colors)
  assert.deepEqual(Array.from(colors), original, 'grb twice is the identity')

  const gbr = createColorOrder(LEDS, { order: 'gbr' })
  const cycled = ramp(LEDS)
  gbr.apply(cycled)
  assert.deepEqual(triple(cycled, 7), [G + 7, B + 7, R + 7])
  gbr.apply(cycled)
  gbr.apply(cycled)
  assert.deepEqual(Array.from(cycled), original, 'gbr three times is the identity')
})

test('per-LED overrides fix one stretch and leave the rest alone', () => {
  // A strip cut and rejoined at the bottom-right corner, the second run wired
  // the other way: LEDs 54..59 need bgr, everything else is grb.
  const overrides: Record<number, ColorOrder> = {}
  for (let led = 54; led <= 59; led++) overrides[led] = 'bgr'
  const stage = createColorOrder(LEDS, { order: 'grb', overrides })
  assert.equal(stage.identity, false)
  assert.equal(stage.orders()[53], 'grb')
  assert.equal(stage.orders()[54], 'bgr')
  assert.equal(stage.orders()[60], 'grb')

  const colors = ramp(LEDS)
  stage.apply(colors)
  assert.deepEqual(triple(colors, 53), [G + 53, R + 53, B + 53], 'grb outside the stretch')
  assert.deepEqual(triple(colors, 54), [B + 54, G + 54, R + 54], 'bgr inside it')
  assert.deepEqual(triple(colors, 59), [B + 59, G + 59, R + 59])
  assert.deepEqual(triple(colors, 60), [G + 60, R + 60, B + 60])

  // An all-rgb strip with one override is still not the identity.
  assert.equal(createColorOrder(LEDS, { overrides: { 0: 'bgr' } }).identity, false)
})

test('the wizard derives the order from what the user saw, and rgb is the answer when nothing is swapped', () => {
  // The common WS2812B case: ask for red, the strip shows green.
  assert.equal(deriveColorOrder('green', 'red'), 'grb')
  assert.equal(deriveColorOrder('red', 'green'), 'rgb')
  assert.equal(deriveColorOrder('blue', 'green'), 'bgr')
  assert.equal(deriveColorOrder('red', 'blue'), 'rbg')
  assert.equal(deriveColorOrder('green', 'blue'), 'gbr')
  assert.equal(deriveColorOrder('blue', 'red'), 'brg')

  // Every pair of distinct answers names one of the six, exactly once.
  const channels: SeenChannel[] = ['red', 'green', 'blue']
  const derived = new Set<ColorOrder>()
  for (const red of channels) {
    for (const green of channels) {
      if (red === green) continue
      derived.add(deriveColorOrder(red, green))
    }
  }
  assert.equal(derived.size, 6)
  assert.deepEqual([...derived].sort(), [...COLOR_ORDERS].sort())
})

test('the wizard\'s answer actually fixes the strip it describes', () => {
  // Simulate a strip wired grb: the bytes it receives drive (green, red, blue)
  // in that order. Asking it for pure red with no correction lights green.
  const wiring: ColorOrder = 'grb'
  const litBy = (sent: [number, number, number]): [number, number, number] => {
    // The strip's k-th byte drives the emitter named by the k-th letter.
    const emitters: [number, number, number] = [0, 0, 0]
    const index = { r: 0, g: 1, b: 2 } as const
    ;[...wiring].forEach((letter, k) => { emitters[index[letter as 'r' | 'g' | 'b']] = sent[k] as number })
    return emitters
  }
  const seen = (lit: [number, number, number]): SeenChannel => (lit[0] === 1 ? 'red' : lit[1] === 1 ? 'green' : 'blue')

  const sawRed = seen(litBy([1, 0, 0]))
  const sawGreen = seen(litBy([0, 1, 0]))
  assert.equal(sawRed, 'green', 'the uncorrected strip shows green for red')
  assert.equal(sawGreen, 'red')

  const order = deriveColorOrder(sawRed, sawGreen)
  assert.equal(order, wiring)
  // With that order in the stage, asking for red lights red.
  const stage = createColorOrder(1, { order })
  for (const [ask, want] of [[[1, 0, 0], 'red'], [[0, 1, 0], 'green'], [[0, 0, 1], 'blue']] as const) {
    const colors = new Float32Array(ask)
    stage.apply(colors)
    assert.equal(seen(litBy([colors[0] as number, colors[1] as number, colors[2] as number])), want)
  }
})

test('rejects an unknown order, an override off the strip, a short frame and contradictory answers', () => {
  assert.throws(() => createColorOrder(LEDS, { order: 'rbz' as unknown as ColorOrder }), RangeError)
  assert.throws(() => createColorOrder(LEDS, { overrides: { 108: 'bgr' } }), RangeError)
  assert.throws(() => createColorOrder(LEDS, { overrides: { [-1]: 'bgr' } }), RangeError)
  assert.throws(() => createColorOrder(LEDS, { overrides: { 0: 'nope' as unknown as ColorOrder } }), RangeError)
  assert.throws(() => createColorOrder(0), RangeError)
  assert.throws(() => createColorOrder(1.5), RangeError)
  assert.throws(() => createColorOrder(4, { order: 'grb' }).apply(allocLedColors(3)), RangeError)
  assert.throws(() => deriveColorOrder('red', 'red'), RangeError)
  assert.throws(() => deriveColorOrder('cyan' as unknown as SeenChannel, 'red'), RangeError)

  // The identity stage is allowed to skip the length check: it touches nothing.
  const short = allocLedColors(3)
  assert.equal(createColorOrder(4).apply(short), short)
})
