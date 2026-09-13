'use client'

import { useId } from 'react'

import type { LedRect } from '#lib/engine/types'

/**
 * The strip's geometry, drawn once and shared.
 *
 * Both places that show the strip - the layout editor and the colour card's
 * preview - draw it from the SAME rectangles the engine samples, so neither can
 * be right while the other is wrong. Before this existed the colour preview
 * hard-coded 35/19/35/19 while claiming to show the rig "as it is physically
 * wired", which stopped being true the moment the layout became configurable.
 *
 * `colorAt` is what the two callers differ in: the editor ramps hue along wire
 * order to show where the strip starts and which way it runs, the colour card
 * paints every LED the chosen colour.
 */
export function LedFrame ({
  rects,
  aspectRatio,
  colorAt,
  outlineFirst = false,
  glow = false,
  label
}: {
  rects: LedRect[]
  aspectRatio: number
  colorAt: (index: number, count: number) => string
  /** Ring LED 0, so the wire's entry point is visible without counting. */
  outlineFirst?: boolean
  /** Adds a blurred copy behind the LEDs, so they read as light rather than paint. */
  glow?: boolean
  label: string
}) {
  const width = 1000
  const height = Math.max(1, Math.round(width / aspectRatio))
  const count = rects.length
  // Two frames on one page would otherwise share a filter id, and the second
  // would silently take the first one's blur.
  const blur = `${useId()}-glow`

  const body = rects.map((rect, at) => {
    const w = (rect.xMax - rect.xMin) * width
    const h = (rect.yMax - rect.yMin) * height
    // A blacklisted LED is a zero-area rectangle on purpose: it keeps its wire
    // index, because every later LED's position depends on it.
    if (w <= 0 || h <= 0) return null
    return (
      <rect
        fill={colorAt(at, count)}
        height={h}
        key={at}
        stroke={outlineFirst && at === 0 ? 'white' : 'none'}
        strokeWidth={outlineFirst && at === 0 ? 3 : 0}
        width={w}
        x={rect.xMin * width}
        y={rect.yMin * height}
      >
        <title>{`LED ${at}`}</title>
      </rect>
    )
  })

  return (
    <svg
      aria-label={label}
      className="w-full rounded-lg bg-black/80"
      role="img"
      viewBox={`0 0 ${width} ${height}`}
    >
      {glow && (
        <defs>
          <filter id={blur}>
            <feGaussianBlur stdDeviation={14} />
          </filter>
        </defs>
      )}
      <rect
        fill="none"
        height={height - 2}
        stroke="rgb(255 255 255 / 0.18)"
        strokeWidth={2}
        width={width - 2}
        x={1}
        y={1}
      />
      {/* The blur goes BEHIND a crisp copy; blurring the LEDs themselves would
          spread them out instead of making them glow. */}
      {glow && <g aria-hidden filter={`url(#${blur})`} opacity={0.9}>{body}</g>}
      <g>{body}</g>
    </svg>
  )
}
