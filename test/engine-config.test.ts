import assert from 'node:assert/strict'
import test from 'node:test'

import { ConfigError, DEFAULT_CAPTURE, DEFAULT_ENGINE_CONFIG, DEFAULT_SMOOTHING, FPS_MAX, GRID_MAX, GRID_MIN, MATRIX_ENGINE_CONFIG, WIRE_FORMATS, configLedCount, deserialiseEngineConfig, parseEngineConfig, resolveLayout, serialiseEngineConfig, switchTransport, type EngineConfig } from '#lib/engine/config'
import { DARK_RECT, REFERENCE_LAYOUT, classicLayout, matrixLayout } from '#lib/engine/layout'
import { SMOOTHING_PROFILES, profileOf } from '#lib/engine/smooth'

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

test('the wire format defaults to Afx and only accepts the three it can encode', () => {
  // Afx is ours and the only one carrying 16-bit linear. The other two exist so
  // AmbiFlux drives hardware somebody already owns, which is the whole point of
  // the setting.
  assert.equal(parseEngineConfig(DEFAULT_ENGINE_CONFIG).output.format, 'Afx')
  for (const format of WIRE_FORMATS) {
    const config = parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, output: { format } })
    assert.equal(config.output.format, format)
  }
  assert.throws(
    () => parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, output: { format: 'Tpm2' } }),
    /output.format/
  )
})

test('AWA calibration is accepted for Awa and refused for the formats that cannot carry it', () => {
  const calibration = { limit: 255, red: 255, green: 240, blue: 220 }
  const ok = parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, output: { format: 'Awa', calibration } })
  assert.deepEqual(ok.output.calibration, calibration)
  // Silently dropping it would leave someone staring at a white balance that
  // does nothing, which is worse than being told.
  for (const format of ['Afx', 'Ada'] as const) {
    assert.throws(
      () => parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, output: { format, calibration } }),
      /only carried by the Awa format/
    )
  }
  assert.throws(
    () => parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, output: { format: 'Awa', calibration: { ...calibration, red: 256 } } }),
    /calibration.red/
  )
})

test('capture settings default to the reference grid and are bounded', () => {
  const config = parseEngineConfig(DEFAULT_ENGINE_CONFIG)
  assert.deepEqual(config.capture, DEFAULT_CAPTURE)

  const custom = parseEngineConfig({
    ...DEFAULT_ENGINE_CONFIG,
    capture: { gridWidth: 96, gridHeight: 54, fps: 30, crop: { left: 0.1, right: 0, top: 0, bottom: 0.2 } }
  })
  assert.equal(custom.capture.gridWidth, 96)
  assert.equal(custom.capture.fps, 30)
  assert.equal(custom.capture.crop.bottom, 0.2)

  for (const bad of [
    { gridWidth: GRID_MIN - 1 }, { gridWidth: GRID_MAX + 1 }, { gridHeight: 0 },
    { fps: 0 }, { fps: FPS_MAX + 1 }, { gridWidth: 100.5 }
  ]) {
    assert.throws(
      () => parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, capture: { ...DEFAULT_CAPTURE, ...bad } }),
      /capture\./,
      JSON.stringify(bad)
    )
  }
})

test('a crop that would leave nothing on screen is refused as a pair, not per side', () => {
  // Each side is capped at 0.45, and 0.45 + 0.45 is legal per side while
  // leaving a tenth of the screen. The pair is what has to be checked.
  const crop = (over: Record<string, number>) =>
    parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, capture: { ...DEFAULT_CAPTURE, crop: { left: 0, right: 0, top: 0, bottom: 0, ...over } } })

  assert.doesNotThrow(() => crop({ left: 0.45, right: 0.45 }))
  assert.throws(() => crop({ left: 0.45, right: 0.46 }), /capture.crop.right/)
  assert.throws(() => crop({ left: 0.5 }), /capture.crop.left/)
  assert.throws(() => crop({ top: -0.1 }), /capture.crop.top/)
})

test('an old stored config with neither section still loads', () => {
  // The extension stores a config that an older version wrote, and a user whose
  // stored layout suddenly failed to parse would lose their rig to an upgrade.
  const old = { layout: DEFAULT_ENGINE_CONFIG.layout, blacklist: [], colorOrder: { order: 'grb' } }
  const config = parseEngineConfig(old)
  assert.equal(config.output.format, 'Afx')
  assert.deepEqual(config.capture, DEFAULT_CAPTURE)
  assert.equal(config.colorOrder.order, 'grb')
})

