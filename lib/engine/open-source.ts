import { deviceConstraints, listVideoDevices, resolveDevice } from '#lib/engine/devices'
import type { EngineConfig } from '#lib/engine/config'
import { TEXT } from '#lib/engine/text'

/**
 * Opens the stream the configuration asks for: the screen, or a video input.
 *
 * Shared by both hosts because the branch is identical in a page and in an
 * offscreen document - only the wording of a refused screen picker differs, and
 * that is passed in.
 *
 * A missing device is a SENTENCE, not a fallback. Silently opening whatever
 * camera happens to be first is how someone's ambilight ends up following their
 * own face.
 */
export async function openConfiguredStream (
  config: EngineConfig,
  media: {
    getDisplayMedia: (constraints: unknown) => Promise<unknown>
    getUserMedia: (constraints: unknown) => Promise<unknown>
  }
): Promise<MediaStream> {
  if (config.capture.source === 'device') {
    const { devices } = await listVideoDevices()
    const device = resolveDevice(devices, config.capture.deviceId)
    if (device === null) {
      throw new Error(devices.length === 0
        ? TEXT.noVideoInput
        : TEXT.videoInputGone)
    }
    try {
      return await media.getUserMedia(deviceConstraints(device.deviceId, config.capture.fps)) as MediaStream
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      throw new Error(name === 'NotAllowedError' ? TEXT.cameraDenied : describe(error))
    }
  }
  try {
    return await media.getDisplayMedia({
      audio: false,
      // A ceiling, not a demand: the pipeline is latest-wins, so a source faster
      // than the engine costs drops rather than correctness.
      video: { frameRate: { max: config.capture.fps } }
    }) as MediaStream
  } catch (error) {
    // Cancelling the picker is a decision, not a failure.
    const name = error instanceof Error ? error.name : ''
    throw new Error(name === 'NotAllowedError' ? TEXT.screenNotPicked : describe(error))
  }
}

function describe (error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.name === '' || error.name === 'Error' ? error.message : `${error.name}: ${error.message}`
}
