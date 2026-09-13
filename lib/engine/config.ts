import {
  CORNERS,
  MATRIX_REFERENCE,
  REFERENCE_LAYOUT,
  applyBlacklist,
  classicLayout,
  ledCount,
  matrixLayout,
  matrixLedCount,
  type BlacklistRange,
  type ClassicLayoutSpec,
  type Corner,
  type Keystone,
  type MatrixLayoutSpec
} from '#lib/engine/layout'
import { COLOR_ORDERS, DEFAULT_COLOR_ORDER, type ColorOrder } from '#lib/engine/order'
import type { LedRect } from '#lib/engine/types'

/**
 * The engine's configuration: what the user's rig actually is.
 *
 * This crosses two trust boundaries - the panel stores it and sends it to the
 * extension, and the extension reads it back from `chrome.storage` after
 * Chrome has killed the service worker - so it is parsed, not cast.
 * `parseEngineConfig` is the only way in, and it validates by BUILDING the
 * thing: the layout generator and the colour-order stage already refuse
 * nonsense with specific errors, so re-stating their rules here would be a
 * second source of truth to disagree with the first (the plan's section 11
 * lists two Hyperion defects that are exactly that).
 *
 * Only what is wired is here. Smoothing constants, the border detector's mode
 * and the calibration profiles are configurable in their own modules and get
 * their own config once the panel drives them; a field nobody reads would be a
 * promise the product does not keep.
 */

export type LayoutConfig =
  | ({ kind: 'classic' } & ClassicLayoutSpec)
  | ({ kind: 'matrix' } & MatrixLayoutSpec)

export interface ColorOrderConfig {
  order: ColorOrder
  /** Per-LED overrides by wire index; absent means the whole strip uses `order`. */
  overrides?: Record<number, ColorOrder>
}

export interface EngineConfig {
  layout: LayoutConfig
  /** LEDs that are wired but must never light. */
  blacklist: BlacklistRange[]
  colorOrder: ColorOrderConfig
}

/** The reference rig: the 108-LED frame on the 27" panel, wired rgb. */
export const DEFAULT_ENGINE_CONFIG: Readonly<EngineConfig> = Object.freeze({
  layout: Object.freeze({ kind: 'classic', ...REFERENCE_LAYOUT }),
  blacklist: Object.freeze([]) as unknown as BlacklistRange[],
  colorOrder: Object.freeze({ order: DEFAULT_COLOR_ORDER })
})

/** Number of LEDs the layout describes, before the blacklist (which keeps the count). */
export function configLedCount (config: EngineConfig): number {
  const layout = config.layout
  if (layout.kind === 'matrix') return matrixLedCount(layout)
  const gap = layout.gap
  return ledCount(layout) - (gap === undefined ? 0 : gap.length)
}

/**
 * The sampling rectangles the config describes, in wire order, with the
 * blacklist applied. This is the one function the capture engine and the
 * panel's preview both call, so what the preview draws is what the engine
 * samples - a layout editor whose picture comes from different code than the
 * engine is a layout editor that lies.
 */
export function resolveLayout (config: EngineConfig): LedRect[] {
  const layout = config.layout
  const rects = layout.kind === 'matrix' ? matrixLayout(layout) : classicLayout(layout)
  return applyBlacklist(rects, config.blacklist)
}

// ---------------------------------------------------------------------------
// Parsing.
// ---------------------------------------------------------------------------

/** Thrown with the path of the field at fault, so the panel can point at it. */
export class ConfigError extends Error {
  readonly path: string

  constructor (path: string, message: string) {
    super(`config: ${path} ${message}`)
    this.name = 'ConfigError'
    this.path = path
  }
}

type Obj = Record<string, unknown>

function object (value: unknown, path: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(path, `must be an object, got ${describe(value)}`)
  }
  return value as Obj
}

function integer (value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(path, `must be an integer in ${min}..${max}, got ${describe(value)}`)
  }
  return value
}

function fraction (value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(path, `must be a finite number, got ${describe(value)}`)
  }
  return value
}

function boolean (value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ConfigError(path, `must be a boolean, got ${describe(value)}`)
  return value
}

