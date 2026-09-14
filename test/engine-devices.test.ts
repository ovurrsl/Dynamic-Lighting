import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ENGINE_CONFIG, parseEngineConfig } from '#lib/engine/config'
import {
  deviceConstraints,
  listVideoDevices,
  listWithPermission,
  resolveDevice,
  type VideoDevice
} from '#lib/engine/devices'

const info = (kind: string, deviceId: string, label: string) => ({ kind, deviceId, label })

test('only video inputs are listed, and placeholders are dropped', () => {
  return listVideoDevices({
    enumerate: async () => [
      info('audioinput', 'mic1', 'Built-in Microphone'),
      info('videoinput', 'cam1', 'HD Pro Webcam'),
      info('videoinput', 'card1', 'USB Video (Elgato)'),
      // Some browsers hand back one of these before permission; it is not a
      // device anyone can open.
      info('videoinput', '', ''),
      info('audiooutput', 'spk1', 'Speakers')
    ]
  }).then((list) => {
    assert.deepEqual(list.devices.map((d) => d.deviceId), ['cam1', 'card1'])
    assert.equal(list.needsPermission, false)
  })
})

test('devices with no labels are reported as needing permission, not as no devices', async () => {
  // The distinction the panel needs: "there are no cameras" and "there are
  // cameras but I may not tell you their names" want different sentences and
  // different buttons. A picker showing four blank rows is worse than none.
  const list = await listVideoDevices({
    enumerate: async () => [info('videoinput', 'a', ''), info('videoinput', 'b', '')]
  })
  assert.equal(list.devices.length, 2)
  assert.equal(list.needsPermission, true)
})

test('an empty list is an answer, not an error', async () => {
  const list = await listVideoDevices({ enumerate: async () => [] })
  assert.deepEqual(list.devices, [])
  assert.equal(list.needsPermission, false)
})

test('asking for permission opens a stream and immediately releases it', async () => {
  // The point is the permission, not the picture: a stream left open lights the
  // camera indicator for a device the user has not chosen yet.
  const stopped: string[] = []
  let labels = ['', '']
  const list = await listWithPermission({
    getUserMedia: async () => {
      labels = ['HD Pro Webcam', 'USB Video (Elgato)']
      return { getTracks: () => [{ stop: () => stopped.push('video') }] }
    },
    enumerate: async () => [
      info('videoinput', 'a', labels[0] as string),
      info('videoinput', 'b', labels[1] as string)
    ]
  })
  assert.deepEqual(stopped, ['video'])
  assert.equal(list.needsPermission, false)
  assert.equal(list.devices[1]?.label, 'USB Video (Elgato)')
})

test('a refused camera permission gets its own sentence', async () => {
  const denied = Object.assign(new Error('no'), { name: 'NotAllowedError' })
  await assert.rejects(
    () => listWithPermission({ getUserMedia: async () => { throw denied }, enumerate: async () => [] }),
    /Kamera izni verilmedi/
  )
})

test('no camera at all still lists, so the panel can say "none" rather than "failed"', async () => {
  const missing = Object.assign(new Error('none'), { name: 'NotFoundError' })
  const list = await listWithPermission({
    getUserMedia: async () => { throw missing },
    enumerate: async () => []
  })
  assert.deepEqual(list.devices, [])
})

test('a stored device that is gone resolves to null, never to "whatever is first"', () => {
  // Silently opening a different camera is how someone's ambilight ends up
  // following their own face.
  const devices: VideoDevice[] = [
    { deviceId: 'cam1', label: 'Webcam' },
    { deviceId: 'card1', label: 'Elgato' }
  ]
  assert.equal(resolveDevice(devices, 'card1')?.deviceId, 'card1')
  assert.equal(resolveDevice(devices, 'gone'), null)
  // With nothing stored, the first is a reasonable default.
  assert.equal(resolveDevice(devices)?.deviceId, 'cam1')
  assert.equal(resolveDevice([], 'card1'), null)
  assert.equal(resolveDevice([]), null)
})

test('constraints ask exactly for the device and ideally for the rest', () => {
  const constraints = deviceConstraints('card1', 60) as {
    video: { deviceId: { exact: string }, width: { ideal: number }, frameRate: { max: number } }
  }
  // Exact on the device - "open this one" has no sensible approximation - and
  // ideal elsewhere, so a card that cannot do 1080p60 gives its best rather
  // than an OverconstrainedError.
  assert.equal(constraints.video.deviceId.exact, 'card1')
  assert.equal(constraints.video.width.ideal, 1920)
  assert.equal(constraints.video.frameRate.max, 60)
})

// ---------------------------------------------------------------------------
// The configuration side.
// ---------------------------------------------------------------------------

const withCapture = (capture: unknown): unknown => ({
  ...JSON.parse(JSON.stringify(DEFAULT_ENGINE_CONFIG)),
  capture: { ...JSON.parse(JSON.stringify(DEFAULT_ENGINE_CONFIG.capture)), ...(capture as object) }
})

test('the capture source defaults to the screen and accepts a device', () => {
  assert.equal(parseEngineConfig(DEFAULT_ENGINE_CONFIG).capture.source, 'screen')
  const config = parseEngineConfig(withCapture({ source: 'device', deviceId: 'card1' }))
  assert.equal(config.capture.source, 'device')
  assert.equal(config.capture.deviceId, 'card1')
})

test('a device id on a screen capture is refused, not ignored', () => {
  // The two halves of the configuration would disagree about what is being
  // read, and silently keeping one is how that survives into a bug report.
  assert.throws(
    () => parseEngineConfig(withCapture({ source: 'screen', deviceId: 'card1' })),
    /only used when the source is a video input/
  )
  assert.throws(() => parseEngineConfig(withCapture({ source: 'hdmi' })), /capture.source/)
  assert.throws(() => parseEngineConfig(withCapture({ source: 'device', deviceId: '' })), /capture.deviceId/)
})

test('a device source with no id is legal: the first input is a fair default', () => {
  const config = parseEngineConfig(withCapture({ source: 'device' }))
  assert.equal(config.capture.source, 'device')
  assert.equal(config.capture.deviceId, undefined)
})
