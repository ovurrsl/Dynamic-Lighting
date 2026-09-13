import type { LinearGrid } from '#lib/engine/types'
import { buildSrgbToLinearLut } from '#lib/light'

/**
 * The step between the capture and the engine: 8-bit sRGB pixels, as
 * `getImageData` hands them back (RGBA, row-major, top row first), become the
 * linear-light grid every stage after this one works on.
 *
 * This is the decode the plan calls the biggest single quality gain for the
 * price of a table lookup: average in light, not in gamma-encoded values
 * (lib/light.ts, and section 9 of docs/hyperion-port-plan.md for the proof
 * that Hyperion never does it). The transfer function is evaluated 256 times
 * at construction and never again; a 128x72 frame is 9216 lookups per channel.
 *
 * Alpha is ignored: a screen capture is opaque and the byte is padding.
 */

export interface RgbaDecoder {
  readonly width: number
  readonly height: number
  /**
   * Decodes `rgba` (exactly `width * height * 4` bytes) into `out`, or into a
   * new grid when `out` is absent. Returns the grid it wrote.
   */
  decode (rgba: Uint8ClampedArray | Uint8Array, out?: LinearGrid): LinearGrid
}

export function allocLinearGrid (width: number, height: number): LinearGrid {
  validateSize(width, height)
  return { width, height, data: new Float32Array(width * height * 3) }
}

export function createRgbaDecoder (width: number, height: number): RgbaDecoder {
  validateSize(width, height)
  const lut = buildSrgbToLinearLut()
  const pixels = width * height
  return {
    width,
    height,
    decode (rgba, out = allocLinearGrid(width, height)): LinearGrid {
      if (rgba.length !== pixels * 4) {
        throw new RangeError(`decode: ${rgba.length} bytes is not ${width}x${height} RGBA (${pixels * 4})`)
      }
      if (out.width !== width || out.height !== height || out.data.length < pixels * 3) {
        throw new RangeError(`decode: output grid is ${out.width}x${out.height}, decoder is ${width}x${height}`)
      }
      decodeRgba(rgba, lut, out.data, pixels)
      return out
    }
  }
}

/** The inner loop, exported for a caller that keeps its own table. */
export function decodeRgba (rgba: ArrayLike<number>, lut: Float32Array, out: Float32Array, pixels: number): void {
  let src = 0
  let dst = 0
  for (let p = 0; p < pixels; p++) {
    out[dst] = lut[rgba[src] as number] as number
    out[dst + 1] = lut[rgba[src + 1] as number] as number
    out[dst + 2] = lut[rgba[src + 2] as number] as number
    src += 4
    dst += 3
  }
}

function validateSize (width: number, height: number): void {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError(`decode: grid size must be positive integers, got ${width}x${height}`)
  }
}