function corner (value: unknown, path: string): Corner {
  if (typeof value !== 'string' || !CORNERS.includes(value as Corner)) {
    throw new ConfigError(path, `must be one of ${CORNERS.join(', ')}, got ${describe(value)}`)
  }
  return value as Corner
}

function optional<T> (value: unknown, path: string, read: (v: unknown, p: string) => T): T | undefined {
  return value === undefined ? undefined : read(value, path)
}

function describe (value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return `an array of ${value.length}`
  return typeof value === 'object' ? 'an object' : String(value)
}

function readKeystone (value: unknown, path: string): Keystone {
  const raw = object(value, path)
  const point = (name: keyof Keystone): { x: number, y: number } => {
    const p = object(raw[name], `${path}.${name}`)
    return { x: fraction(p.x, `${path}.${name}.x`), y: fraction(p.y, `${path}.${name}.y`) }
  }
  return {
    topLeft: point('topLeft'),
    topRight: point('topRight'),
    bottomRight: point('bottomRight'),
    bottomLeft: point('bottomLeft')
  }
}

function readClassic (raw: Obj): ClassicLayoutSpec {
  const spec: ClassicLayoutSpec = {
    top: integer(raw.top, 'layout.top', 0),
    right: integer(raw.right, 'layout.right', 0),
    bottom: integer(raw.bottom, 'layout.bottom', 0),
    left: integer(raw.left, 'layout.left', 0),
    depthTopBottom: fraction(raw.depthTopBottom, 'layout.depthTopBottom'),
    depthLeftRight: fraction(raw.depthLeftRight, 'layout.depthLeftRight'),
    start: corner(raw.start, 'layout.start'),
    clockwise: boolean(raw.clockwise, 'layout.clockwise')
  }
  const offset = optional(raw.offset, 'layout.offset', (v, p) => integer(v, p, Number.MIN_SAFE_INTEGER))
  if (offset !== undefined) spec.offset = offset
  const overlap = optional(raw.overlap, 'layout.overlap', fraction)
  if (overlap !== undefined) spec.overlap = overlap
  const edgeGap = optional(raw.edgeGap, 'layout.edgeGap', fraction)
  if (edgeGap !== undefined) spec.edgeGap = edgeGap
  const aspectRatio = optional(raw.aspectRatio, 'layout.aspectRatio', fraction)
  if (aspectRatio !== undefined) spec.aspectRatio = aspectRatio
  const keystone = optional(raw.keystone, 'layout.keystone', readKeystone)
  if (keystone !== undefined) spec.keystone = keystone
  if (raw.gap !== undefined) {
    const gap = object(raw.gap, 'layout.gap')
    spec.gap = {
      position: integer(gap.position, 'layout.gap.position', 0),
      length: integer(gap.length, 'layout.gap.length', 0)
    }
  }
  return spec
}

function readMatrix (raw: Obj): MatrixLayoutSpec {
  const cabling = raw.cabling
  if (cabling !== 'snake' && cabling !== 'parallel') {
    throw new ConfigError('layout.cabling', `must be snake or parallel, got ${describe(cabling)}`)
  }
  const direction = raw.direction
  if (direction !== 'horizontal' && direction !== 'vertical') {
    throw new ConfigError('layout.direction', `must be horizontal or vertical, got ${describe(direction)}`)
  }
  const spec: MatrixLayoutSpec = {
    columns: integer(raw.columns, 'layout.columns', 1),
    rows: integer(raw.rows, 'layout.rows', 1),
    cabling,
    direction,
    start: corner(raw.start, 'layout.start')
  }
  if (raw.gap !== undefined) {
    const gap = object(raw.gap, 'layout.gap')
    const side = (name: 'top' | 'right' | 'bottom' | 'left'): number | undefined =>
      optional(gap[name], `layout.gap.${name}`, fraction)
    spec.gap = {}
    for (const name of ['top', 'right', 'bottom', 'left'] as const) {
      const v = side(name)
      if (v !== undefined) spec.gap[name] = v
    }
  }
  return spec
}

