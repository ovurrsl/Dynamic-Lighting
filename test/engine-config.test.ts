import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ConfigError,
  DEFAULT_ENGINE_CONFIG,
  MATRIX_ENGINE_CONFIG,
  configLedCount,
  deserialiseEngineConfig,
  parseEngineConfig,
  resolveLayout,
  serialiseEngineConfig,
  type EngineConfig
} from '#lib/engine/config'
import { DARK_RECT, REFERENCE_LAYOUT, classicLayout, matrixLayout } from '#lib/engine/layout'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const classic = (over: Record<string, unknown> = {}): unknown =>
  ({ ...clone(DEFAULT_ENGINE_CONFIG), layout: { ...clone(DEFAULT_ENGINE_CONFIG.layout), ...over } })

/** The path a ConfigError names, so a test can assert on the field rather than the prose. */
function pathOf (run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof ConfigError) return error.path
    throw error
  }
  throw new Error('expected a ConfigError')
}

test('the default config is the reference rig and resolves to the same rectangles as the generator', () => {
  const config = parseEngineConfig(clone(DEFAULT_ENGINE_CONFIG))
  assert.equal(configLedCount(config), 108)
  assert.deepEqual(resolveLayout(config), classicLayout(REFERENCE_LAYOUT))
  assert.equal(config.layout.kind, 'classic')
  assert.deepEqual(config.blacklist, [])
  assert.deepEqual(config.colorOrder, { order: 'rgb' })
})

test('the matrix default resolves through the matrix generator', () => {
  const config = parseEngineConfig(clone(MATRIX_ENGINE_CONFIG))
  assert.equal(configLedCount(config), 16 * 9)
  assert.equal(config.layout.kind, 'matrix')
  assert.deepEqual(resolveLayout(config), matrixLayout({ ...MATRIX_ENGINE_CONFIG.layout, kind: undefined } as never))
})

test('a gap shortens the strip and configLedCount says so before anything is built', () => {
  const config = parseEngineConfig(classic({ gap: { position: 70, length: 4 } }))
  assert.equal(configLedCount(config), 104)
  assert.equal(resolveLayout(config).length, 104)
})

test('the blacklist keeps the wire length and darkens what it names', () => {
  const config = parseEngineConfig({ ...clone(DEFAULT_ENGINE_CONFIG), blacklist: [{ start: 10, length: 2 }] })
  const rects = resolveLayout(config)
  assert.equal(rects.length, 108, 'the cable did not get shorter')
  assert.deepEqual(rects[10], DARK_RECT)
  assert.deepEqual(rects[11], DARK_RECT)
  assert.deepEqual(rects[12], classicLayout(REFERENCE_LAYOUT)[12])
})

test('every optional knob survives a round trip through JSON', () => {
  const rich: EngineConfig = parseEngineConfig(classic({
    offset: 7,
    overlap: 0.02,
    edgeGap: 0.03,
    aspectRatio: 21 / 9,
    keystone: {
      topLeft: { x: 0.01, y: 0.02 },
      topRight: { x: 0.99, y: 0.03 },
      bottomRight: { x: 0.98, y: 0.97 },
      bottomLeft: { x: 0.02, y: 0.96 }
    },
    gap: { position: 5, length: 3 }
  }))
  const back = deserialiseEngineConfig(serialiseEngineConfig(rich))
  assert.deepEqual(back, rich)
  assert.deepEqual(resolveLayout(back), resolveLayout(rich))

  const withOrder = parseEngineConfig({
    ...clone(DEFAULT_ENGINE_CONFIG),
    colorOrder: { order: 'grb', overrides: { 54: 'bgr', 55: 'bgr' } }
  })
  assert.deepEqual(deserialiseEngineConfig(serialiseEngineConfig(withOrder)), withOrder)
  assert.deepEqual(withOrder.colorOrder.overrides, { 54: 'bgr', 55: 'bgr' })
})

test('absent optional sections default rather than fail: a layout alone is a config', () => {
  const config = parseEngineConfig({ layout: clone(DEFAULT_ENGINE_CONFIG.layout) })
  assert.deepEqual(config.blacklist, [])
  assert.deepEqual(config.colorOrder, { order: 'rgb' })
})

