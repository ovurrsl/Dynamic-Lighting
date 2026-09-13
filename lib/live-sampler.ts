import { createBorderDetector } from '#lib/engine/border'
import { resolveLayout, type EngineConfig } from '#lib/engine/config'
import { allocLinearGrid, createRgbaDecoder } from '#lib/engine/decode'
import { createSampler } from '#lib/engine/sample'
import { linearToSrgb } from '#lib/light'
import { NO_BORDER, type Border, type LedColors, type LedRect } from '#lib/engine/types'

/**
 * The live view: what the engine would sample, sampled here, from a real screen.
 *
 * Hyperion shows the captured frame with the LED regions drawn on it, and it is
 * the single most useful screen in the whole application - it is how you find
 * out that your band depth is too shallow, that your strip starts on the wrong
 * corner, or that the black-border detector is eating the top edge. We had a
 * layout preview that drew rectangles in made-up colours; that shows the shape
 * and nothing about whether the shape is right.
 *
 * This runs the SAME modules the capture engine runs - decode, border detector,
 * sampler - so the colour on each rectangle is the colour the strip would get.
 * A preview computed a different way is a preview that can be right while the
 * engine is wrong, which is the mistake this whole file exists to avoid.
 *
 * It is the panel's own capture, not the extension's. A visible tab may capture
 * freely; the throttling that forced the engine into an extension only bites a
 * continuous background capture.
 */

/** Preview grid. Same shape as the engine's, so the border detector agrees. */
export const PREVIEW_WIDTH = 128
export const PREVIEW_HEIGHT = 72

/** Frames a second. A preview is for the eye, not for the strip. */
export const PREVIEW_HZ = 15

export interface LiveFrame {
  /** One CSS colour per LED, in wire order, already gamma-encoded for a screen. */
  colors: string[]
  /** What the black-border detector found, in grid pixels. */
  border: Border
  /** Capture size as the track reports it, for the caller to show. */
  source?: { width: number, height: number }
}

export interface LiveSampler {
  /** Rebuilds for a new configuration. Cheap enough to call on every edit. */
  configure: (config: EngineConfig) => void
  /** Samples one frame from `source`. Returns null when it is not ready yet. */
  sample: (source: CanvasImageSource) => LiveFrame | null
  rects: () => LedRect[]
}

/**
 * Builds a sampler over a 2D canvas.
 *
 * `OffscreenCanvas` where it exists and a detached `<canvas>` where it does not:
 * Safari only got OffscreenCanvas recently and this file has to keep working in
 * the browsers the roadmap names, not just in Chrome.
 */
export function createLiveSampler (config: EngineConfig): LiveSampler {
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT)
      : Object.assign(document.createElement('canvas'), { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT })
  const context = (canvas as HTMLCanvasElement).getContext('2d', { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null

  const decoder = createRgbaDecoder(PREVIEW_WIDTH, PREVIEW_HEIGHT)
  const grid = allocLinearGrid(PREVIEW_WIDTH, PREVIEW_HEIGHT)
  const detector = createBorderDetector({}, () => performance.now())

  let layout = resolveLayout(config)
  let sampler = createSampler({ layout, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT })
  let out: LedColors = new Float32Array(layout.length * 3)
  let border: Border = NO_BORDER

  return {
    rects: () => layout,

    configure (next: EngineConfig): void {
      layout = resolveLayout(next)
      sampler = createSampler({ layout, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT })
      sampler.setBorder(border)
      out = new Float32Array(layout.length * 3)
    },

    sample (source: CanvasImageSource): LiveFrame | null {
      if (context === null) return null
      // A <video> with no frame yet has zero intrinsic size, and drawImage
      // throws on it rather than drawing nothing.
      const width = (source as HTMLVideoElement).videoWidth ?? 0
      const height = (source as HTMLVideoElement).videoHeight ?? 0
      if (width === 0 || height === 0) return null

      // The one downscale. `imageSmoothingQuality: 'high'` is a documented
      // area average - measured exact on a one-pixel checkerboard - and doing
      // it in one step is why there is no WebGL pipeline here.
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.drawImage(source, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT)
      const rgba = context.getImageData(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT).data

      decoder.decode(rgba, grid)
      border = detector.process(grid)
      sampler.setBorder(border)
      sampler.sample(grid, out, 'mean')

      const colors: string[] = new Array<string>(layout.length)
      for (let led = 0; led < layout.length; led += 1) {
        const at = led * 3
        // Back to sRGB for the screen: the engine works in linear light, and
        // painting linear values straight onto a display would show them far
        // darker than the strip will be.
        colors[led] = `rgb(${channel(out[at])} ${channel(out[at + 1])} ${channel(out[at + 2])})`
      }
      return { colors, border, source: { width, height } }
    }
  }
}

function channel (linear: number | undefined): number {
  return Math.round(linearToSrgb(Math.min(1, Math.max(0, linear ?? 0))) * 255)
}
