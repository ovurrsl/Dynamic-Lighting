import {
  HEADER_SIZE,
  encodeAda,
  encodeAfx,
  encodeAwa,
  frameSize,
  type Calibration
} from '#lib/engine/protocol'
import { LEVELS_8BIT, createDither, type Dither } from '#lib/engine/dither'
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
 * **Dithering belongs here, and only on the 8-bit formats.** 255 levels of
 * LINEAR light is not 255 levels of sRGB: the codes are spaced evenly in
 * photons, so the dark end - where a bias light spends its life - gets a
 * handful of usable steps and bands visibly. `lib/engine/dither.ts` diffuses
 * that rounding error across time instead, and it is wired in here because
 * this is the one place that quantises. It is off unless asked for; see
 * `EncoderOptions.dither` for why that is the default rather than an oversight.
 *
 * It is REFUSED on `Afx`, which is not a preference either: our firmware
 * sigma-deltas the 16-bit value on the strip's own refresh, and two error
 * diffusers with independent residuals fighting over the same LSB read as
 * noise rather than as extra resolution.
 *
 * `encode` must therefore run once per frame actually SENT. It does: the
 * latest-wins writer drops before it calls the sink, and the sink is what calls
 * the encoder (lib/engine/sink.ts). A frame encoded onto a transport that then
 * fails does spend its residual without being shown - bounded to one frame, and
 * the same property Hyperion's writer has.
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

export interface EncoderOptions {
  /** 'Awa' only: the four white-balance bytes a calibrated 'AwA' frame carries. */
  calibration?: Calibration
  /**
   * Diffuse the 8-bit rounding error across time. 'Awa' and 'Ada' only.
   *
   * Off by default, and the reason is a rate rather than caution about the
   * maths: temporal dithering reads as extra resolution only while frames keep
   * arriving. At the engine's 120 Hz a channel alternating 10/11 integrates to
   * 10.4 and the eye sees 10.4; at ten frames a second the same alternation is
   * a shimmer. The serial link's rate is bounded by numbers we know - 921600
   * baud, 3 bytes per LED - but the websocket transport's is **not measured**
   * (docs/firmware-and-devices.md, N3), and defaulting this on would be
   * claiming a frame rate rather than having measured one.
   *
   * The 21-step grey ramp pattern is the way to see whether it helps on a given
   * rig: the bottom three steps are where linear 8-bit bands.
   */
  dither?: boolean
}

export function createFrameEncoder (
  format: WireFormatName,
  leds: number,
  options: EncoderOptions = {}
): FrameEncoder {
  if (!Number.isInteger(leds) || leds < 1) {
    throw new RangeError(`encode: leds must be a positive integer, got ${String(leds)}`)
  }
  if (format !== 'Afx' && format !== 'Awa' && format !== 'Ada') {
    throw new RangeError(`encode: unknown format ${String(format)}`)
  }
  const { calibration, dither = false } = options
  if (calibration !== undefined && format !== 'Awa') {
    // Silently ignoring it would leave someone staring at a white balance that
    // does nothing - the same reason the configuration parser refuses it.
    throw new RangeError(`encode: calibration is only carried by Awa, not ${format}`)
  }
  if (dither && format === 'Afx') {
    // Not a preference: the firmware already dithers the 16-bit value, and two
    // error diffusers over the same LSB are noise. Refused rather than ignored,
    // for the same reason as the calibration above.
    throw new RangeError('encode: Afx is dithered by the firmware, not by the host')
  }

  const calibrated = calibration !== undefined
  const frameBytes = frameSize(format, leds, calibrated)
  const wire = new Uint8Array(frameBytes)
  const payloadBytes = leds * (format === 'Afx' ? 6 : 3)
  const payload = wire.subarray(HEADER_SIZE, HEADER_SIZE + payloadBytes)
  // Sized to the LED count, so a frame of another size never silently resets
  // the residuals mid-session; the encoder is rebuilt when the layout changes.
  const ditherer: Dither | null = dither ? createDither(leds, LEVELS_8BIT) : null

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
          quantise(view)
          return encodeAwa(payload, calibration, wire)
        case 'Ada':
          quantise(view)
          return encodeAda(payload, wire)
      }
    }
  }

  /** Linear floats to 8-bit codes, with or without the temporal diffusion. */
  function quantise (view: LedColors): void {
    if (ditherer === null) encodeLinear8(view, payload)
    else ditherer.apply(view, payload)
  }
}
