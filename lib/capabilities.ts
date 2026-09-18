/**
 * What THIS browser can actually do, asked of the browser rather than of a
 * compatibility table.
 *
 * This exists because the tables have now been wrong three times on this
 * project, each time in a way that changed the architecture:
 *
 * 1. Chrome's own documentation and MDN disagreed about `MediaStreamTrackProcessor`
 *    in workers. Asking Chromium settled it in a minute.
 * 2. I wrote that capture cards and HID/FTDI devices were impossible in a
 *    browser. Measured: `navigator.hid`, `navigator.usb` and `navigator.serial`
 *    are all objects in an extension page. That correction reopened a whole
 *    class of LED devices.
 * 3. I wrote that mobile browsers cannot capture the screen, citing
 *    `getDisplayMedia` being absent on iOS. A screenshot from a real iPhone
 *    shows it working, at 1180x2556, feeding our sampler - while caniuse's
 *    August 2026 data still says "iOS Safari 26.6: not supported".
 *
 * The pattern is the point. A support table describes browsers in general; a
 * user has one browser, on one device, on one OS version, possibly with a
 * feature flag on. Only their browser can answer for them, and the answer is
 * what decides whether this product works for them at all.
 *
 * So the panel asks, and shows the answer. It doubles as the first thing to
 * look at in a support conversation: "send me a photo of this page" beats
 * twenty questions about versions.
 *
 * Nothing here calls anything. Presence is read, never exercised: invoking
 * `getDisplayMedia` opens a picker, and a diagnostics page that prompts for
 * permissions the moment it loads is a diagnostics page people close.
 */

/**
 * The globals a probe reads. Injected rather than reached for, so the whole
 * table can be tested in Node - where none of these exist - against every
 * combination that matters, instead of only against whatever browser happens
 * to run the test.
 */
export interface Environment {
  navigator?: {
    mediaDevices?: { getDisplayMedia?: unknown, getUserMedia?: unknown, enumerateDevices?: unknown }
    serial?: unknown
    hid?: unknown
    usb?: unknown
    bluetooth?: unknown
  }
  OffscreenCanvas?: unknown
  MediaStreamTrackProcessor?: unknown
  VideoFrame?: unknown
  WebSocket?: unknown
  HTMLVideoElement?: { prototype?: { requestVideoFrameCallback?: unknown } }
  chrome?: { runtime?: { sendMessage?: unknown } }
}

/** What a capability means for the product, not for the spec. */
export type CapabilityId =
  | 'screenCapture'
  | 'cameraCapture'
  | 'serial'
  | 'hid'
  | 'usb'
  | 'network'
  | 'fastCapture'
  | 'frameCallback'
  | 'offscreenCanvas'
  | 'extensionBridge'

export interface Capability {
  id: CapabilityId
  present: boolean
  /**
   * Whether the product needs this to do its main job on this device.
   *
   * 'core' means without it there is no ambilight here; 'output' means it is
   * one of several ways to reach the strip and another may serve; 'detail' is
   * a performance or quality difference.
   */
  weight: 'core' | 'output' | 'detail'
}

const has = (value: unknown): boolean => value !== undefined && value !== null

/**
 * Reads the environment. Deliberately total: a missing `navigator` or a
 * property access that throws (some embedded webviews throw on `navigator.usb`)
 * reads as absent rather than breaking the page that was trying to diagnose
 * itself.
 */
function probe (env: Environment, read: (env: Environment) => unknown): boolean {
  try {
    return has(read(env))
  } catch {
    return false
  }
}

export function detectCapabilities (env: Environment): Capability[] {
  return [
    {
      id: 'screenCapture',
      weight: 'core',
      present: probe(env, (e) => e.navigator?.mediaDevices?.getDisplayMedia)
    },
    {
      id: 'cameraCapture',
      weight: 'core',
      present: probe(env, (e) => e.navigator?.mediaDevices?.getUserMedia)
    },
    { id: 'serial', weight: 'output', present: probe(env, (e) => e.navigator?.serial) },
    { id: 'hid', weight: 'output', present: probe(env, (e) => e.navigator?.hid) },
    { id: 'usb', weight: 'output', present: probe(env, (e) => e.navigator?.usb) },
    { id: 'network', weight: 'output', present: probe(env, (e) => e.WebSocket) },
    {
      id: 'fastCapture',
      weight: 'detail',
      present: probe(env, (e) => e.MediaStreamTrackProcessor)
    },
    {
      id: 'frameCallback',
      weight: 'detail',
      present: probe(env, (e) => e.HTMLVideoElement?.prototype?.requestVideoFrameCallback)
    },
    { id: 'offscreenCanvas', weight: 'detail', present: probe(env, (e) => e.OffscreenCanvas) },
    {
      id: 'extensionBridge',
      weight: 'detail',
      present: probe(env, (e) => e.chrome?.runtime?.sendMessage)
    }
  ]
}

/**
 * Whether this browser can be an ambilight at all, and by which route.
 *
 * 'capture' means it can read the screen here, in the page. 'card' means it
 * cannot, but a USB capture card would appear as a camera and serve instead -
 * which is not a workaround but the better answer anyway, since a capture card
 * is also the only thing that defeats DRM blanking. 'remote' means neither, and
 * the honest thing to offer is a remote control for an instance running
 * somewhere else.
 */
export function captureRoute (capabilities: readonly Capability[]): 'capture' | 'card' | 'remote' {
  const find = (id: CapabilityId): boolean =>
    capabilities.find((entry) => entry.id === id)?.present === true
  if (find('screenCapture')) return 'capture'
  if (find('cameraCapture')) return 'card'
  return 'remote'
}

/**
 * How the strip can be reached from here, best first.
 *
 * Serial is first because it is the one with no network, no configuration and
 * no second device. The network is last and is never empty: a WebSocket exists
 * in every browser this can run in, which is exactly why the network driver is
 * what makes the platform matrix real rather than aspirational.
 */
export function outputRoutes (capabilities: readonly Capability[]): CapabilityId[] {
  const order: CapabilityId[] = ['serial', 'hid', 'usb', 'network']
  return order.filter((id) => capabilities.find((entry) => entry.id === id)?.present === true)
}

/**
 * Whether THIS browser has any local-device route at all: serial, HID or USB.
 *
 * Specifically the routes an EXTENSION reaches. `network` is deliberately
 * excluded: a WebSocket exists in every browser, extension or not, so asking
 * `outputRoutes` as a whole would say "yes" everywhere - which is how the
 * guide's "your browser cannot pair a port" box would never have shown at all.
 * Safari and Firefox declined Web Serial on every platform, and iOS has no
 * extension host to load one into; for them lib/page-host.ts is the answer,
 * and the guide has to be able to say so.
 */
export function hasLocalDeviceRoute (capabilities: readonly Capability[]): boolean {
  return outputRoutes(capabilities).some((id) => id === 'serial' || id === 'hid' || id === 'usb')
}

/** Reads the real globals. Browser only; `detectCapabilities` is the testable half. */
export function currentEnvironment (): Environment {
  return globalThis as unknown as Environment
}
