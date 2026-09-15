import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ENGINE_CONFIG, MATRIX_ENGINE_CONFIG, serialiseEngineConfig, type EngineConfig } from '#lib/engine/config'
import {
  PROFILES_STORAGE_KEY,
  exportProfiles,
  importProfiles,
  isProfileId,
  loadProfiles,
  mergeProfiles,
  profileId,
  removeProfile,
  storeProfiles,
  upsertProfile,
  type Profile,
  type StorageLike
} from '#lib/profiles'

function memory (initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value },
    removeItem: (key) => { delete data[key] }
  }
}

const profile = (id: string, name: string, updatedAt: string, config: EngineConfig = DEFAULT_ENGINE_CONFIG as EngineConfig): Profile =>
  ({ id, name, config, updatedAt })

test('a name becomes an id the API would also accept', () => {
  assert.equal(profileId('Masaüstü'), 'Masaustu')
  assert.equal(profileId('Oyun Modu'), 'Oyun-Modu')
  assert.equal(profileId('  ---  '), 'profil')
  // Names in other scripts are ordinary here, and must not collapse to nothing.
  assert.equal(profileId('日本語'), 'profil')
  for (const name of ['Masaüstü', 'Oyun Modu', '日本語', 'a'.repeat(200)]) {
    assert.ok(isProfileId(profileId(name)), name)
  }
})

test('a clashing name gets a suffix instead of overwriting', () => {
  assert.equal(profileId('Sinema', ['Sinema']), 'Sinema-2')
  assert.equal(profileId('Sinema', ['Sinema', 'Sinema-2']), 'Sinema-3')
})

test('profiles round-trip through storage with their configs intact', () => {
  const storage = memory()
  const edited = { ...JSON.parse(serialiseEngineConfig(DEFAULT_ENGINE_CONFIG)), colorOrder: { order: 'grb' } } as EngineConfig
  const list = [profile('desk', 'Masaüstü', '2026-09-13T10:00:00Z'), profile('tv', 'TV', '2026-09-12T10:00:00Z', edited)]
  assert.equal(storeProfiles(list, storage), null)

  const back = loadProfiles(storage)
  assert.equal(back.problem, undefined)
  assert.equal(back.profiles.length, 2)
  assert.deepEqual(back.profiles[0]?.config, DEFAULT_ENGINE_CONFIG)
  assert.equal(back.profiles[1]?.config.colorOrder.order, 'grb')
})

test('one unreadable profile does not cost the others', () => {
  // A hand-edited or older-version entry among four must not lose the four.
  const good = JSON.parse(JSON.stringify([
    { id: 'a', name: 'A', config: serialiseEngineConfig(DEFAULT_ENGINE_CONFIG), updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'bad', name: 'B', config: '{"layout":{"kind":"spiral"}}', updatedAt: '' },
    { id: 'c', name: 'C', config: serialiseEngineConfig(MATRIX_ENGINE_CONFIG), updatedAt: '2026-01-02T00:00:00Z' }
  ]))
  const outcome = loadProfiles(memory({ [PROFILES_STORAGE_KEY]: JSON.stringify(good) }))
  assert.equal(outcome.profiles.length, 2)
  assert.deepEqual(outcome.profiles.map((p) => p.id), ['a', 'c'])
  assert.match(outcome.problem ?? '', /1 profil/)
})

test('junk in storage is reported, never thrown', () => {
  for (const bad of ['{not json', '{"a":1}', 'null']) {
    const outcome = loadProfiles(memory({ [PROFILES_STORAGE_KEY]: bad }))
    assert.deepEqual(outcome.profiles, [], bad)
    assert.ok((outcome.problem ?? '').length > 0, bad)
  }
})

test('a browser that refuses storage is not a broken panel', () => {
  const hostile: StorageLike = {
    getItem: () => { throw new Error('The operation is insecure.') },
    setItem: () => { throw new Error('The operation is insecure.') },
    removeItem: () => {}
  }
  assert.deepEqual(loadProfiles(hostile).profiles, [])
  assert.match(loadProfiles(hostile).problem ?? '', /insecure/)
  assert.match(storeProfiles([], hostile) ?? '', /insecure/)
  assert.deepEqual(loadProfiles(null), { profiles: [] })
  assert.equal(typeof storeProfiles([], null), 'string')
})

test('upsert replaces by id and puts the edited one first', () => {
  const list = [profile('a', 'A', '2026-01-01T00:00:00Z'), profile('b', 'B', '2026-01-02T00:00:00Z')]
  const next = upsertProfile(list, profile('b', 'B yeni', '2026-01-03T00:00:00Z'))
  assert.equal(next.length, 2)
  assert.equal(next[0]?.id, 'b')
  assert.equal(next[0]?.name, 'B yeni')
  assert.equal(removeProfile(next, 'b').length, 1)
})