function readColorOrderName (value: unknown, path: string): ColorOrder {
  if (typeof value !== 'string' || !COLOR_ORDERS.includes(value as ColorOrder)) {
    throw new ConfigError(path, `must be one of ${COLOR_ORDERS.join(', ')}, got ${describe(value)}`)
  }
  return value as ColorOrder
}

/**
 * Validates an unknown value as an `EngineConfig`, throwing `ConfigError` with
 * the path of the first field at fault. Field types and ranges are checked
 * here; whether the whole thing is a layout that can be built is checked by
 * building it, so the generators' own rules are the only copy of them.
 */
export function parseEngineConfig (value: unknown): EngineConfig {
  const raw = object(value, 'config')
  const layoutRaw = object(raw.layout, 'config.layout')
  const kind = layoutRaw.kind
  if (kind !== 'classic' && kind !== 'matrix') {
    throw new ConfigError('layout.kind', `must be classic or matrix, got ${describe(kind)}`)
  }
  const layout: LayoutConfig = kind === 'matrix'
    ? { kind, ...readMatrix(layoutRaw) }
    : { kind, ...readClassic(layoutRaw) }

  const blacklistRaw = raw.blacklist ?? []
  if (!Array.isArray(blacklistRaw)) throw new ConfigError('blacklist', `must be an array, got ${describe(blacklistRaw)}`)
  const blacklist: BlacklistRange[] = blacklistRaw.map((entry, i) => {
    const range = object(entry, `blacklist[${i}]`)
    return {
      start: integer(range.start, `blacklist[${i}].start`, 0),
      length: integer(range.length, `blacklist[${i}].length`, 1)
    }
  })

  const colorOrderRaw = raw.colorOrder === undefined ? {} : object(raw.colorOrder, 'config.colorOrder')
  const colorOrder: ColorOrderConfig = {
    order: colorOrderRaw.order === undefined ? DEFAULT_COLOR_ORDER : readColorOrderName(colorOrderRaw.order, 'colorOrder.order')
  }
  if (colorOrderRaw.overrides !== undefined) {
    const overridesRaw = object(colorOrderRaw.overrides, 'colorOrder.overrides')
    const overrides: Record<number, ColorOrder> = {}
    for (const [at, order] of Object.entries(overridesRaw)) {
      const led = Number(at)
      if (!Number.isInteger(led) || led < 0) {
        throw new ConfigError(`colorOrder.overrides.${at}`, 'must be keyed by a non-negative LED index')
      }
      overrides[led] = readColorOrderName(order, `colorOrder.overrides.${at}`)
    }
    colorOrder.overrides = overrides
  }

  const config: EngineConfig = { layout, blacklist, colorOrder }

  // The generators own their rules; ask them. A layout that cannot be built is
  // a config error with the generator's own message, which names the knob.
  let rects: LedRect[]
  try {
    rects = layout.kind === 'matrix' ? matrixLayout(layout) : classicLayout(layout)
  } catch (error) {
    throw new ConfigError('layout', error instanceof Error ? error.message : String(error))
  }
  try {
    applyBlacklist(rects, blacklist)
  } catch (error) {
    throw new ConfigError('blacklist', error instanceof Error ? error.message : String(error))
  }
  for (const at of Object.keys(colorOrder.overrides ?? {})) {
    if (Number(at) >= rects.length) {
      throw new ConfigError(`colorOrder.overrides.${at}`, `is past the ${rects.length} LEDs the layout describes`)
    }
  }
  return config
}

/** A config as JSON, for `chrome.storage` and for the profiles API. */
export function serialiseEngineConfig (config: EngineConfig): string {
  return JSON.stringify(config)
}

/** Parses JSON and validates it; a bad string is a `ConfigError`, never a throw from JSON. */
export function deserialiseEngineConfig (json: string): EngineConfig {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    throw new ConfigError('config', `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseEngineConfig(value)
}

/** The matrix reference, for a panel offering the other layout kind. */
export const MATRIX_ENGINE_CONFIG: Readonly<EngineConfig> = Object.freeze({
  layout: Object.freeze({ kind: 'matrix', ...MATRIX_REFERENCE }),
  blacklist: Object.freeze([]) as unknown as BlacklistRange[],
  colorOrder: Object.freeze({ order: DEFAULT_COLOR_ORDER })
})
