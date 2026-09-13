import type { LayoutConfig } from '#lib/engine/config'
import { LAYOUT_DEFAULTS, NO_KEYSTONE, type Keystone, type LayoutPoint } from '#lib/engine/layout'

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

/**
 * Keystone editing maths, kept here rather than in the component for the same
 * reason as the framing: a pointer-to-corner mapping that is off by the SVG's
 * own offset is invisible in a screenshot and obvious in a test.
 */

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where a pointer landed, in the 0..1 coordinates the layout speaks.
 *
 * Clamped, because a drag that leaves the picture should pin the corner to the
 * edge rather than describe a strip mounted off the side of the monitor. A box
 * with no area (the element is display:none, or not laid out yet) maps to the
 * top-left rather than to NaN.
 */
export function pointerToLayout (clientX: number, clientY: number, box: Box): LayoutPoint {
  const x = box.width > 0 ? (clientX - box.left) / box.width : 0
  const y = box.height > 0 ? (clientY - box.top) / box.height : 0
  return { x: clamp01(x), y: clamp01(y) }
}

/** Keyboard nudging, so the corners are not a mouse-only control. */
export function nudge (point: LayoutPoint, dx: number, dy: number, step: number): LayoutPoint {
  return { x: clamp01(point.x + dx * step), y: clamp01(point.y + dy * step) }
}

function clamp01 (value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** True when the four corners are the default full frame, so the UI can say so. */
export function isDefaultKeystone (keystone: Keystone | undefined): boolean {
  if (keystone === undefined) return true
  return CORNER_ORDER.every((corner) => {
    const a = keystone[corner]
    const b = NO_KEYSTONE[corner]
    return a.x === b.x && a.y === b.y
  })
}

export const CORNER_ORDER = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const