test('the transport defaults to serial and network transports demand an address', () => {
  assert.equal(parseEngineConfig(DEFAULT_ENGINE_CONFIG).output.transport, 'serial')

  const ws = parseEngineConfig({
    ...DEFAULT_ENGINE_CONFIG,
    output: { transport: 'websocket', host: ' strip.local ', format: 'Afx' }
  })
  assert.equal(ws.output.transport, 'websocket')
  assert.equal(ws.output.host, 'strip.local', 'the address should be trimmed')

  for (const transport of ['websocket', 'wled'] as const) {
    for (const host of [undefined, '', '   ', 42]) {
      assert.throws(
        () => parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, output: { transport, host } }),
        /output.host/,
        `${transport} accepted ${JSON.stringify(host)}`
      )
    }
  }
  assert.throws(
    () => parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, output: { transport: 'carrier-pigeon' } }),
    /output.transport/
  )
})

test('settings that would do nothing are refused rather than silently ignored', () => {
  // This is how someone ends up staring at an address they are sure they typed
  // correctly, on a transport that never reads it.
  assert.throws(
    () => parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, output: { transport: 'serial', host: 'strip.local' } }),
    /only used by the network transports/
  )
  assert.throws(
    () => parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, output: { transport: 'serial', segment: 1 } }),
    /only used by WLED/
  )
  assert.throws(
    () => parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, output: { transport: 'websocket', host: 'x', segment: 1 } }),
    /only used by WLED/
  )
  // WLED speaks its own JSON and never sees one of our wire formats.
  assert.throws(
    () => parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, output: { transport: 'wled', host: 'x', format: 'Awa' } }),
    /not used by WLED/
  )
})

test('a WLED output defaults to segment 0 and accepts another', () => {
  const zero = parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, output: { transport: 'wled', host: '192.168.1.40' } })
  assert.equal(zero.output.segment, 0)
  const two = parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, output: { transport: 'wled', host: 'x', segment: 2 } })
  assert.equal(two.output.segment, 2)
  assert.throws(
    () => parseEngineConfig({ ...DEFAULT_ENGINE_CONFIG, output: { transport: 'wled', host: 'x', segment: -1 } }),
    /output.segment/
  )
})

// ---------------------------------------------------------------------------
// Switching transport in the panel.
// ---------------------------------------------------------------------------

/**
 * The point of these: the validator refuses a setting that would do nothing, so
 * a picker that merely changed `transport` would hand the user a config they
 * cannot apply and did not ask for. Every result below is pushed back through
 * `parseEngineConfig`, which is the only assertion that actually matters.
 */
const withOutput = (output: unknown): unknown => ({ ...clone(DEFAULT_ENGINE_CONFIG), output })

test('switching to a network transport keeps the format and asks only for an address', () => {
  const next = switchTransport({ transport: 'serial', format: 'Awa' }, 'websocket')
  assert.equal(next.transport, 'websocket')
  assert.equal(next.format, 'Awa', 'our firmware over a socket carries the same bytes')
  assert.equal(next.host, '')
  // Empty is deliberately INVALID: the panel says "type an address" rather than
  // inventing one, and an invented address would silently dial the wrong device.
  assert.throws(() => parseEngineConfig(withOutput(next)), /output.host/)
  assert.equal(parseEngineConfig(withOutput({ ...next, host: '192.168.1.40' })).output.host, '192.168.1.40')
})

test('switching to WLED drops the wire format and the calibration the validator refuses', () => {
  const calibration = { white: 1, limit: 2, red: 3, green: 4, blue: 5 }
  const next = switchTransport({ transport: 'serial', format: 'Awa', calibration }, 'wled')
  assert.equal(next.format, 'Afx', 'WLED has its own protocol; Awa would be refused')
  assert.equal(next.calibration, undefined)
  assert.equal(next.segment, 0)
  assert.ok(parseEngineConfig(withOutput({ ...next, host: 'wled.local' })))
})

test('switching back to serial drops the address and the segment', () => {
  const next = switchTransport({ transport: 'wled', host: 'wled.local', segment: 3, format: 'Afx' }, 'serial')
  assert.equal(next.host, undefined)
  assert.equal(next.segment, undefined)
  assert.ok(parseEngineConfig(withOutput(next)))
})

