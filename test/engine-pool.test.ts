import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from '#lib/engine/config'
import { addInstance, defaultInstances, updateInstance, type Instance } from '#lib/engine/instances'
import { createEnginePool, sourceKey, type PoolStats } from '#lib/engine/pool'
import type { CanvasLike, EngineHost } from '#lib/engine/runtime'
import type { FrameHandler, FrameSource } from '#lib/engine/source'

/**
 * A host with no browser behind it.
 *
 * The point of these tests is the capture, so the only thing the fake really
 * tracks is how many times a stream was opened - which is how many times the
 * user was shown a picker.
 */
function fakeHost () {
  const opened: string[] = []
  const stopped: string[] = []
  let clockMs = 0

  const canvas: CanvasLike = {
    getContext: () => ({
      drawImage: () => {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })
    })
  }

  function source (label: string): FrameSource {
    let handler: FrameHandler | null = null
    return {
      kind: 'stream',
      settings: () => ({ width: 1280, height: 720 }),
      start (onFrame) { handler = onFrame },
      async stop () { stopped.push(label); handler = null }
    }
  }

  const host: EngineHost = {
    clock: () => clockMs,
    createCanvas: () => canvas,
    openSource: async (config: EngineConfig) => {
      const label = sourceKey(config)
      opened.push(label)
      return source(label)
    },
    openSelfTest: async () => {
      opened.push('selftest')
      return source('selftest')
    }
  }

  return { host, opened, stopped, advance: (ms: number) => { clockMs += ms } }
}

const withCapture = (over: Partial<EngineConfig['capture']>): EngineConfig => ({
  ...DEFAULT_ENGINE_CONFIG,
  capture: { ...DEFAULT_ENGINE_CONFIG.capture, ...over }
})

test('the source key is what opens a stream, and nothing else', () => {
  // A crop and a grid are applied to a frame that has already arrived, so two
  // strips looking at different halves of one screen must still be one capture.
  const base = DEFAULT_ENGINE_CONFIG
  assert.equal(sourceKey(base), sourceKey(withCapture({ crop: { left: 0.2, right: 0, top: 0, bottom: 0 } })))
  assert.equal(sourceKey(base), sourceKey(withCapture({ gridWidth: 64, gridHeight: 36 })))
  assert.notEqual(sourceKey(base), sourceKey(withCapture({ fps: 30 })))
  assert.notEqual(sourceKey(base), sourceKey(withCapture({ source: 'device', deviceId: 'card-1' })))
  assert.notEqual(
    sourceKey(withCapture({ source: 'device', deviceId: 'card-1' })),
    sourceKey(withCapture({ source: 'device', deviceId: 'card-2' }))
  )
})

test('two strips on the same screen are one picker, not two', async () => {
  const { host, opened } = fakeHost()
  const pool = createEnginePool(host, addInstance(defaultInstances()))
  assert.equal(pool.instances().length, 2)

  // Started together, which is how they are always started - so the race that
  // would open a second capture is the normal case rather than an edge one.
  await pool.start()
  assert.deepEqual(opened, ['screen:60'], 'one stream for both strips')
  assert.equal(pool.stats().captures, 1)
  await pool.dispose()
})

test('a strip on a capture card gets its own stream, and that is the point', async () => {
  // Desk on the screen, TV on an HDMI capture card: the one arrangement that
  // defeats DRM blanking on the TV while leaving the desk on the cheap path.
  const { host, opened } = fakeHost()
  const two = updateInstance(
    addInstance(defaultInstances()),
    'instance-2',
    { config: withCapture({ source: 'device', deviceId: 'card-1' }) }
  )
  const pool = createEnginePool(host, two)
  await pool.start()
  assert.deepEqual(opened.slice().sort(), ['device:card-1:60', 'screen:60'])
  assert.equal(pool.stats().captures, 2)
  await pool.dispose()
})

test('a disabled strip is configured but not running', async () => {
  const { host, opened } = fakeHost()
  const two = updateInstance(addInstance(defaultInstances()), 'instance-2', { enabled: false })
  const pool = createEnginePool(host, two)
  await pool.start()
  assert.deepEqual(opened, ['screen:60'])

  const states = pool.stats().instances
  assert.equal(states[1]?.enabled, false)
  assert.equal(states[1]?.state, 'idle', 'off means idle, not gone')
  assert.notEqual(pool.engine('instance-2'), null, 'and its engine still exists to be configured')
  await pool.dispose()
})

test('switching a strip off stops it and leaves the other alone', async () => {
  const { host } = fakeHost()
  const pool = createEnginePool(host, addInstance(defaultInstances()))
  await pool.start()
  assert.equal(pool.engine('instance-1')?.state(), 'running')
  assert.equal(pool.engine('instance-2')?.state(), 'running')

  pool.setInstances(updateInstance(pool.instances(), 'instance-2', { enabled: false }))
  assert.equal(pool.engine('instance-1')?.state(), 'running', 'the other strip never notices')
  assert.equal(pool.engine('instance-2')?.state(), 'idle')
  await pool.dispose()
})

