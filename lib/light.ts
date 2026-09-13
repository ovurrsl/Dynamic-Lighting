/**
 * Pure light maths. No imports on purpose: this module is shared by the
 * control panel, the capture engine and the test runner, and none of them
 * should drag a UI kit along to convert a colour.
 *
 * Everything downstream of the screen works in LINEAR light. The reason is
 * physical, not aesthetic: WS2812B brightness is proportional to PWM duty, which
 * is proportional to the byte value, so the wire wants linear. Averaging in sRGB
 * (which Hyperion does by default) makes bright regions read too dark and is the
 * source of its luminance pumping. Decode first, average second, never encode.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** sRGB electro-optical transfer function: encoded 0..1 -> linear 0..1. */
export function srgbToLinear (channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4
}

/** Linear 0..1 -> sRGB encoded 0..1. Only needed to display a linear value. */
export function linearToSrgb (channel: number): number {
  return channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * channel ** (1 / 2.4) - 0.055
}

/**
 * 256-entry decode table for 8-bit sRGB input. The capture path calls this on
 * every pixel of every frame, so the transcendental goes into a table once.
 */
export function buildSrgbToLinearLut (): Float32Array {
  const lut = new Float32Array(256)
  for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i / 255)
  return lut
}

export function clamp01 (v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * Linear floats -> 16-bit big-endian per channel, the `Afx` payload.
 *
 * 16 bits rather than 8 because the low end of a linear ramp needs more than
 * 256 steps before the firmware dithers it back down; 8-bit linear would band in
 * exactly the dark scenes a bias light spends most of its time in.
 *
 * `colors` is a flat Float32Array of count*3 linear values in 0..1.
 */
export function encodeLinear16 (colors: Float32Array, out?: Uint8Array): Uint8Array {
  const bytes = out ?? new Uint8Array(colors.length * 2)
  for (let i = 0; i < colors.length; i++) {
    const v = Math.round(clamp01(colors[i] ?? 0) * 65535)
    bytes[i * 2] = v >> 8
    bytes[i * 2 + 1] = v & 0xff
  }
  return bytes
}

/**
 * Linear floats -> 8-bit linear bytes, for the Adalight/AWA compatibility path.
 * Plain rounding here; temporal dithering, when wanted, is a separate stage.
 */
export function encodeLinear8 (colors: Float32Array, out?: Uint8Array): Uint8Array {
  const bytes = out ?? new Uint8Array(colors.length)
  for (let i = 0; i < colors.length; i++) {
    bytes[i] = Math.round(clamp01(colors[i] ?? 0) * 255)
  }
  return bytes
}

/**
 * `Afx` payload from integer triples already scaled to 0..65535. Kept for the
 * control panel, which produces one colour from the picker as integers.
 */
export function encodeAfxPayload (colors: Rgb[]): Uint8Array {
  const payload = new Uint8Array(colors.length * 6)
  const view = new DataView(payload.buffer)
  colors.forEach((color, index) => {
    const offset = index * 6
    view.setUint16(offset, color.r, false)
    view.setUint16(offset + 2, color.g, false)
    view.setUint16(offset + 4, color.b, false)
  })
  return payload
}
