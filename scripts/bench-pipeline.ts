#!/usr/bin/env node
/**
 * What the CPU half of the pipeline costs, on the machine you run it on.
 *
 * The engine reports `processMs` p50 = 9.00 ms at 1080p against an 8.33 ms
 * budget at 120 Hz, and that single number says there is a problem and nothing
 * about where. The stage breakdown in the telemetry card splits it four ways,
 * but it is read off a live engine and therefore needs a screen, a capture
 * permission and a GPU - which is exactly what a headless machine, or a bug
 * report from a user, does not have.
 *
 * This measures the three stages that need none of that. Decode, sample and
 * adjust all run on the ANALYSIS GRID (128x72 by default), not on the source
 * frame, so they cost the same here as anywhere with the same CPU. The two
 * stages missing from this list - the downscale and the readback - are the
 * ones that touch the full-resolution frame and the GPU, and they are the ones
 * this script deliberately cannot measure.
 *
 * That split is the point. If the stages below are a rounding error against
 * the budget, then whatever `processMs` says is happening above them, and no
 * amount of work on the sampler will move it.
 *
 * On the machine this was written on: 0.114 ms for the whole default path -
 * 1.4% of one frame's budget - against a reported 9.00 ms. So: all of it is
 * the GPU path. The per-mode numbers are the other half of the answer, and
 * they are not flat: the clustering reductions cost two orders of magnitude
 * more than the average, which is a thing a user choosing one should be told.
 *
 *   node scripts/bench-pipeline.ts            default grid
 *   node scripts/bench-pipeline.ts 256 144    another grid
 */
import { createRgbaDecoder, allocLinearGrid } from '#lib/engine/decode'
import { createSampler, SAMPLE_MODES, type SampleMode } from '#lib/engine/sample'
import { createAdjustment } from '#lib/engine/adjust'
import { createBorderDetector } from '#lib/engine/border'
import { classicLayout, REFERENCE_LAYOUT } from '#lib/engine/layout'
import { allocLedColors } from '#lib/engine/types'
import { DEFAULT_BORDER, DEFAULT_COLOR } from '#lib/engine/config'
import { OUTPUT_HZ } from '#lib/engine/runtime'

/** One output frame's budget, the same arithmetic the telemetry card shows. */
const OUTPUT_BUDGET_MS = 1000 / OUTPUT_HZ

const W = Number(process.argv[2] ?? 128)
const H = Number(process.argv[3] ?? 72)
if (!Number.isInteger(W) || !Number.isInteger(H) || W < 8 || H < 8) {
  console.error('usage: node scripts/bench-pipeline.ts [width] [height]')
  process.exit(1)
}

const layout = classicLayout(REFERENCE_LAYOUT)
const leds = layout.length

/**
 * A frame with structure, not a flat colour.
 *
 * A uniform frame is the best case for every reduction and the worst possible
 * benchmark: k-means converges in one iteration and the histogram has one key,
 * so the expensive modes would look free. A gradient plus noise gives the
 * clustering something to actually do.
 */
const rgba = new Uint8ClampedArray(W * H * 4)
let seed = 12345
const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
for (let i = 0; i < W * H; i++) {
  rgba[i * 4] = ((i % W) / W) * 255
  rgba[i * 4 + 1] = (((i / W) | 0) / H) * 255
  rgba[i * 4 + 2] = rnd() * 255
  rgba[i * 4 + 3] = 255
}

const decoder = createRgbaDecoder(W, H)
const grid = allocLinearGrid(W, H)
const out = allocLedColors(leds)
const adjustment = createAdjustment([{ leds: '*', ...DEFAULT_COLOR }], leds)
// The detector takes an injected clock, like everything timed in this engine:
// its hysteresis is in milliseconds, so a benchmark that fed it a real clock
// would be measuring the wall clock's progress as well as the detector's work.
let fakeNow = 0
const detector = createBorderDetector(
  { ...DEFAULT_BORDER, enabled: true },
  () => (fakeNow += 8)
)

/** Warm first: the first few hundred calls measure the JIT, not the code. */
function time (label: string, iterations: number, fn: () => void): number {
  for (let i = 0; i < 300; i++) fn()
  const started = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const ms = (performance.now() - started) / iterations
  console.log(`  ${label.padEnd(32)} ${ms.toFixed(4)} ms`)
  return ms
}

console.log(`\ngrid ${W}x${H}, ${leds} LEDs, one frame's work, budget ${OUTPUT_BUDGET_MS.toFixed(2)} ms\n`)
console.log('stages below the GPU:')
const decode = time('decode  (sRGB bytes -> linear)', 2000, () => { decoder.decode(rgba, grid) })
const border = time('border  (detect, default mode)', 2000, () => { detector.process(grid, (fakeNow += 8)) })
const adjust = time('adjust  (identity profile)', 2000, () => { adjustment.apply(out) })

console.log('\nreductions:')
const costs = new Map<SampleMode, number>()
for (const mode of SAMPLE_MODES) {
  const sampler = createSampler({ layout, width: W, height: H })
  costs.set(mode, time(`sample  (${mode})`, mode.includes('Advanced') ? 400 : 2000, () => {
    sampler.sample(grid, out, mode)
  }))
}

const base = costs.get('mean') ?? 1
const path = decode + border + adjust + base
console.log(`\ndefault path (decode + border + mean + adjust): ${path.toFixed(3)} ms`)
console.log(`  = ${(path / OUTPUT_BUDGET_MS * 100).toFixed(1)}% of one frame's budget`)
console.log('\nreduction cost relative to the average:')
for (const [mode, ms] of costs) {
  console.log(`  ${mode.padEnd(28)} ${(ms / base).toFixed(1)}x`)
}
console.log('\nThe downscale and the readback are NOT measured here: they touch the')
console.log('full-resolution frame and the GPU. Whatever the engine reports as')
console.log('processMs beyond the number above is theirs.\n')
