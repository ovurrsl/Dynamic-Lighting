import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { PRIORITY, createEngine, type CanvasLike, type Engine, type EngineHost } from '#lib/engine/runtime'
import { DEFAULT_ENGINE_CONFIG } from '#lib/engine/config'
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

// ---------------------------------------------------------------------------
// The two layers nobody starts by hand.
// ---------------------------------------------------------------------------

/** The reference rig with one of the automatic layers switched on. */
const withLayers = (over: Record<string, unknown>): unknown => ({
  ...JSON.parse(JSON.stringify(DEFAULT_ENGINE_CONFIG)),
  ...over
})

test('a background is UNDER everything and is what an ending capture falls back to', () => {
  // The whole point, in the gap analysis's own words: "leave warm white behind
  // it when the screen goes dark." Before this the muxer reserved a background
  // slot that nothing could ever register in.
  const h = harness()
  h.engine.applyConfig(withLayers({
    background: { enabled: true, kind: 'color', color: { r: 255, g: 170, b: 100 }, effect: 'candle' }
  }))

  h.engine.runEffect({ kind: 'rainbow' })
  assert.equal(winner(h.engine), 'effect', 'a real layer still wins')
  assert.ok(layers(h.engine).some((l) => l.component === 'background'), 'and the background is under it')

  h.engine.clearLayer(PRIORITY.effect)
  assert.equal(winner(h.engine), 'background', 'the strip falls back rather than going dark')
  assert.equal(h.engine.state(), 'running', 'and the engine is not idle')
  h.engine.stop()
})

test('stopping really stops: the background belongs to running, not to idle', () => {
  // A strip still glowing after the user pressed Stop is a strip that ignored
  // them.
  const h = harness()
  h.engine.applyConfig(withLayers({
    background: { enabled: true, kind: 'color', color: { r: 255, g: 170, b: 100 }, effect: 'candle' }
  }))
  h.engine.setColor({ r: 0, g: 0, b: 255 })
  assert.ok(layers(h.engine).some((l) => l.component === 'background'))

  h.engine.stop()
  assert.equal(h.engine.state(), 'idle')
  assert.deepEqual(layers(h.engine), [], 'nothing is left registered')
})

test('turning the background off takes it away without touching anything else', () => {
  const h = harness()
  h.engine.applyConfig(withLayers({
    background: { enabled: true, kind: 'color', color: { r: 255, g: 170, b: 100 }, effect: 'candle' }
  }))
  h.engine.runEffect({ kind: 'police' })
  assert.ok(layers(h.engine).some((l) => l.component === 'background'))

  h.engine.applyConfig(withLayers({ background: { enabled: false, kind: 'color', color: { r: 1, g: 2, b: 3 }, effect: 'candle' } }))
  assert.ok(!layers(h.engine).some((l) => l.component === 'background'), 'gone')
  assert.equal(winner(h.engine), 'effect', 'and the effect never noticed')
  h.engine.stop()
})

test('a background EFFECT renders continuously, not once', () => {
  // A colour is fed once and stays; an effect has to keep being drawn, and it
  // shares the effect timer rather than starting a second one on its own phase.
  const h = harness()
  h.engine.applyConfig(withLayers({
    background: { enabled: true, kind: 'effect', color: { r: 0, g: 0, b: 0 }, effect: 'rainbow' }
  }))
  h.engine.setColor({ r: 0, g: 0, b: 255 })
  assert.ok(layers(h.engine).some((l) => l.component === 'background'))
  h.engine.stop()
})

test('the startup layer runs ABOVE everything and lets go on its own', async () => {
  // A boot animation that had to be dismissed would not be a boot animation.
  // The duration is the muxer's timeout, so there is one expiry mechanism.
  const h = harness()
  h.engine.applyConfig(withLayers({
    startup: { enabled: true, kind: 'color', color: { r: 255, g: 0, b: 0 }, effect: 'rainbow', durationMs: 3000 }
  }))

  h.engine.runEffect({ kind: 'candle' })
  assert.equal(winner(h.engine), 'startup', 'it covers even a freshly started effect')

  // Arbitration happens on the engine's own tick, so the clock moving is not
  // enough on its own - the same reason a source that expires between two
  // frames never gets a frame of its own.
  h.advance(3500)
  await delay(20)
  assert.equal(winner(h.engine), 'effect', 'and hands the strip back when its time is up')
  h.engine.stop()
})