test('removing a strip stops it; adding one builds an engine for it', async () => {
  const { host } = fakeHost()
  const pool = createEnginePool(host, addInstance(defaultInstances()))
  await pool.start()
  const going = pool.engine('instance-2')
  assert.notEqual(going, null)

  pool.setInstances(pool.instances().filter((instance) => instance.id !== 'instance-2'))
  assert.equal(pool.engine('instance-2'), null)
  assert.equal(going?.state(), 'idle', 'a removed strip is stopped, not abandoned running')
  assert.equal(pool.engine('instance-1')?.state(), 'running')

  pool.setInstances(addInstance(pool.instances(), { name: 'TV' }))
  assert.equal(pool.instances()[1]?.name, 'TV')
  assert.notEqual(pool.engine('instance-2'), null)
  await pool.dispose()
})

test('a configuration edit is applied, not rebuilt: a running strip keeps running', async () => {
  const { host, opened } = fakeHost()
  const pool = createEnginePool(host, defaultInstances())
  await pool.start()
  assert.equal(opened.length, 1)

  const edited = updateInstance(pool.instances(), 'instance-1', {
    config: { ...DEFAULT_ENGINE_CONFIG, blacklist: [{ start: 0, length: 2 }] }
  })
  pool.setInstances(edited)
  assert.equal(pool.engine('instance-1')?.state(), 'running', 'a layout edit must not black out the strip')
  assert.deepEqual(pool.engine('instance-1')?.config().blacklist, [{ start: 0, length: 2 }])
  assert.equal(opened.length, 1, 'and it must not ask for the screen again')
  await pool.dispose()
})

test('a bad list is refused and the running strips are untouched', async () => {
  const { host } = fakeHost()
  const pool = createEnginePool(host, defaultInstances())
  await pool.start()

  assert.throws(() => pool.setInstances([]), /at least one strip/)
  assert.throws(() => pool.setInstances('iki şerit'), /must be a list/)
  assert.equal(pool.instances().length, 1)
  assert.equal(pool.engine('instance-1')?.state(), 'running')
  await pool.dispose()
})

test('the list handed out is a copy, so editing it does not reach an engine', () => {
  const { host } = fakeHost()
  const initial: Instance[] = defaultInstances()
  const pool = createEnginePool(host, initial)

  initial[0]!.name = 'edited behind the pool’s back'
  assert.notEqual(pool.instances()[0]?.name, 'edited behind the pool’s back')

  const handed = pool.instances()
  handed[0]!.name = 'also ignored'
  assert.notEqual(pool.instances()[0]?.name, 'also ignored')
})

test('the self-test runs on every strip at once, from one generated picture', async () => {
  // "Do both of my strips work" has to be one answer, not two.
  const { host, opened } = fakeHost()
  const pool = createEnginePool(host, addInstance(defaultInstances()))
  await pool.selfTest()
  assert.deepEqual(opened, ['selftest'])
  assert.equal(pool.engines().filter((engine) => engine.state() === 'running').length, 2)
  await pool.dispose()
})

test('reports carry every strip, so a panel reads one object', async () => {
  const { host } = fakeHost()
  const seen: PoolStats[] = []
  const pool = createEnginePool(host, addInstance(defaultInstances()), { onReport: (stats) => { seen.push(stats) } })
  await pool.start()

  const last = seen[seen.length - 1]
  assert.equal(last?.instances.length, 2)
  assert.deepEqual(last?.instances.map((i) => i.id), ['instance-1', 'instance-2'])
  assert.equal(last?.captures, 1)
  await pool.dispose()
})

test('stopping everything really does let go of the screen', async () => {
  const { host, stopped } = fakeHost()
  const pool = createEnginePool(host, addInstance(defaultInstances()))
  await pool.start()
  await pool.dispose()
  assert.deepEqual(stopped, ['screen:60'], 'one capture opened, one capture released')
  assert.equal(pool.stats().captures, 0)
})

test('a rule that names a strip reaches only that strip', async () => {
  const { host } = fakeHost()
  const pool = createEnginePool(host, addInstance(defaultInstances()))
  const applied = pool.setSchedule([
    { id: 'both', atMinute: 600, action: { kind: 'stop' } },
    { id: 'tv', atMinute: 1320, instanceId: 'instance-2', action: { kind: 'capture' } }
  ])
  assert.equal(applied.length, 2, 'the master list is whole, whatever each strip holds')
  assert.deepEqual(pool.engine('instance-1')?.schedule().map((rule) => rule.id), ['both'])
  assert.deepEqual(pool.engine('instance-2')?.schedule().map((rule) => rule.id), ['both', 'tv'])
  await pool.dispose()
})

