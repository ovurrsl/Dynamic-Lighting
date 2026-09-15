/**
 * Video input devices: capture cards, and the webcams that look just like them.
 *
 * This is the roadmap's sixth item and it earns its place twice over.
 *
 * On a platform with no screen capture it is the ONLY real source. And on every
 * platform it is **the only thing that defeats DRM blanking**: Netflix, Prime
 * and Disney+ reach the desktop already painted black, because protected media
 * never touches a readable buffer - there is no software fix for that inside
 * the operating system. An HDMI splitter that strips HDCP feeds a USB capture
 * card, and the card presents the picture as a camera. The signal is taken
 * BELOW the decryption, so there is nothing left to blank.
 *
 * A capture card is a camera as far as a browser is concerned, so everything
 * downstream is unchanged: `getUserMedia` gives a `MediaStream` and the same
 * two frame sources read it. The work here is entirely about CHOOSING one,
 * which is where the sharp edges are:
 *
 * - **Labels are empty until permission is granted.** `enumerateDevices` will
 *   happily return four devices called "" before the user has said yes, and a
 *   picker showing four blank rows is worse than no picker. So the list is
 *   fetched, and if the labels are blank the caller is told to ask first.
 * - **A capture card cannot be told apart from a webcam.** Both are video
 *   inputs; the label is a manufacturer's string and nothing else. Filtering on
 *   a guess would hide someone's card because it calls itself something
 *   unexpected, so nothing is filtered - the list is shown as the browser gives
 *   it, with a note about what to look for.
 * - **`deviceId` is not stable across browsers or profiles**, and on some it
 *   rotates when site data is cleared. A stored id is therefore checked against
 *   the current list rather than trusted, and a missing one is a sentence
 *   rather than a capture that silently opens the wrong device.
 */

export interface VideoDevice {
  deviceId: string
  /** As the browser gives it. Empty until a permission has been granted once. */
  label: string
  groupId?: string
}

export interface DeviceList {
  devices: VideoDevice[]
  /**
   * True when the browser returned devices but no labels.
   *
   * The distinction the panel needs: "there are no cameras" and "there are
   * cameras but I may not tell you their names" need different sentences and
   * different buttons.
   */
  needsPermission: boolean
}

export interface DeviceOptions {
  /** Injected; defaults to `navigator.mediaDevices`. */
  enumerate?: () => Promise<Array<{ kind: string, deviceId: string, label: string, groupId?: string }>>
  getUserMedia?: (constraints: unknown) => Promise<unknown>
}

function defaultEnumerate (): Promise<Array<{ kind: string, deviceId: string, label: string, groupId?: string }>> {
  const media = (globalThis as { navigator?: { mediaDevices?: { enumerateDevices?: () => Promise<MediaDeviceInfo[]> } } })
    .navigator?.mediaDevices
  if (media?.enumerateDevices === undefined) {
    throw new Error('devices: this browser cannot list media devices')
  }
  return media.enumerateDevices() as unknown as Promise<Array<{ kind: string, deviceId: string, label: string, groupId?: string }>>
}

/** Lists video inputs. Never throws for an empty list - that is an answer. */
export async function listVideoDevices (options: DeviceOptions = {}): Promise<DeviceList> {
  const enumerate = options.enumerate ?? defaultEnumerate
  const all = await enumerate()
  const devices = all
    .filter((device) => device.kind === 'videoinput')
    .map((device) => ({
      deviceId: device.deviceId,
      label: device.label,
      ...(device.groupId !== undefined ? { groupId: device.groupId } : {})
    }))
  // Some browsers return a single placeholder entry with an empty id before
  // permission; it is not a device anyone can open.
  const usable = devices.filter((device) => device.deviceId !== '')
  return {
    devices: usable,
    needsPermission: usable.length > 0 && usable.every((device) => device.label === '')
  }
}

/**
 * Asks for camera permission, then lists again.
 *
 * The stream is opened and immediately stopped: the point is the permission,
 * not the picture, and leaving it open would light the camera indicator for a
 * device the user has not chosen yet.
 */
export async function listWithPermission (options: DeviceOptions = {}): Promise<DeviceList> {
  const ask = options.getUserMedia ?? ((constraints: unknown) =>
    navigator.mediaDevices.getUserMedia(constraints as MediaStreamConstraints))
  try {
    const stream = await ask({ video: true, audio: false })
    const tracks = (stream as { getTracks?: () => Array<{ stop: () => void }> }).getTracks?.() ?? []
    for (const track of tracks) {
      try { track.stop() } catch { /* already stopped */ }
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'NotAllowedError') throw new Error('Kamera izni verilmedi.')
    // NotFoundError means there is genuinely nothing to grant - list anyway, so
    // the panel can say "no devices" rather than "permission failed".
    if (name !== 'NotFoundError') throw new Error(describe(error))
  }
  return await listVideoDevices(options)
}

/**
 * Picks the device to open.
 *
 * A stored id that is no longer present returns null rather than falling back
 * to whatever is first: silently opening a different camera than the one
 * configured is the kind of thing that has someone's ambilight following their
 * own face.
 */
export function resolveDevice (list: readonly VideoDevice[], deviceId?: string): VideoDevice | null {
  if (deviceId === undefined || deviceId === '') return list[0] ?? null
  return list.find((device) => device.deviceId === deviceId) ?? null
}

/**
 * Constraints for a capture card.
 *
 * `ideal` rather than `exact` throughout: a card that cannot do 1080p60 should
 * give its best rather than an `OverconstrainedError`, and the pipeline is
 * latest-wins so a source faster than the engine costs drops rather than
 * correctness. `deviceId` is the one thing that IS exact - "open this device"
 * has no sensible approximation.
 */
export function deviceConstraints (deviceId: string, fps: number): unknown {
  return {
    audio: false,
    video: {
      deviceId: { exact: deviceId },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { max: fps }
    }
  }
}

function describe (error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.name === '' || error.name === 'Error' ? error.message : `${error.name}: ${error.message}`
}