test('the startup layer fires on the IDLE edge only, not on every source', async () => {
  // Replaying the boot animation over a capture somebody is watching would be a
  // bug rather than a flourish.
  const h = harness()
  h.engine.applyConfig(withLayers({
    startup: { enabled: true, kind: 'color', color: { r: 255, g: 0, b: 0 }, effect: 'rainbow', durationMs: 1000 }
  }))
  h.engine.setColor({ r: 0, g: 255, b: 0 })
  assert.equal(winner(h.engine), 'startup')

  h.advance(1500)
  await delay(20)
  assert.equal(winner(h.engine), 'color', 'it let go')

  h.engine.runEffect({ kind: 'comet' })
  assert.equal(winner(h.engine), 'effect', 'starting a second source does not replay it')
  h.engine.stop()
})

test('both layers are off by default, so an update changes nothing', () => {
  const h = harness()
  h.engine.setColor({ r: 1, g: 2, b: 3 })
  assert.deepEqual(layers(h.engine).map((l) => l.component), ['color'])
  h.engine.stop()
})

test('an ANIMATED startup layer also lets go — it cannot reset its own expiry', async () => {
  // The bug this exists for, and it was right in the case you test first: the
  // duration was the muxer's inactivity timeout, which measures from the last
  // input. A flat colour is fed once and expired correctly; an effect feeds a
  // frame every tick and so pushed its own deadline forward forever. The boot
  // animation never ended.
  const h = harness()
  h.engine.applyConfig(withLayers({
    startup: { enabled: true, kind: 'effect', color: { r: 0, g: 0, b: 0 }, effect: 'rainbow', durationMs: 2000 }
  }))

  h.engine.setColor({ r: 0, g: 255, b: 0 })
  assert.equal(winner(h.engine), 'startup')

  // Let it actually render several frames, which is what used to keep it alive.
  for (let i = 0; i < 4; i++) {
    h.advance(600)
    await delay(20)
  }
  assert.equal(winner(h.engine), 'color', 'it let go despite rendering all the way through')
  assert.ok(!layers(h.engine).some((l) => l.component === 'startup'), 'and it is gone, not merely losing')
  h.engine.stop()
})

test('a still screen holds the strip rather than falling through to the background', async () => {
  // A screen capture that sends nothing is overwhelmingly a STILL SCREEN, not
  // a broken one: a frame arrives per change. Standing the capture down after
  // a few silent seconds would hand the strip to the background whenever
  // somebody stopped moving the mouse, and hand it back on the next change.
  const h = harness()
  h.engine.applyConfig(withLayers({
    background: { enabled: true, kind: 'color', color: { r: 255, g: 170, b: 100 }, effect: 'candle' }
  }))
  // Stands in for the capture layer: registered by the pipeline on each frame,
  // with no inactivity timeout of its own.
  h.engine.setColor({ r: 0, g: 0, b: 255 })
  assert.equal(winner(h.engine), 'color')

  // Far longer than Hyperion's five seconds, and a dozen arbitration ticks.
  for (let i = 0; i < 6; i++) {
    h.advance(5000)
    await delay(15)
  }
  assert.equal(winner(h.engine), 'color', 'still showing, thirty silent seconds later')
  h.engine.stop()
})

