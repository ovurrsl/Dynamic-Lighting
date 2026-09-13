import type { Color } from '@heroui/react'

import { type Rgb, srgbToLinear } from '#lib/light'

export { encodeAfxPayload, linearToSrgb, srgbToLinear, type Rgb } from '#lib/light'

/**
 * Conversions between React Aria's `Color` and the wire. The pure maths lives
 * in lib/light.ts so the engine and the tests can use it without a UI kit; this
 * file owns only the HeroUI-specific half.
 *
 * One thing here has already bitten this project: React Aria's `Color` throws
 * from `getChannelValue('red')` when the colour is currently in HSB. Always
 * `toFormat('rgb')` first. The picker works in HSB (saturation x brightness area
 * + hue slider), so this is the normal case, not an edge case.
 */

/** 8-bit sRGB, for previewing in the UI. */
export function toRgb8 (color: Color): Rgb {
  const rgb = color.toFormat('rgb')
  return {
    r: Math.round(rgb.getChannelValue('red')),
    g: Math.round(rgb.getChannelValue('green')),
    b: Math.round(rgb.getChannelValue('blue'))
  }
}

/** 16-bit linear, which is what the `Afx` frame carries. */
export function toLinear16 (color: Color): Rgb {
  const { r, g, b } = toRgb8(color)
  return {
    r: Math.round(srgbToLinear(r / 255) * 65535),
    g: Math.round(srgbToLinear(g / 255) * 65535),
    b: Math.round(srgbToLinear(b / 255) * 65535)
  }
}

export function toCss (color: Color): string {
  return color.toString('css')
}

export function toHex (color: Color): string {
  return color.toString('hex')
}