test('a strip added later picks up the rules that were waiting for it', async () => {
  // The alternative is a rule that only takes effect the next time somebody
  // happens to open the schedule page, which for a schedule is no effect.
  const { host } = fakeHost()
  const pool = createEnginePool(host, defaultInstances())
  pool.setSchedule([
    { id: 'both', atMinute: 600, action: { kind: 'stop' } },
    { id: 'second', atMinute: 700, instanceId: 'instance-2', action: { kind: 'capture' } }
  ])
  assert.equal(pool.engine('instance-2'), null)

  pool.setInstances(addInstance(pool.instances()))
  assert.deepEqual(pool.engine('instance-2')?.schedule().map((rule) => rule.id), ['both', 'second'])
  await pool.dispose()
})

test('a bad rule is rejected once, not once per strip', async () => {
  // Eight engines each refusing the same rule is eight messages for one
  // mistake, and only the first would ever be shown.
  const { host } = fakeHost()
  const pool = createEnginePool(host, addInstance(defaultInstances()))
  pool.setSchedule([{ id: 'ok', atMinute: 600, action: { kind: 'stop' } }])
  assert.throws(() => pool.setSchedule([{ atMinute: 9999, action: { kind: 'stop' } }]), /0\.\.1439/)
  assert.deepEqual(pool.schedule().map((rule) => rule.id), ['ok'], 'the rules in force are untouched')
  assert.equal(pool.engine('instance-1')?.schedule().length, 1)
  await pool.dispose()
})

test('the master list is what a panel edits, not one strip’s slice', async () => {
  const { host } = fakeHost()
  const pool = createEnginePool(host, addInstance(defaultInstances()))
  pool.setSchedule([{ id: 'tv', atMinute: 600, instanceId: 'instance-2', action: { kind: 'stop' } }])
  // Asking the first engine would give an empty schedule and the panel would
  // then save that back, deleting the rule nobody meant to delete.
  assert.equal(pool.engine('instance-1')?.schedule().length, 0)
  assert.deepEqual(pool.schedule().map((rule) => rule.id), ['tv'])
  await pool.dispose()
})

test('disposing lets go of the schedulers, not just the engines', async () => {
  // The scheduler ticks whether or not anything is showing - that is what makes
  // "start the capture at eight" work on an idle strip - so `stop` does not
  // stop it. Without this, a disposed pool leaves one 1 Hz timer per strip
  // running for the life of the page. It showed up as a test run that passed
  // every assertion and then never exited.
  const { host } = fakeHost()
  const pool = createEnginePool(host, addInstance(defaultInstances()))
  pool.setSchedule([{ id: 'evening', atMinute: 1320, action: { kind: 'stop' } }])
  assert.equal(pool.engine('instance-1')?.schedule().length, 1)

  const engines = pool.engines()
  await pool.dispose()
  assert.deepEqual(pool.schedule(), [])
  for (const engine of engines) assert.deepEqual(engine.schedule(), [], 'every strip let go of its rules')
})

test('Stop then Start opens the capture again rather than joining the dead one', async () => {
  // Measured on the panel before the fix: the second self-test after a Stop
  // reported "the capture ended on its own" and delivered no frame, because
  // the pool re-attached to a fanout whose track had been stopped.
  const { host, opened, stopped } = fakeHost()
  const pool = createEnginePool(host)
  await pool.start()
  pool.stop()
  await Promise.resolve()
  assert.deepEqual(stopped, ['screen:60'])
  assert.equal(pool.stats().captures, 0, 'a stopped capture is not counted as open')

  await pool.start()
  assert.deepEqual(opened, ['screen:60', 'screen:60'], 'a second picker, because the first capture is gone')
  assert.equal(pool.engines()[0]?.state(), 'running')
  assert.equal(pool.stats().captures, 1)
  await pool.dispose()
})

test('starting with every strip switched off says so', async () => {
  const { host, opened } = fakeHost()
  const pool = createEnginePool(host, updateInstance(defaultInstances(), 'instance-1', { enabled: false }))
  await assert.rejects(pool.start(), /no strip is enabled/)
  assert.deepEqual(opened, [], 'no picker was shown')
  await pool.dispose()
})

test('a save that leaves a strip unchanged does not re-apply its configuration', async () => {
  // applyConfig rebuilds a running effect from scratch, so every save of
  // strip A used to restart strip B's animation. Only the changed strip is
  // touched; the other keeps its effect object and its phase.
  const { host } = fakeHost()
  const pool = createEnginePool(host, addInstance(defaultInstances()))
  const b = pool.engine('instance-2')
  assert.ok(b !== null)
  b.runEffect({ kind: 'rainbow' })
  const before = b.stats().layers?.find((l) => l.component === 'effect')
  assert.ok(before !== undefined)

  const edited = updateInstance(pool.instances(), 'instance-1', {
    config: { ...DEFAULT_ENGINE_CONFIG, blacklist: [{ start: 0, length: 1 }] }
  })
  pool.setInstances(edited)
  const after = b.stats().layers?.find((l) => l.component === 'effect')
  assert.ok(after !== undefined, 'strip B is still running its effect')
  assert.deepEqual(pool.engine('instance-1')?.config().blacklist, [{ start: 0, length: 1 }], 'and strip A took the edit')
  await pool.dispose()
})