test('a bad field is a ConfigError naming its path, not a cast that lights the wrong LEDs', () => {
  assert.equal(pathOf(() => parseEngineConfig(null)), 'config')
  assert.equal(pathOf(() => parseEngineConfig([])), 'config')
  assert.equal(pathOf(() => parseEngineConfig({})), 'config.layout')
  assert.equal(pathOf(() => parseEngineConfig({ layout: { kind: 'spiral' } })), 'layout.kind')
  assert.equal(pathOf(() => parseEngineConfig(classic({ top: 1.5 }))), 'layout.top')
  assert.equal(pathOf(() => parseEngineConfig(classic({ top: '35' }))), 'layout.top')
  assert.equal(pathOf(() => parseEngineConfig(classic({ start: 'middle' }))), 'layout.start')
  assert.equal(pathOf(() => parseEngineConfig(classic({ clockwise: 'yes' }))), 'layout.clockwise')
  assert.equal(pathOf(() => parseEngineConfig(classic({ depthTopBottom: 'deep' }))), 'layout.depthTopBottom')
  assert.equal(pathOf(() => parseEngineConfig(classic({ offset: 0.5 }))), 'layout.offset')
  assert.equal(pathOf(() => parseEngineConfig(classic({ keystone: { topLeft: { x: 0 } } }))), 'layout.keystone.topLeft.y')
  assert.equal(pathOf(() => parseEngineConfig(classic({ gap: { position: 1 } }))), 'layout.gap.length')
  assert.equal(pathOf(() => parseEngineConfig({ ...clone(DEFAULT_ENGINE_CONFIG), blacklist: 'none' })), 'blacklist')
  assert.equal(pathOf(() => parseEngineConfig({ ...clone(DEFAULT_ENGINE_CONFIG), blacklist: [{ start: 1 }] })), 'blacklist[0].length')
  assert.equal(pathOf(() => parseEngineConfig({ ...clone(DEFAULT_ENGINE_CONFIG), colorOrder: { order: 'rbz' } })), 'colorOrder.order')
  assert.equal(pathOf(() => parseEngineConfig({ ...clone(DEFAULT_ENGINE_CONFIG), colorOrder: { order: 'rgb', overrides: { x: 'bgr' } } })), 'colorOrder.overrides.x')

  const matrix = clone(MATRIX_ENGINE_CONFIG)
  assert.equal(pathOf(() => parseEngineConfig({ ...matrix, layout: { ...matrix.layout, cabling: 'woven' } })), 'layout.cabling')
  assert.equal(pathOf(() => parseEngineConfig({ ...matrix, layout: { ...matrix.layout, direction: 'diagonal' } })), 'layout.direction')
  assert.equal(pathOf(() => parseEngineConfig({ ...matrix, layout: { ...matrix.layout, columns: 0 } })), 'layout.columns')
})

test('a layout whose fields are all well typed but cannot be built is still a ConfigError, with the generator\'s own message', () => {
  // The generator owns these rules, so the message comes from it rather than
  // from a second copy here that could drift.
  const deep = pathOf(() => parseEngineConfig(classic({ depthTopBottom: 0.9 })))
  assert.equal(deep, 'layout')
  const empty = pathOf(() => parseEngineConfig(classic({ top: 0, right: 0, bottom: 0, left: 0 })))
  assert.equal(empty, 'layout')
  assert.throws(() => parseEngineConfig(classic({ depthTopBottom: 0.9 })), /depthTopBottom must be in \(0, 0\.5\]/)

  // A gap past the end of the strip, and a blacklist past the end of it.
  assert.equal(pathOf(() => parseEngineConfig(classic({ gap: { position: 100, length: 20 } }))), 'layout')
  assert.equal(pathOf(() => parseEngineConfig({ ...clone(DEFAULT_ENGINE_CONFIG), blacklist: [{ start: 200, length: 1 }] })), 'blacklist')
  // An override for a LED the layout does not have.
  assert.equal(
    pathOf(() => parseEngineConfig({ ...clone(DEFAULT_ENGINE_CONFIG), colorOrder: { order: 'rgb', overrides: { 108: 'bgr' } } })),
    'colorOrder.overrides.108'
  )
  // ... and one that a gap just took out.
  assert.equal(
    pathOf(() => parseEngineConfig({
      ...clone(DEFAULT_ENGINE_CONFIG),
      layout: { ...clone(DEFAULT_ENGINE_CONFIG.layout), gap: { position: 0, length: 10 } },
      colorOrder: { order: 'rgb', overrides: { 100: 'bgr' } }
    })),
    'colorOrder.overrides.100'
  )
})

test('bad JSON is a ConfigError, not whatever JSON.parse throws', () => {
  assert.equal(pathOf(() => deserialiseEngineConfig('{not json')), 'config')
  assert.equal(pathOf(() => deserialiseEngineConfig('null')), 'config')
  assert.equal(pathOf(() => deserialiseEngineConfig('"a string"')), 'config')
  assert.throws(() => deserialiseEngineConfig('{not json'), ConfigError)
})

test('parsing does not keep a reference to the caller\'s object', () => {
  const raw = clone(DEFAULT_ENGINE_CONFIG) as unknown as { layout: Record<string, unknown>, blacklist: unknown[] }
  const config = parseEngineConfig(raw)
  raw.layout.top = 1
  raw.blacklist.push({ start: 0, length: 1 })
  assert.equal((config.layout as { top: number }).top, 35, 'the parsed config is its own')
  assert.deepEqual(config.blacklist, [])
})
