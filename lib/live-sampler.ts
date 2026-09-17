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

  /**
   * Built from the configuration the engine runs, not from defaults: the
   * border detector's mode and threshold, the reduction and its options, and
   * the crop. A preview that ignored them showed the default detector eating
   * an edge the engine had been told to leave alone - a preview "computed a
   * different way", which is the mistake this file exists to avoid.
   */
  let current = config
  let layout = resolveLayout(config)
  let detector = buildDetector(config)
  let sampler = buildSampler(config, layout)
  let out: LedColors = new Float32Array(layout.length * 3)
  let border: Border = NO_BORDER

  function buildDetector (c: EngineConfig) {
    return createBorderDetector({
      enabled: c.border.enabled,
      mode: c.border.mode,
      threshold: c.border.threshold,
      blurRemovePx: c.border.blurRemovePx
    }, () => performance.now())
  }

  function buildSampler (c: EngineConfig, rects: LedRect[]) {
    return createSampler({
      layout: rects,
      width: PREVIEW_WIDTH,
      height: PREVIEW_HEIGHT,
      reducedPixelSetFactor: c.sampling.reducedPixelSetFactor,
      accuracyLevel: c.sampling.accuracyLevel
    })
  }

  return {
    rects: () => layout,

    configure (next: EngineConfig): void {
      const borderChanged = JSON.stringify(next.border) !== JSON.stringify(current.border)
      current = next
      layout = resolveLayout(next)
      sampler = buildSampler(next, layout)
      // Rebuilt only when its settings changed, for the same reason the engine
      // rebuilds it with the stages: the candidate it holds was found by the
      // old probe pattern.
      if (borderChanged) {
        detector = buildDetector(next)
        border = NO_BORDER
      }
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
      // The crop as the source rectangle, exactly as the engine crops (runtime
      // processFrame): a taskbar the engine has been told to ignore must not
      // be in the preview either.
      const crop = current.capture.crop
      const sx = Math.round(width * crop.left)
      const sy = Math.round(height * crop.top)
      const sw = Math.max(1, Math.round(width * (1 - crop.left - crop.right)))
      const sh = Math.max(1, Math.round(height * (1 - crop.top - crop.bottom)))
      context.drawImage(source, sx, sy, sw, sh, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT)
      const rgba = context.getImageData(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT).data

      decoder.decode(rgba, grid)
      border = detector.process(grid)
      sampler.setBorder(border)
      sampler.sample(grid, out, current.sampling.mode)

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