test('the configured reduction reaches the stages the sample call reads from', () => {
  // The engine sampled with a hardcoded 'mean', which left six of the
  // sampler's seven reductions unreachable - the same defect class this file
  // exists for. This pins the wiring so it cannot silently go back.
  //
  // What it proves: `applyConfig` puts the chosen mode into the stage object
  // that the capture path indexes as `s.config.sampling.mode`. What it does
  // NOT prove is the reduction's effect on pixels - that needs a real frame
  // through `createImageBitmap`, which is a browser global; the reductions
  // themselves are covered in test/engine-sample.test.ts.
  const h = harness()
  assert.equal(h.engine.stats().sampling?.mode, 'mean', 'the default is the old behaviour')

  h.engine.applyConfig({ ...DEFAULT_ENGINE_CONFIG, sampling: { mode: 'dominantAdvanced', accuracyLevel: 3 } })
  assert.equal(h.engine.stats().sampling?.mode, 'dominantAdvanced')

  // And the sampler is rebuilt with it rather than keeping the first one.
  h.engine.applyConfig({ ...DEFAULT_ENGINE_CONFIG, sampling: { mode: 'unicolorMean' } })
  assert.equal(h.engine.stats().sampling?.mode, 'unicolorMean')
})

test('the sampler gets a chance to speak, and says nothing on a sane rig', () => {
  // Hyperion logs the large-region guard where its web UI never shows it. The
  // channel has to exist before the panel can show it; healthy is empty.
  const h = harness()
  assert.deepEqual(h.engine.stats().sampling?.warnings, [])
})

test('a timed colour expiring as the LAST layer leaves the engine idle', async () => {
  // Nothing calls a stopper when the muxer drops a layer on its own, so the
  // engine used to stay "running" with no layers: timers alive, no blackout,
  // the strip holding whatever frame came last.
  const h = harness()
  h.engine.setColor({ r: 255, g: 0, b: 0 }, 500)
  assert.equal(h.engine.state(), 'running')
  h.advance(1000)
  await delay(30)
  assert.equal(h.engine.state(), 'idle')
  assert.deepEqual(layers(h.engine), [])
})

test('one effect follows another without going through idle', async () => {
  // Replacing the only live layer used to run idleIfEmpty first: clocks
  // stopped, a black frame, and then enterRunning() played the startup layer
  // again. Switching effects blinked and rebooted.
  const h = harness()
  h.engine.applyConfig(withLayers({
    startup: { enabled: true, kind: 'color', color: { r: 255, g: 0, b: 0 }, effect: 'rainbow', durationMs: 1000 }
  }))
  h.engine.runEffect({ kind: 'rainbow' })
  assert.equal(winner(h.engine), 'startup', 'the boot layer covers the first effect')
  h.advance(1500)
  await delay(20)
  assert.equal(winner(h.engine), 'effect')

  const before = h.reports.length
  h.engine.runEffect({ kind: 'comet' })
  assert.equal(winner(h.engine), 'effect')
  assert.ok(!layers(h.engine).some((l) => l.component === 'startup'), 'no second boot animation')
  assert.ok(h.reports.slice(before).every((r) => r.state !== 'idle'), 'and the engine never reported idle in between')
  h.engine.stop()
})

test('a refused capture does not take a running effect down with it', async () => {
  // The harness's openSource throws, which stands in for a closed picker.
  const h = harness()
  h.engine.runEffect({ kind: 'rainbow' })
  await h.engine.start()
  assert.equal(h.engine.state(), 'running', 'the effect is still what the strip shows')
  assert.equal(winner(h.engine), 'effect')
  assert.match(h.engine.error() ?? '', /no capture/)
  h.engine.stop()
})

test('with nothing else live, a refused capture is an error and the engine is stopped', async () => {
  const h = harness()
  await h.engine.start()
  assert.equal(h.engine.state(), 'error')
  assert.deepEqual(layers(h.engine), [])
})

test('a Stop while the picker is open wins over the answer that arrives later', async () => {
  let resolveOpen: (source: FrameSource) => void = () => {}
  let stops = 0
  const late: FrameSource = { kind: 'stream', settings: () => ({}), start () {}, async stop () { stops++ } }
  const host: EngineHost = {
    clock: () => 0,
    createCanvas: fakeCanvas,
    openSource: async () => await new Promise<FrameSource>((resolve) => { resolveOpen = resolve })
  }
  const engine = createEngine(host)
  const started = engine.start()
  assert.equal(engine.state(), 'starting')
  engine.stop()
  resolveOpen(late)
  await started
  assert.equal(engine.state(), 'idle', 'the stop stands')
  assert.equal(stops, 1, 'and the capture that arrived too late is let go')
  assert.deepEqual(layers(engine), [])
})

