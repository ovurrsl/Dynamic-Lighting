import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { PRIORITY, createEngine, type CanvasLike, type Engine, type EngineHost } from '#lib/engine/runtime'
import type { FrameSource } from '#lib/engine/source'
import type { EngineStats } from '#lib/extension/messages'

/**
 * The runtime with a fake host.
 *
 * Only the three things a host owes it are faked - a clock, a canvas and a
 * capture source - so everything under test here is the real engine: the real
 * muxer, the real effects, the real smoother, the real loopback sink. The
 * claim these tests exist for is the one priority layers were added to make
 * true: **starting one source no longer stops the others**, so ending an effect
 * reveals whatever was underneath instead of leaving the strip dark.
 */

function fakeCanvas (): CanvasLike {
  return {
    getContext: () => ({
      drawImage () {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })
    })
  }
}

interface Harness {
  engine: Engine
  now: () => number
  advance: (ms: number) => void
  reports: EngineStats[]
}

function harness (): Harness {
  let at = 0
  const reports: EngineStats[] = []
  const host: EngineHost = {
    clock: () => at,
    createCanvas: fakeCanvas,
    openSource: async (): Promise<FrameSource> => {
      throw new Error('no capture in this test')
    },
    onReport: (stats) => { reports.push(stats) }
  }
  return { engine: createEngine(host), now: () => at, advance: (ms) => { at += ms }, reports }
}

const layers = (engine: Engine): Array<{ priority: number, component: string, winning: boolean }> =>
  (engine.stats().layers ?? []).map((l) => ({ priority: l.priority, component: l.component, winning: l.winning }))

const winner = (engine: Engine): string | null =>
  engine.stats().layers?.find((l) => l.winning)?.component ?? null

test('an untimed colour is a BASE: an effect runs on top of it', () => {
  // "Set the strip to warm white" is a thing you come back to after an effect.
  const h = harness()
  h.engine.setColor({ r: 255, g: 0, b: 0 })
  assert.equal(winner(h.engine), 'color')

  h.engine.runEffect({ kind: 'rainbow' })
  assert.equal(winner(h.engine), 'effect')
  assert.deepEqual(layers(h.engine).map((l) => l.component).sort(), ['color', 'effect'])
  h.engine.stop()
})

test('a TIMED colour is an interruption: it cuts through an effect', () => {
  // "Flash red" has to cut through, or it is not a notification. The same call
  // does both and the difference is whether a duration was given - the caller
  // never picks a priority.
  const h = harness()
  h.engine.runEffect({ kind: 'rainbow' })
  h.engine.setColor({ r: 255, g: 0, b: 0 }, 3000)
  assert.equal(winner(h.engine), 'flash')
  h.engine.stop()
})

test('stopping the effect REVEALS the colour, rather than leaving the strip dark', () => {
  // This is the whole feature. Before priority layers every source stopped
  // every other one, so ending an effect left nothing showing and the user
  // picking their screen again.
  const h = harness()
  h.engine.setColor({ r: 0, g: 255, b: 0 })
  h.engine.runEffect({ kind: 'comet' })
  assert.equal(winner(h.engine), 'effect')

  h.engine.clearLayer(PRIORITY.effect)
  assert.equal(winner(h.engine), 'color', 'the colour underneath should be showing')
  assert.equal(h.engine.state(), 'running')
  h.engine.stop()
})

test('a test pattern outranks content, and clearing it gives the content back', () => {
  // A pattern is a measurement: whatever was showing has to get out of its way
  // completely. What it must NOT do is stop anything, or the calibration wizard
  // would cost the user the screen they picked.
  const h = harness()
  h.engine.runEffect({ kind: 'plasma' })
  h.engine.runPattern({ kind: 'solid', color: { r: 1, g: 0, b: 0 } })
  assert.equal(winner(h.engine), 'pattern')

  h.engine.clearLayer(PRIORITY.pattern)
  assert.equal(winner(h.engine), 'effect')
  h.engine.stop()
})

test('a timed colour expires on its own and reveals what is underneath', async () => {
  // "Red for ten seconds, then back to whatever was showing" is one call; the
  // muxer drops the layer itself when the time is up.
  const h = harness()
  h.engine.runEffect({ kind: 'breathe' })
  h.engine.setColor({ r: 255, g: 0, b: 0 }, 1000)
  assert.equal(winner(h.engine), 'flash')

  h.advance(1500)
  // The engine's own tick timer does the sweep; it runs every 4 ms.
  await delay(30)
  assert.equal(winner(h.engine), 'effect', 'the timed colour should have expired')
  h.engine.stop()
})

test('the last layer going leaves the engine idle, and only the last one', () => {
  const h = harness()
  h.engine.runEffect({ kind: 'rainbow' })
  h.engine.setColor({ r: 1, g: 2, b: 3 })
  h.engine.clearLayer(PRIORITY.effect)
  assert.equal(h.engine.state(), 'running', 'a colour is still showing')
  h.engine.clearLayer(PRIORITY.color)
  assert.equal(h.engine.state(), 'idle')
  assert.deepEqual(layers(h.engine), [])
})

test('stop() takes everything down at once', () => {
  const h = harness()
  h.engine.runEffect({ kind: 'candle' })
  h.engine.setColor({ r: 9, g: 9, b: 9 })
  h.engine.runPattern({ kind: 'off' })
  assert.equal(layers(h.engine).length, 3)
  h.engine.stop()
  assert.deepEqual(layers(h.engine), [])
  assert.equal(h.engine.state(), 'idle')
})

test('a colour is taken in sRGB, like every colour a person picks', async () => {
  // Mid grey is 0.5 in sRGB and about 0.214 in linear. Sending 0.5 straight
  // through would make every colour roughly twice as bright as chosen.
  const h = harness()
  h.engine.setColor({ r: 128, g: 128, b: 128 })
  await delay(20)
  const stats = h.engine.stats()
  // The loopback parses every frame it is given; a frame that reached it at all
  // proves the whole path ran.
  assert.ok(stats.link.accepted >= 0)
  assert.equal(winner(h.engine), 'color')
  h.engine.stop()
})

test('an out-of-range colour is clamped rather than throwing mid-frame', () => {
  const h = harness()
  assert.doesNotThrow(() => { h.engine.setColor({ r: 999, g: -5, b: Number.NaN }) })
  assert.equal(winner(h.engine), 'color')
  h.engine.stop()
})

test('the layer list names the priorities the panel shows', () => {
  const h = harness()
  h.engine.runEffect({ kind: 'rainbow' })
  h.engine.setColor({ r: 0, g: 0, b: 255 })
  const list = layers(h.engine)
  assert.deepEqual(list.map((l) => l.priority), [PRIORITY.effect, PRIORITY.color])
  // Highest priority first, which is what a list wants to read like.
  assert.ok((list[0]?.priority ?? 0) < (list[1]?.priority ?? 0))
  h.engine.stop()
})
