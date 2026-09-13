import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONFIG_STORAGE_KEY,
  clearStoredConfig,
  loadStoredConfig,
  storeConfig,
  type StorageLike
} from '#lib/config-store'
import { DEFAULT_ENGINE_CONFIG, parseEngineConfig, serialiseEngineConfig } from '#lib/engine/config'

function memoryStorage (initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value },
    removeItem: (key) => { delete data[key] }
  }
}

/** A private window with site data blocked: every access throws. */
const hostileStorage: StorageLike = {
  getItem: () => { throw new Error('The operation is insecure.') },
  setItem: () => { throw new Error('The operation is insecure.') },
  removeItem: () => { throw new Error('The operation is insecure.') }
}

const fullStorage: StorageLike = {
  getItem: () => null,
  setItem: () => { throw new Error('QuotaExceededError') },
  removeItem: () => {}
}

test('nothing stored is the reference rig, and storing then loading round-trips it', () => {
  const storage = memoryStorage()
  const fresh = loadStoredConfig(storage)
  assert.equal(fresh.source, 'default')
  assert.deepEqual(fresh.config, DEFAULT_ENGINE_CONFIG)

  const edited = parseEngineConfig({
    ...JSON.parse(serialiseEngineConfig(DEFAULT_ENGINE_CONFIG)),
    layout: { ...JSON.parse(serialiseEngineConfig(DEFAULT_ENGINE_CONFIG)).layout, top: 40, bottom: 40 },
    colorOrder: { order: 'grb' }
  })
  assert.equal(storeConfig(edited, storage), null)
  assert.ok(storage.data[CONFIG_STORAGE_KEY]?.includes('"top":40'))

  const back = loadStoredConfig(storage)
  assert.equal(back.source, 'stored')
  assert.deepEqual(back.config, edited)
})

test('a stored config this version cannot read falls back and reports the problem', () => {
  // Written by an older version, or hand-edited: the panel must still render.
  for (const bad of ['{not json', '{"layout":{"kind":"spiral"}}', 'null', '{"layout":{"kind":"classic","top":-1}}']) {
    const outcome = loadStoredConfig(memoryStorage({ [CONFIG_STORAGE_KEY]: bad }))
    assert.equal(outcome.source, 'default', bad)
    assert.deepEqual(outcome.config, DEFAULT_ENGINE_CONFIG, bad)
    assert.ok('problem' in outcome && typeof outcome.problem === 'string' && outcome.problem.length > 0, `${bad} must say why`)
  }
})

test('a browser that refuses storage is not a broken panel', () => {
  const outcome = loadStoredConfig(hostileStorage)
  assert.equal(outcome.source, 'default')
  assert.deepEqual(outcome.config, DEFAULT_ENGINE_CONFIG)
  assert.ok('problem' in outcome, 'the refusal is reported, not swallowed')

  assert.match(storeConfig(DEFAULT_ENGINE_CONFIG, hostileStorage) ?? '', /insecure/)
  assert.match(storeConfig(DEFAULT_ENGINE_CONFIG, fullStorage) ?? '', /Quota/)
  // And with no storage at all - a server render - it is the reference rig.
  assert.deepEqual(loadStoredConfig(null), { config: DEFAULT_ENGINE_CONFIG, source: 'default' })
  assert.equal(typeof storeConfig(DEFAULT_ENGINE_CONFIG, null), 'string')

  // Clearing never throws, whatever the storage does.
  clearStoredConfig(hostileStorage)
  clearStoredConfig(null)
})

test('clearing takes the stored config away and the next load is the default again', () => {
  const storage = memoryStorage()
  storeConfig(DEFAULT_ENGINE_CONFIG, storage)
  assert.equal(loadStoredConfig(storage).source, 'stored')
  clearStoredConfig(storage)
  assert.equal(loadStoredConfig(storage).source, 'default')
})