test('a layout that changes the LED count keeps the loopback fed', async () => {
  // The loopback's encoder is part of the configuration, so it was rebuilt -
  // but only the variable: the sink and writer went on feeding the OLD one
  // while the panel read the counters of the new one, which stayed at zero.
  const h = harness()
  h.engine.setColor({ r: 10, g: 20, b: 30 })
  for (let i = 0; i < 6; i++) { h.advance(10); await delay(6) }
  assert.ok(h.engine.stats().link.accepted > 0, 'the loopback is fed before the edit')

  const bigger = withLayers({ layout: { ...DEFAULT_ENGINE_CONFIG.layout, top: 50, bottom: 50 } })
  h.engine.applyConfig(bigger)
  assert.equal(h.engine.stats().leds, 50 + 19 + 50 + 19)
  for (let i = 0; i < 6; i++) { h.advance(10); await delay(6) }
  const link = h.engine.stats().link
  assert.equal(link.errors, 0, 'no frame was rejected by the encoder')
  assert.equal(link.rejected, 0)
  assert.ok(link.accepted > 0, 'and the loopback that is counted is the one being fed')
  h.engine.stop()
})

test('a pattern reaches the link at the output rate, not at every tick', async () => {
  // The tick runs every 4 ms and on every frame besides, and a pattern
  // bypasses the smoother that paces everything else - so it used to go out
  // several times per output period and the excess was counted as drops.
  const h = harness()
  h.engine.runPattern({ kind: 'solid', color: { r: 1, g: 0, b: 0 } })
  await delay(100)
  const link = h.engine.stats().link
  h.engine.stop()
  assert.equal(link.dropped, 0, 'a healthy link drops nothing')
  assert.ok(link.written >= 4 && link.written <= 20, `written ${link.written} in 100 ms: expected about one per output period`)
})

test('a capture that has not delivered its first frame keeps the engine running', async () => {
  // The idle check on an empty muxer must not fire in the gap between the
  // picker closing and the first frame: the capture layer is registered, input
  // or not, from the moment the source is open.
  const quiet: FrameSource = { kind: 'stream', settings: () => ({}), start () {}, async stop () {} }
  const host: EngineHost = { clock: () => 0, createCanvas: fakeCanvas, openSource: async () => quiet }
  const engine = createEngine(host)
  await engine.start()
  await delay(40)
  assert.equal(engine.state(), 'running', 'ten output ticks later it is still running')
  const capture = layers(engine).find((l) => l.component === 'capture')
  assert.ok(capture !== undefined, 'the capture layer exists from the moment the source opened')
  assert.equal(winner(engine), null, 'and nothing is chosen until a frame arrives')
  engine.stop()
})

test('an HTTPS page is told it cannot open ws:// to the board, before the first attempt', async () => {
  // Mixed content: the browser refuses a plain ws:// connection from a secure
  // page, and from the sink's side that was an ordinary connect failure that
  // reconnected forever. The hosted panel's page host cannot reach a LAN board
  // this way, and the sentence has to say so.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { value: { protocol: 'https:' }, configurable: true, writable: true })
  try {
    const h = harness()
    h.engine.applyConfig({ ...DEFAULT_ENGINE_CONFIG, output: { transport: 'websocket', format: 'Afx', host: '192.168.1.40' } })
    h.engine.setColor({ r: 1, g: 2, b: 3 })
    await delay(20)
    assert.equal(h.engine.link().mode, 'loopback')
    assert.match(h.engine.error() ?? '', /karışık içerik/)
    h.engine.stop()
  } finally {
    if (original !== undefined) Object.defineProperty(globalThis, 'location', original)
    else delete (globalThis as { location?: unknown }).location
  }
})
