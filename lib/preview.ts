import type { LayoutConfig } from '#lib/engine/config'
import { LAYOUT_DEFAULTS } from '#lib/engine/layout'

/**
 * How a layout is drawn. Separate from the component that draws it so it can be
 * tested without a DOM: these two functions are where a matrix would silently
 * be framed as 16:9, or where the hue ramp would divide by zero on an empty
 * strip, and both are cheaper to pin down here than to notice on screen.
 */

/** Width / height to frame the layout at, so every preview frames it the same. */
export function frameAspect (layout: LayoutConfig): number {
  if (layout.kind === 'matrix') {
    return Math.max(layout.columns, 1) / Math.max(layout.rows, 1)
  }
  const given = layout.aspectRatio ?? LAYOUT_DEFAULTS.aspectRatio
  // A zero or negative ratio would make the drawing height zero or flip it.
  return given > 0 ? given : LAYOUT_DEFAULTS.aspectRatio
}

/**
 * Wire order through the hue wheel: 0 red, rising to magenta at the last LED.
 * It makes the two things that are genuinely hard to get right - where the strip
 * starts and which way it runs - readable at a glance instead of countable.
 *
 * Stops at 300 rather than 360 so the last LED never has the same hue as the
 * first, which would hide exactly the mistake this is meant to show.
 */
export function wireOrderColor (index: number, count: number): string {
  const hue = count > 1 ? (index / count) * 300 : 0
  return `hsl(${hue} 85% 55% / 0.75)`
}
