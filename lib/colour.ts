import type { Color } from '@heroui/react'

/**
 * Colour conversion between the picker and the LED wire format.
 *
 * Two things here are easy to get wrong and both have already bitten this
 * project, so they are spelled out:
 *
 * 1. React Aria's `Color` throws from `getChannelValue('red')` when the colour is
 *    currently in HSB. Always `toFormat('rgb')` first. The picker works in HSB
 *    (saturation x brightness area + hue slider), so this is the normal case,
 *    not an edge case.
 *
 * 2. The firmware applies **no transfer function** — WS2812B brightness is
 *    roughly proportional to PWM duty, which is proportional to the byte value.
 *    So the wire wants *linear* light, and a colour picked in sRGB has to be
 *    decoded before it is sent. Sending sRGB straight down makes everything too
 *    bright; applying a 2.2 gamma *encode* on top makes it far too dark. Decode,
 *    do not encode.
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

/** 8-bit sRGB, for previewing in the UI. */
export function toRgb8 (color: Color): Rgb {
  const rgb = color.toFormat('rgb')
  return {
    r: Math.round(rgb.getChannelValue('red')),
    g: Math.round(rgb.getChannelValue('green')),
    b: Math.round(rgb.getChannelValue('blue'))
  }
}

/**
 * 16-bit linear, which is what the `Afx` frame carries.
 *
 * 16 bits rather than 8 because the low end of a linear ramp needs more than 256
 * steps before the firmware dithers it back down; 8-bit linear would band badly
 * in exactly the dark scenes a bias light spends most of its time in.
 */
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

/**
 * Builds one `Afx` frame body: 16-bit big-endian linear triples.
 *
 * The header, length and Fletcher checksum are the extension's job — it owns the
 * serial port. This produces only the pixel payload, so the same function can
 * feed both a solid colour and, later, a per-LED ambilight frame.
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