test('the address survives a move between the two network transports', () => {
  // Someone comparing our firmware against a WLED on the same board should not
  // have to retype the address.
  const ws = switchTransport({ transport: 'serial', format: 'Afx' }, 'websocket')
  const wled = switchTransport({ ...ws, host: '10.0.0.7' }, 'wled')
  assert.equal(wled.host, '10.0.0.7')
  assert.equal(switchTransport(wled, 'websocket').host, '10.0.0.7')
})

test('every transport, from every other, produces something applicable', () => {
  const starts = [
    { transport: 'serial', format: 'Afx' },
    { transport: 'serial', format: 'Awa', calibration: { white: 0, limit: 0, red: 0, green: 0, blue: 0 } },
    { transport: 'websocket', host: 'strip.local', format: 'Ada' },
    { transport: 'wled', host: 'wled.local', segment: 2, format: 'Afx' }
  ] as const
  for (const from of starts) {
    for (const to of ['serial', 'websocket', 'wled'] as const) {
      const next = switchTransport(from, to)
      // An empty address is the one thing the panel still has to collect; fill
      // it here so the rest of the shape is what is being asserted.
      const filled = next.host === '' ? { ...next, host: 'x' } : next
      assert.ok(parseEngineConfig(withOutput(filled)), `${from.transport} -> ${to}`)
    }
  }
})

// ---------------------------------------------------------------------------
// Smoothing.
// ---------------------------------------------------------------------------

test('smoothing defaults to Balanced, which is what the strip ran before it was a knob', () => {
  const config = parseEngineConfig({ layout: { kind: 'classic', ...REFERENCE_LAYOUT } })
  assert.deepEqual(config.smoothing, { attackMs: 15, releaseMs: 90, cutThreshold: 0.25 })
  assert.equal(profileOf(config.smoothing), 'balanced')
})

test('the profile name is derived, so it can never disagree with the numbers', () => {
  // A stored name could say "balanced" over cinema's numbers, which is a state
  // that can exist and means nothing.
  assert.equal(profileOf(SMOOTHING_PROFILES.cinema), 'cinema')
  assert.equal(profileOf(SMOOTHING_PROFILES.competitive), 'competitive')
  assert.equal(profileOf({ attackMs: 15, releaseMs: 91, cutThreshold: 0.25 }), null, 'one edited number is custom')
})

test('the cut bypass is turned off exactly, not by a sentinel', () => {
  // It fires when the mean |target - output| is ABOVE the threshold, and each
  // channel differs by at most 1 - so a mean above 1 is unreachable.
  assert.equal(SMOOTHING_PROFILES.competitive.cutThreshold, 1)
  const off = parseEngineConfig({ layout: { kind: 'classic', ...REFERENCE_LAYOUT }, smoothing: { cutThreshold: 1 } })
  assert.equal(off.smoothing.cutThreshold, 1)
  assert.throws(
    () => parseEngineConfig({ layout: { kind: 'classic', ...REFERENCE_LAYOUT }, smoothing: { cutThreshold: 1.5 } }),
    /smoothing\.cutThreshold/
  )
})

test('a time constant out of range is refused by name', () => {
  const base = { layout: { kind: 'classic', ...REFERENCE_LAYOUT } }
  assert.throws(() => parseEngineConfig({ ...base, smoothing: { attackMs: -1 } }), /smoothing\.attackMs/)
  assert.throws(() => parseEngineConfig({ ...base, smoothing: { releaseMs: 5000 } }), /smoothing\.releaseMs/)
  assert.throws(() => parseEngineConfig({ ...base, smoothing: { attackMs: 'hızlı' } }), /smoothing\.attackMs/)
  assert.throws(() => parseEngineConfig({ ...base, smoothing: 'sinema' }), /config\.smoothing/)
})

test('a config written before smoothing was a setting still loads', () => {
  // Everyone who has used this has one of these stored, and it must not be
  // the reason their strip stops working after an update.
  const older = JSON.parse(serialiseEngineConfig(DEFAULT_ENGINE_CONFIG)) as Record<string, unknown>
  delete older.smoothing
  assert.deepEqual(parseEngineConfig(older).smoothing, DEFAULT_SMOOTHING)
})
