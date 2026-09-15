'use client'

import { useId, useRef, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { useTranslate } from '#components/Preferences'
import { CORNER_ORDER, nudge, pointerToLayout } from '#lib/preview'
import type { Keystone, LayoutPoint } from '#lib/engine/layout'
import type { LedRect } from '#lib/engine/types'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * The drag handles' accessible names. These are the only strings this component
 * owns - everything else it shows comes in as the `label` prop - and they exist
 * because a bare draggable rectangle announces nothing at all to a screen
 * reader, which would make the keyboard path unusable rather than merely plain.
 */
const HANDLE_KEY: Record<(typeof CORNER_ORDER)[number], MessageKey> = {
  topLeft: 'layout.handle.topLeft',
  topRight: 'layout.handle.topRight',
  bottomRight: 'layout.handle.bottomRight',
  bottomLeft: 'layout.handle.bottomLeft'
}

/** Arrow keys move by this much of the frame; Shift moves ten times as far. */
const NUDGE_STEP = 0.002

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
  outline = false,
  transparent = false,
  keystone,
  onKeystone,
  label
}: {
  rects: LedRect[]
  aspectRatio: number
  colorAt: (index: number, count: number) => string
  /** Ring LED 0, so the wire's entry point is visible without counting. */
  outlineFirst?: boolean
  /** Adds a blurred copy behind the LEDs, so they read as light rather than paint. */
  glow?: boolean
  /**
   * Outlines every LED. Needed whenever something is shown BEHIND the frame:
   * an LED filled with the colour it sampled is, by definition, the same colour
   * as the pixels under it, so without an edge the whole ring disappears into
   * the picture and the view stops showing anything.
   */
  outline?: boolean
  /** Drop the black ground, for when something is shown behind the frame. */
  transparent?: boolean
  /**
   * The four corners of the framed area, draggable when `onKeystone` is given.
   * The mapping from pointer to layout coordinates lives here because this is
   * the component that owns the forward mapping; splitting the two is how they
   * drift apart.
   */
  keystone?: Keystone
  onKeystone?: (corner: (typeof CORNER_ORDER)[number], point: LayoutPoint) => void
  label: string
}) {
  const width = 1000
  const height = Math.max(1, Math.round(width / aspectRatio))
  const count = rects.length
  // Breathing room outside the frame. Without it a corner handle - which sits
  // exactly on the layout's 0 or 1 - is drawn half outside the picture and can
  // only be grabbed by its inner half; the frame's own stroke clips too.
  const margin = 26
  // Two frames on one page would otherwise share a filter id, and the second
  // would silently take the first one's blur.
  const blur = `${useId()}-glow`
  const svg = useRef<SVGSVGElement>(null)
  const t = useTranslate()
  const editing = keystone !== undefined && onKeystone !== undefined

  const move = (corner: (typeof CORNER_ORDER)[number], event: ReactPointerEvent<SVGGElement>): void => {
    const element = svg.current
    if (element === null || onKeystone === undefined) return
    onKeystone(corner, pointerToLayout(event.clientX, event.clientY, element.getBoundingClientRect()))
  }

  const key = (corner: (typeof CORNER_ORDER)[number], event: ReactKeyboardEvent<SVGGElement>): void => {
    if (keystone === undefined || onKeystone === undefined) return
    const step = event.shiftKey ? NUDGE_STEP * 10 : NUDGE_STEP
    const by = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
    if (by === undefined) return
    event.preventDefault()
    onKeystone(corner, nudge(keystone[corner], by[0] as number, by[1] as number, step))
  }

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
        stroke={outlineFirst && at === 0 ? 'white' : outline ? 'rgb(0 0 0 / 0.55)' : 'none'}
        strokeWidth={outlineFirst && at === 0 ? 4 : outline ? 1.5 : 0}
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
      className={`w-full rounded-lg ${transparent ? '' : 'bg-black/80'}`}
      ref={svg}
      role="img"
      viewBox={`${-margin} ${-margin} ${width + margin * 2} ${height + margin * 2}`}
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
        height={height}
        stroke="rgb(255 255 255 / 0.18)"
        strokeWidth={2}
        width={width}
        x={0}
        y={0}
      />
      {/* The blur goes BEHIND a crisp copy; blurring the LEDs themselves would
          spread them out instead of making them glow. */}
      {glow && <g aria-hidden filter={`url(#${blur})`} opacity={0.9}>{body}</g>}
      <g>{body}</g>
      {editing && CORNER_ORDER.map((corner) => {
        const point = keystone[corner]
        return (
          <g
            aria-label={t(HANDLE_KEY[corner])}
            className="group cursor-grab touch-none focus:outline-none"
            key={corner}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => key(corner, event)}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              event.currentTarget.focus()
              move(corner, event)
            }}
            onPointerMove={(event) => {
              // Only while captured: without this the corner would follow a
              // pointer that is merely passing over it.
              if (event.currentTarget.hasPointerCapture(event.pointerId)) move(corner, event)
            }}
            onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId) }}
          >
            {/* A generous invisible target: the visible dot is too small to grab. */}
            <circle cx={point.x * width} cy={point.y * height} fill="transparent" r={34} />
            <circle
              className="fill-white/25 stroke-white group-focus:fill-primary/40 group-focus:stroke-primary"
              cx={point.x * width}
              cy={point.y * height}
              r={16}
              strokeWidth={4}
            />
          </g>
        )
      })}
    </svg>
  )
}
