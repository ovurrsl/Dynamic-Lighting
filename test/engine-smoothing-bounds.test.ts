import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ENGINE_CONFIG, SMOOTHING_MS_MAX, SMOOTHING_MS_MIN, parseEngineConfig } from '#lib/engine/config'
import { createSmoother } from '#lib/engine/smooth'

/**
 * The parser's bounds and the smoother's own must agree, because a value the
 * parser blesses goes straight into createSmoother inside applyConfig - and on
 * the extension host it is persisted first. The bound was 0, the smoother
 * refuses anything that is not positive, and the smoothing card's slider
 * reached 0 by dragging fully left: a configuration the UI produced, the parser
 * accepted, and the engine threw on.
 */
test('every time constant the parser accepts is one the smoother accepts', () => {
  for (const ms of [SMOOTHING_MS_MIN, SMOOTHING_MS_MAX]) {
    const config = parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, smoothing: { attackMs: ms, releaseMs: ms, cutThreshold: 1 } })
    assert.equal(config.smoothing.attackMs, ms)
    assert.doesNotThrow(() => createSmoother({
      mode: 'asymmetric',
      count: 3,
      outputHz: 120,
      attackMs: config.smoothing.attackMs,
      releaseMs: config.smoothing.releaseMs,
      cutThreshold: config.smoothing.cutThreshold
    }, () => 0), `createSmoother refused ${ms} ms, which the parser accepts`)
  }
})

test('below the floor is refused by the parser rather than by the engine', () => {
  assert.throws(
    () => parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, smoothing: { attackMs: SMOOTHING_MS_MIN - 1 } }),
    /smoothing\.attackMs/
  )
})