test('merging two machines keeps the newer of each, never silently drops one', () => {
  const local = [profile('desk', 'Masaüstü (yerel)', '2026-09-13T12:00:00Z'), profile('only-local', 'Yalnız burada', '2026-09-01T00:00:00Z')]
  const remote = [profile('desk', 'Masaüstü (sunucu)', '2026-09-13T09:00:00Z'), profile('only-remote', 'Yalnız sunucuda', '2026-09-02T00:00:00Z')]
  const merged = mergeProfiles(local, remote)
  assert.equal(merged.length, 3)
  assert.equal(merged.find((p) => p.id === 'desk')?.name, 'Masaüstü (yerel)')
  assert.ok(merged.some((p) => p.id === 'only-local'))
  assert.ok(merged.some((p) => p.id === 'only-remote'))
  // Newest first, so the list reads as a history.
  assert.equal(merged[0]?.id, 'desk')
})

test('a profile that cannot say when it changed does not win', () => {
  const local = [profile('x', 'zamansız', '')]
  const remote = [profile('x', 'zamanlı', '2020-01-01T00:00:00Z')]
  assert.equal(mergeProfiles(local, remote)[0]?.name, 'zamanlı')
  assert.equal(mergeProfiles(remote, local)[0]?.name, 'zamanlı')
})

test('a profile file round-trips through export and import', () => {
  const edited = { ...JSON.parse(serialiseEngineConfig(DEFAULT_ENGINE_CONFIG)), colorOrder: { order: 'grb' } } as EngineConfig
  const list = [profile('desk', 'Masaüstü', '2026-09-13T10:00:00Z'), profile('tv', 'TV', '2026-09-12T10:00:00Z', edited)]
  const outcome = importProfiles(exportProfiles(list), [])
  assert.equal(outcome.added, 2)
  assert.equal(outcome.problem, undefined)
  assert.equal(outcome.profiles?.length, 2)
  assert.equal(outcome.profiles?.find((p) => p.id === 'tv')?.config.colorOrder.order, 'grb')
})

test('importing merges rather than replacing, and the newer side wins', () => {
  const mine = [profile('desk', 'Benim', '2026-09-13T12:00:00Z'), profile('only-mine', 'Yalnız bende', '2026-09-01T00:00:00Z')]
  const theirs = [profile('desk', 'Onunki', '2026-09-13T09:00:00Z'), profile('only-theirs', 'Yalnız onda', '2026-09-02T00:00:00Z')]
  const outcome = importProfiles(exportProfiles(theirs), mine)
  assert.equal(outcome.profiles?.length, 3)
  assert.equal(outcome.profiles?.find((p) => p.id === 'desk')?.name, 'Benim')
  assert.ok(outcome.profiles?.some((p) => p.id === 'only-mine'))
  assert.ok(outcome.profiles?.some((p) => p.id === 'only-theirs'))
})

test('a file that is not ours, or has nothing usable in it, is a failure not a silent no-op', () => {
  // "imported 0 profiles" reads as success and is not.
  for (const bad of ['{not json', '{"format":"something-else","profiles":[]}', '{"format":"ambiflux/profiles","profiles":[]}']) {
    const outcome = importProfiles(bad, [])
    assert.equal(outcome.profiles, null, bad)
    assert.equal(outcome.added, 0, bad)
    assert.ok((outcome.problem ?? '').length > 0, bad)
  }
})

test('one unreadable entry in a file does not cost the rest', () => {
  const doc = JSON.stringify({
    format: 'ambiflux/profiles',
    version: 1,
    profiles: [
      { id: 'a', name: 'A', config: JSON.parse(serialiseEngineConfig(DEFAULT_ENGINE_CONFIG)), updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'bad', name: 'B', config: { layout: { kind: 'spiral' } }, updatedAt: '2026-01-01T00:00:00Z' },
      { name: 'Adı var kimliği yok', config: JSON.parse(serialiseEngineConfig(MATRIX_ENGINE_CONFIG)), updatedAt: '2026-01-02T00:00:00Z' }
    ]
  })
  const outcome = importProfiles(doc, [])
  assert.equal(outcome.added, 2)
  assert.match(outcome.problem ?? '', /1 profil/)
  // The entry with no id got one derived from its name, and it is API-shaped.
  const derived = outcome.profiles?.find((p) => p.name === 'Adı var kimliği yok')
  assert.ok(derived !== undefined && isProfileId(derived.id))
})
