import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ENGINE_CONFIG, serialiseEngineConfig } from '#lib/engine/config'
import {
  MAX_INSTANCES,
  addInstance,
  defaultInstances,
  enabledInstances,
  findInstance,
  nextInstanceId,
  parseInstances,
  removeInstance,
  updateInstance
} from '#lib/engine/instances'

const one = defaultInstances()

test('a fresh install has exactly one strip, named and running', () => {
  assert.equal(one.length, 1)
  assert.equal(one[0]?.enabled, true)
  assert.notEqual(one[0]?.name, '')
  assert.deepEqual(one[0]?.config, DEFAULT_ENGINE_CONFIG)
})

test('a new strip copies the last one rather than the reference rig', () => {
  // Someone adding a second strip to the same desk has just finished
  // describing the first; making them type it again loses them at strip two.
  const edited = updateInstance(one, 'instance-1', {
    config: { ...DEFAULT_ENGINE_CONFIG, blacklist: [{ start: 3, length: 5 }] }
  })
  const two = addInstance(edited)
  assert.equal(two.length, 2)
  assert.deepEqual(two[1]?.config.blacklist, [{ start: 3, length: 5 }])
  assert.equal(two[1]?.id, 'instance-2')
})

test('ids skip the ones already taken, so a deleted strip does not come back', () => {
  const three = addInstance(addInstance(one))
  assert.deepEqual(three.map((i) => i.id), ['instance-1', 'instance-2', 'instance-3'])

  const gapped = removeInstance(three, 'instance-2')
  assert.equal(nextInstanceId(gapped), 'instance-2', 'the free slot is reused')
  // But the reused id must not inherit anything: the caller supplies the
  // config, and it is the neighbour's, not the deleted strip's.
  const filled = addInstance(gapped)
  assert.deepEqual(filled.map((i) => i.id), ['instance-1', 'instance-3', 'instance-2'])
})

test('the last strip cannot be removed, because no card can add one back', () => {
  assert.throws(() => removeInstance(one, 'instance-1'), /son şerit/)
  assert.throws(() => removeInstance(one, 'instance-9'), /diye bir şerit yok/)
})

test('a strip can be switched off without being deleted', () => {
  // The alternative is deleting a strip to silence it for an evening and then
  // typing its whole layout back in.
  const two = addInstance(one)
  const off = updateInstance(two, 'instance-2', { enabled: false })
  assert.equal(off.length, 2)
  assert.deepEqual(enabledInstances(off).map((i) => i.id), ['instance-1'])
})

test('renaming keeps the id, because stored state keys off the id', () => {
  const named = updateInstance(one, 'instance-1', { name: 'Masa' })
  assert.equal(named[0]?.id, 'instance-1')
  assert.equal(named[0]?.name, 'Masa')
  assert.equal(findInstance(named, 'instance-1')?.name, 'Masa')
  assert.equal(findInstance(named, 'nope'), null)
  // An `id` handed in as a change is ignored rather than honoured: a card that
  // spread a whole instance back in must not be able to renumber it.
  assert.equal(updateInstance(named, 'instance-1', { name: 'TV' } as never)[0]?.id, 'instance-1')
})

test('updating a strip that is not there is an error, not a silent no-op', () => {
  assert.throws(() => updateInstance(one, 'instance-9', { name: 'x' }), /diye bir şerit yok/)
})

test('there is a ceiling, and it is enforced where strips are added', () => {
  let list = one
  while (list.length < MAX_INSTANCES) list = addInstance(list)
  assert.equal(list.length, MAX_INSTANCES)
  assert.throws(() => addInstance(list), /en fazla/)
})

// ---------------------------------------------------------------------------
// The wire.
// ---------------------------------------------------------------------------

const stored = (over: Record<string, unknown> = {}): unknown => ({
  id: 'instance-1',
  name: 'Masa',
  enabled: true,
  config: JSON.parse(serialiseEngineConfig(DEFAULT_ENGINE_CONFIG)),
  ...over
})

test('a stored list is validated, because storage is a trust boundary', () => {
  const parsed = parseInstances([stored(), stored({ id: 'instance-2', name: '  TV  ', enabled: false })])
  assert.equal(parsed.length, 2)
  assert.equal(parsed[1]?.name, 'TV', 'trimmed, so a name that is all spaces is not a name')
  assert.equal(parsed[1]?.enabled, false)

  assert.throws(() => parseInstances('masa ve tv'), /bir dizi olmalı/)
  assert.throws(() => parseInstances([]), /en az bir şerit/)
  assert.throws(() => parseInstances([stored(), stored()]), /iki kez geçiyor/)
  assert.throws(() => parseInstances([null]), /bir nesne olmalı/)
})

test('a missing id or name is filled in, but a bad config is refused by name', () => {
  const parsed = parseInstances([{ config: JSON.parse(serialiseEngineConfig(DEFAULT_ENGINE_CONFIG)) }])
  assert.equal(parsed[0]?.id, 'instance-1')
  assert.equal(parsed[0]?.enabled, true, 'enabled defaults to on')
  assert.notEqual(parsed[0]?.name, '')

  // The ConfigError names the field rather than being swallowed into
  // "instance 2 is invalid", which would hide which knob is wrong.
  assert.throws(
    () => parseInstances([stored({ config: { ...JSON.parse(serialiseEngineConfig(DEFAULT_ENGINE_CONFIG)), blacklist: 'hepsi' } })]),
    /blacklist/
  )
})

test('a list longer than the ceiling is refused on the way in as well', () => {
  const many = Array.from({ length: MAX_INSTANCES + 1 }, (_, n) => stored({ id: `instance-${n + 1}` }))
  assert.throws(() => parseInstances(many), /en fazla/)
})
