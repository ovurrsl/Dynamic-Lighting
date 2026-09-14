import {
  HEADER_SIZE,
  encodeAda,
  encodeAfx,
  encodeAwa,
  frameSize,
  type Calibration
} from '#lib/engine/protocol'
import type { LedColors } from '#lib/engine/types'
import { encodeLinear16, encodeLinear8 } from '#lib/light'

/**
 * LED colours to bytes on the wire, in whichever format is configured.
 *
 * This used to live inside the extension's engine document, which meant the one
 * piece of the pipeline that decides what a device actually receives could not
 * be tested without a browser. It is here now because more than one transport
 * needs it: a serial port, a WebSocket to our own firmware, and the loopback
 * all send the same bytes over different wires.
 *
 * The three formats and why there are three:
 *
 * - `Afx` is ours. Six bytes per LED, 16-bit linear, a Fletcher trailer and a
 *   control channel. The only one that carries the precision the engine works
 *   in, and it needs our firmware.
 * - `Awa` is Adalight with an integrity check - HyperHDR's format, which
 *   HyperSerialESP32 and HyperSerialWLED speak.
 * - `Ada` is plain Adalight with no check of any kind. A flipped bit is shown
 *   as colour. It exists because some older sketches accept nothing else.
 *
 * **`Awa` and `Ada` carry LINEAR 8-bit, not sRGB 8-bit**, and that is a
 * decision rather than an oversight. An Adalight sketch writes the byte
 * straight to its LED library; a WS2812's brightness follows PWM duty, which
 * follows the byte. Gamma-encoding here would be applied a second time by the
 * physics and come out roughly squared - the same defect docs/hyperion-port-plan
 * .md catalogues in Hyperion's own pipeline.
 *
 * One buffer for the life of the encoder, so the 120 Hz path allocates nothing.
 * The returned array is a view INTO that buffer: valid until the next `encode`,
 * which is exactly as long as a latest-wins writer needs it.
 */

export interface FrameEncoder {
  readonly format: WireFormatName
  readonly leds: number
  /** Bytes one frame occupies, header and trailer included. */
  readonly frameBytes: number
  encode: (colors: LedColors) => Uint8Array
}

/** Kept local so this module does not depend on the configuration schema. */
export type WireFormatName = 'Afx' | 'Awa' | 'Ada'

export function createFrameEncoder (
  format: WireFormatName,
  leds: number,
  calibration?: Calibration
): FrameEncoder {
  if (!Number.isInteger(leds) || leds < 1) {
    throw new RangeError(`encode: leds must be a positive integer, got ${String(leds)}`)
  }
  if (format !== 'Afx' && format !== 'Awa' && format !== 'Ada') {
    throw new RangeError(`encode: unknown format ${String(format)}`)
  }
  if (calibration !== undefined && format !== 'Awa') {
    // Silently ignoring it would leave someone staring at a white balance that
    // does nothing - the same reason the configuration parser refuses it.
    throw new RangeError(`encode: calibration is only carried by Awa, not ${format}`)
  }

  const calibrated = calibration !== undefined
  const frameBytes = frameSize(format, leds, calibrated)
  const wire = new Uint8Array(frameBytes)
  const payloadBytes = leds * (format === 'Afx' ? 6 : 3)
  const payload = wire.subarray(HEADER_SIZE, HEADER_SIZE + payloadBytes)

  return {
    format,
    leds,
    frameBytes,
    encode (colors: LedColors): Uint8Array {
      if (colors.length < leds * 3) {
        throw new RangeError(`encode: colors holds ${colors.length} floats, needs ${leds * 3}`)
      }
      // Narrowed to exactly this many LEDs. The encoders size their output from
      // the input's length, so a caller handing over a larger scratch buffer -
      // which the pattern source does - would otherwise write past the payload
      // and corrupt the trailer that is about to be computed over it.
      const view = colors.length === leds * 3 ? colors : colors.subarray(0, leds * 3)
      switch (format) {
        case 'Afx':
          encodeLinear16(view, payload)
          return encodeAfx(payload, wire)
        case 'Awa':
          encodeLinear8(view, payload)
          return encodeAwa(payload, calibration, wire)
        case 'Ada':
          encodeLinear8(view, payload)
          return encodeAda(payload, wire)
      }
    }
  }
}
