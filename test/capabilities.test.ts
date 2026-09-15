import assert from 'node:assert/strict'
import test from 'node:test'

import {
  captureRoute,
  detectCapabilities,
  outputRoutes,
  type Capability,
  type CapabilityId,
  type Environment
} from '#lib/capabilities'

const find = (caps: Capability[], id: CapabilityId): boolean =>
  caps.find((entry) => entry.id === id)?.present === true

/** Windows + Chrome with the extension loaded: everything the product wants. */
const CHROME_DESKTOP: Environment = {
  navigator: {
    mediaDevices: { getDisplayMedia: () => {}, getUserMedia: () => {}, enumerateDevices: () => {} },
    serial: {}, hid: {}, usb: {}
  },
  OffscreenCanvas: class {},
  MediaStreamTrackProcessor: class {},
  VideoFrame: class {},
  WebSocket: class {},
  HTMLVideoElement: { prototype: { requestVideoFrameCallback: () => {} } },
  chrome: { runtime: { sendMessage: () => {} } }
}

/**
 * iOS Safari as a real iPhone actually behaved, which is the case that started
 * this file: the screen capture works - contradicting the tables - and none of
 * the device APIs exist, so the only way to a strip is the network.
 */
const IOS_SAFARI: Environment = {
  navigator: {
    mediaDevices: { getDisplayMedia: () => {}, getUserMedia: () => {}, enumerateDevices: () => {} }
  },
  OffscreenCanvas: class {},
  WebSocket: class {},
  HTMLVideoElement: { prototype: { requestVideoFrameCallback: () => {} } }
}

test('a Chromium desktop reports every route', () => {
  const caps = detectCapabilities(CHROME_DESKTOP)
  for (const id of ['screenCapture', 'cameraCapture', 'serial', 'hid', 'usb', 'network', 'fastCapture', 'extensionBridge'] as const) {
    assert.ok(find(caps, id), id)
  }
  assert.equal(captureRoute(caps), 'capture')
  assert.deepEqual(outputRoutes(caps), ['serial', 'hid', 'usb', 'network'])
})

test('iOS Safari can capture the screen and can only reach a strip over the network', () => {
  const caps = detectCapabilities(IOS_SAFARI)
  assert.ok(find(caps, 'screenCapture'))
  assert.equal(captureRoute(caps), 'capture')
  // No Web Serial, no WebHID, no WebUSB, no extension messaging - all four are
  // Chromium-only and Apple requires WebKit. The network is the whole story.
  for (const id of ['serial', 'hid', 'usb', 'extensionBridge'] as const) {
    assert.ok(!find(caps, id), id)
  }
  assert.deepEqual(outputRoutes(caps), ['network'])
  // And the slow-but-universal capture path is the one available.
  assert.ok(!find(caps, 'fastCapture'))
  assert.ok(find(caps, 'frameCallback'))
})

test('a browser with no screen capture falls back to a capture card, then to remote', () => {
  const card: Environment = { navigator: { mediaDevices: { getUserMedia: () => {} } } }
  assert.equal(captureRoute(detectCapabilities(card)), 'card')
  assert.equal(captureRoute(detectCapabilities({ navigator: { mediaDevices: {} } })), 'remote')
  assert.equal(captureRoute(detectCapabilities({})), 'remote')
})

test('an empty environment reports everything absent rather than throwing', () => {
  // The server renders with no navigator at all, and a diagnostics page that
  // crashes while diagnosing is worse than useless.
  const caps = detectCapabilities({})
  assert.equal(caps.length, 10)
  assert.ok(caps.every((entry) => !entry.present))
  assert.deepEqual(outputRoutes(caps), [])
})

test('a getter that throws reads as absent, not as a crash', () => {
  // Some embedded webviews throw on `navigator.usb` rather than returning
  // undefined, and this card is exactly where that would surface.
  const hostile = {
    navigator: {
      get usb (): never { throw new Error('blocked by policy') },
      get serial (): never { throw new Error('blocked by policy') },
      mediaDevices: { getDisplayMedia: () => {} }
    }
  } as unknown as Environment
  const caps = detectCapabilities(hostile)
  assert.ok(!find(caps, 'usb'))
  assert.ok(!find(caps, 'serial'))
  assert.ok(find(caps, 'screenCapture'))
})

test('every capability has a weight, and the two that decide the product are core', () => {
  const caps = detectCapabilities(CHROME_DESKTOP)
  assert.ok(caps.every((entry) => ['core', 'output', 'detail'].includes(entry.weight)))
  // Without one of these there is no ambilight on this device at all; the rest
  // change how good it is or how it reaches the strip.
  const core = caps.filter((entry) => entry.weight === 'core').map((entry) => entry.id)
  assert.deepEqual(core, ['screenCapture', 'cameraCapture'])
})

test('the capability list is stable in order and has no duplicates', () => {
  // The card renders this list directly, so a duplicate would render twice and
  // a reordering would move things under someone's eyes between releases.
  const ids = detectCapabilities({}).map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids[0], 'screenCapture')
})
