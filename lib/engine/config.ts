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
import { ADJUSTMENT_DEFAULTS, TEMPERATURE_MAX, TEMPERATURE_MIN } from '#lib/engine/adjust'
import { BORDER_DEFAULTS, BORDER_MODES, type BorderMode } from '#lib/engine/border'
import { MAX_ACCURACY_LEVEL, SAMPLER_DEFAULTS, SAMPLE_MODES, type SampleMode } from '#lib/engine/sample'
import { parseEffectSpec, type EffectKind } from '#lib/engine/effects'
import { SMOOTHING_PROFILES } from '#lib/engine/smooth'
import type { Calibration } from '#lib/engine/protocol'
import type { LedRect } from '#lib/engine/types'
import { WLED_DEFAULT_GAMMA, WLED_GAMMA_MAX, WLED_GAMMA_MIN } from '#lib/engine/wled'

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

/**
 * What goes on the wire, and the reason this is configurable at all.
 *
 * 'Afx' is our own: 16-bit linear with a Fletcher trailer, and the only one
 * that carries the precision the engine works in. It needs our firmware.
 *
 * 'Awa' and 'Ada' are Adalight, which is what everyone else already speaks -
 * HyperSerialESP32, HyperSerialWLED, the stock Adalight FastLED sketch, a
 * dozen forks. Supporting them is the difference between "works with the strip
 * you already own" and "reflash your board first", and the encoders have
 * existed and been tested since the protocol module was written; only the
 * choice was missing.
 *
 * 'Ada' has NO integrity check of any kind - a flipped bit is shown as colour.
 * It is here because some old sketches accept nothing else, and it is never the
 * default.
 */
export type WireFormat = 'Afx' | 'Awa' | 'Ada'

export const WIRE_FORMATS: readonly WireFormat[] = Object.freeze(['Afx', 'Awa', 'Ada'])

/**
 * How the frame reaches the device.
 *
 * 'serial' is a paired Web Serial port: no network, no configuration, no second
 * device. It is the default and stays the default.
 *
 * 'websocket' is our own firmware over a WebSocket, carrying the same bytes the
 * serial port does. 'wled' is a WLED device over its own JSON WebSocket. Both
 * exist because on iOS there is no Web Serial, no WebUSB, no WebHID and no Web
 * Bluetooth - all four are Chromium-only and Apple requires WebKit - so the
 * network is not one way to a strip there, it is the only way.
 */
export type OutputTransport = 'serial' | 'websocket' | 'wled'

export const OUTPUT_TRANSPORTS: readonly OutputTransport[] = Object.freeze(['serial', 'websocket', 'wled'])

export interface OutputConfig {
  transport: OutputTransport
  /**
   * Host for the two network transports. What a user types - an address, with
   * or without a scheme - not a URL; the drivers build the URL from it.
   */
  host?: string
  /** WLED only: which segment to write, for a device that has several. */
  segment?: number
  /**
   * WLED only: the device's own colour gamma, which the driver undoes in
   * advance so the strip ends up showing linear light (lib/engine/wled.ts).
   * 2.8 is a stock device; 1 is one with colour gamma switched off.
   */
  wledGamma?: number
  format: WireFormat
  /**
   * 'Awa' only: the four white-balance bytes HyperHDR's calibrated 'AwA' frame
   * carries. Absent means the plain 'Awa' magic, which is what a stock
   * Adalight sketch expects.
   */
  calibration?: Calibration
  /**
   * Diffuse the 8-bit rounding error across time. 'Awa' and 'Ada' only.
   *
   * These two formats exist to drive a sketch that is not ours, and such a
   * sketch writes the byte straight to its LED library: nothing downstream
   * recovers the precision that rounding to 255 LINEAR levels throws away, and
   * the dark end is where a bias light lives. `Afx` refuses it because our own
   * firmware dithers the 16-bit value itself.
   */
  dither?: boolean
}

/**
 * The capture side, which until now was three constants in the engine.
 *
 * Hyperion makes every one of these a setting (schema-framegrabber.json), and
 * it is right to: `pixelDecimation` alone is the difference between a Pi that
 * keeps up and one that does not, and the crop is what saves anyone whose
 * capture includes a taskbar or a second monitor.
 */
/**
 * Where the picture comes from.
 *
 * 'screen' is `getDisplayMedia` and is what almost everyone wants.
 *
 * 'device' is a video input - a USB capture card, or a webcam. It is here for
 * two reasons and both are real. On a platform with no screen capture it is the
 * only source at all; and it is **the only thing that defeats DRM blanking**,
 * because an HDMI splitter feeding a capture card takes the signal below the
 * decryption, where there is nothing left to blank. Netflix, Prime and Disney+
 * reach a desktop already painted black and no software inside the operating
 * system can change that.
 */
export type CaptureSource = 'screen' | 'device'

export const CAPTURE_SOURCES: readonly CaptureSource[] = Object.freeze(['screen', 'device'])

export interface CaptureConfig {
  /** Screen capture, or a video input. */
  source?: CaptureSource
  /**
   * Which video input, when `source` is 'device'.
   *
   * Checked against the current device list rather than trusted: a `deviceId`
   * is not stable across browsers or profiles and rotates when site data is
   * cleared, so a stale one must be a sentence rather than a capture that
   * silently opens the wrong camera.
   */
  deviceId?: string
  /**
   * The analysis grid. Not the capture resolution - the source is whatever the
   * screen is - but the size everything downstream sees.
   *
   * 128x72 is the default because it gives about 3.7 horizontal cells per LED
   * on a 35-LED top edge, which is comfortable. Lower is cheaper and the
   * downscale is the measured bottleneck (p50 9.00 ms at 1080p against an
   * 8.33 ms budget), so this is the first knob to reach for - and the reason
   * it is a knob rather than a smaller constant is that the quality cost has
   * not been measured yet.
   */
  gridWidth: number
  gridHeight: number
  /** Capture rate ceiling. A ceiling, not a demand: the pipeline is latest-wins. */
  fps: number
  /**
   * Fractions of the source cut away before anything looks at it, 0..0.45 each.
   *
   * Hyperion counts these in source pixels; fractions here, because the source
   * size changes under us - a resolution change ends the stream and the next
   * one may be a different size, and a crop in pixels would then mean
   * something different without anyone touching it.
   */
  crop: { left: number, right: number, top: number, bottom: number }
}

/**
 * How hard the strip is smoothed.
 *
 * Until now these were the smoother's own defaults, compiled in: good numbers,
 * but the right ones depend on what is on screen rather than on taste. A film
 * is 24 fps of deliberate cuts, a game is continuous motion you are reacting
 * to, and the smoothing that flatters one is wrong for the other - which is
 * why the design plan ships three named profiles rather than a slider.
 *
 * Only the numbers are stored; the profile NAME is derived from them
 * (`profileOf`). A stored name could otherwise say "balanced" over cinema's
 * numbers, which is a state that can exist and means nothing.
 */
export interface SmoothingConfig {
  /**
   * Time constant while a channel RISES, ms. Short keeps flashes sharp, which
   * is where the eye is sensitive.
   */
  attackMs: number
  /**
   * Time constant while a channel FALLS, ms. Long kills the shimmer, which is
   * where the eye reads noise. The asymmetry is the whole point: Hyperion uses
   * one constant for both and loses one of the two.
   */
  releaseMs: number
  /**
   * Mean |target - output| across every channel above which the frame SNAPS
   * instead of being smoothed - a scene cut, reproduced as a cut.
   *
   * 1 turns it off exactly rather than by a sentinel: each channel's difference
   * is at most 1, so a mean ABOVE 1 is unreachable.
   */
  cutThreshold: number
}

/**
 * Colour correction, in linear light, before the frame leaves the engine.
 *
 * The chain behind these has been written and tested since the adjustment
 * module landed - saturation and lightness in Oklab, a white-balance shift, an
 * artistic taper, a backlight floor - and every knob has been pinned to its
 * identity value because nothing could set them. These are the ones a person
 * actually reaches for; the eight-corner colour cube and per-LED profiles stay
 * in the engine for the calibration wizard rather than becoming eight more
 * sliders nobody can interpret.
 *
 * Two of them exist because of what a strip IS rather than as taste:
 *
 * - `temperature`, because WS2812B reels are green-weighted and two reels from
 *   different batches are not the same white.
 * - `backlightThreshold`, because a strip that goes completely dark in a dark
 *   scene reads as "it broke" rather than as "the scene is dark".
 */
export interface ColorConfig {
  /** 0..100. Overall ceiling, hinged at 50 exactly as Hyperion's is. */
  brightness: number
  /** Oklab chroma multiplier. 1 is untouched. */
  saturationGain: number
  /** White balance in kelvin. 6600 is the identity, lower is warmer. */
  temperature: number
  /**
   * Per-channel exponent in linear light. 1 is off.
   *
   * An ARTISTIC knob whose useful range is about 1.0-1.3, and deliberately not
   * Hyperion's 2.2: the pipeline already averages in linear light, so a 2.2
   * here applies the transfer function a second time and roughly squares the
   * output. If 1.0 looks wrong the answer is the brightness ceiling, not this.
   */
  taper: number
  /** 0..100. Lowest level the strip will show; 0 is off. */
  backlightThreshold: number
  /** Keep the hue when lifting to the floor, rather than snapping to grey. */
  backlightColored: boolean
}

/**
 * Black-border detection: the thing that keeps the strip alive during a film.
 *
 * On a 16:9 panel a 2.39:1 film puts pure black under the top and bottom LEDs,
 * so without this the ambilight dies exactly when somebody is watching a film -
 * which is the single most common reason to own one. The detector finds the
 * bars and insets every sampling rectangle past them.
 *
 * The mode is exposed because the four probe patterns fail in different ways
 * and the right one depends on what is being watched. Hysteresis is left at the
 * engine's defaults, which are already in MILLISECONDS rather than frames -
 * Hyperion counts frames, so its 50-frame switch is five seconds at its 10 fps
 * and under half a second at ours, twelve times twitchier.
 */
export interface BorderConfig {
  enabled: boolean
  mode: BorderMode
  /**
   * Darkness below which a channel counts as black, as a fraction. A pixel is
   * black only when ALL THREE channels are under it, so a deep blue bar is
   * still a bar.
   */
  threshold: number
  /**
   * Extra grid pixels trimmed off every non-zero border, to step past the soft
   * edge a scaler leaves between the bar and the picture.
   */
  blurRemovePx: number
}

/**
 * How a region of the picture becomes one LED colour.
 *
 * `lib/engine/sample.ts` has carried Hyperion's seven reductions, its pixel
 * decimation and its k-means accuracy level since it was written, and the
 * engine called it with a hardcoded `'mean'` and no options - so six of the
 * seven were unreachable. This block is what reaches them.
 *
 * Every default here reproduces exactly what the engine did before the block
 * existed, so a rig that never opens this page sees no change.
 */
export interface SamplingConfig {
  /**
   * Which reduction. `mean` is the one to use and the default: on LINEAR input
   * it is the area average, the colour a diffuser held over that region would
   * give. The others are Hyperion parity - `meanSquared` is an approximation of
   * `mean` from the wrong side and does nothing useful here - except the
   * dominant modes, which are a real choice: they return the region's most
   * common colour rather than its average, so a mostly-dark frame with one
   * bright object follows the object instead of washing to grey.
   */
  mode: SampleMode
  /**
   * 0..3: read every 1st, 2nd, 3rd or 4th pixel of each region along both axes
   * - Hyperion's `reducedPixelSetFactorFactor`. The plan calls this class of
   * knob the difference between hardware that keeps up and hardware that does
   * not, and the downscale is our measured bottleneck, so it is worth reaching.
   */
  reducedPixelSetFactor: number
  /**
   * 0..4: `dominantAdvanced` clusters each region into `accuracyLevel + 1`
   * groups.
   *
   * Kept even while a mode that ignores it is selected, unlike the calibration
   * bytes and the host dither, which are REFUSED where they would do nothing.
   * The difference is what the value is: those two are payload that the chosen
   * frame format has no room for, while this is a preference the user returns
   * to the moment they pick a dominant mode again. Dropping it would lose a
   * setting rather than prevent a lie.
   */
  accuracyLevel: number
}

/**
 * The two layers that are not started by a person.
 *
 * The priority muxer has reserved a background slot since it was written -
 * `BACKGROUND_PRIORITY`, deliberately spared by `clearAll()` and ignored by the
 * idle check - and nothing has ever registered a source there. The mechanism
 * was complete and unreachable, which is the third time this has happened in
 * this engine.
 *
 * What it is for is one sentence from the gap analysis, and it is a thing
 * people actually ask for: **"leave warm white behind it when the screen goes
 * dark."** A capture that ends leaves the strip black today; a background makes
 * it fall back to something instead.
 *
 * `startup` is the other half - Hyperion calls it `foregroundEffect`, which is
 * a confusing name for a boot animation. It runs ABOVE everything (priority 1)
 * for a fixed time and then lets go, so the strip says "this is on" before
 * anyone has picked a screen.
 *
 * Both are OFF by default. They change what an existing installation does the
 * moment they are on, and nobody asked for that on an update.
 */
export interface LayerConfig {
  enabled: boolean
  /** A flat colour, or one of the built-in effects. */
  kind: 'color' | 'effect'
  /** sRGB 0..255, as a person picks it. Used when `kind` is 'color'. */
  color: { r: number, g: number, b: number }
  /** Used when `kind` is 'effect'. */
  effect: EffectKind
}

export interface StartupConfig extends LayerConfig {
  /** How long it holds the strip before letting go. */
  durationMs: number
}

export const LAYER_KINDS: readonly LayerConfig['kind'][] = Object.freeze(['color', 'effect'])

export interface EngineConfig {
  layout: LayoutConfig
  /** LEDs that are wired but must never light. */
  blacklist: BlacklistRange[]
  colorOrder: ColorOrderConfig
  output: OutputConfig
  capture: CaptureConfig
  smoothing: SmoothingConfig
  color: ColorConfig
  border: BorderConfig
  /** How a region becomes one LED colour. */
  sampling: SamplingConfig
  /** What the strip falls back to when nothing else is showing. */
  background: LayerConfig
  /** What it shows for a moment when the engine starts. */
  startup: StartupConfig
}

export const DEFAULT_OUTPUT: Readonly<OutputConfig> = Object.freeze({
  transport: 'serial' as OutputTransport,
  format: 'Afx' as WireFormat
})

/**
 * Changing the transport changes which of the other output settings mean
 * anything, and the validator REFUSES a setting that would do nothing - a host
 * on serial, a segment on anything but WLED, a wire format on WLED. Dropping
 * them here rather than carrying them keeps the switch from producing a config
 * the user cannot apply and did not ask for.
 *
 * `host` is carried between the two network transports on purpose: someone
 * comparing our firmware against a WLED on the same board should not have to
 * retype the address.
 */
export function switchTransport (output: OutputConfig, transport: OutputTransport): OutputConfig {
  const carried = {
    ...(output.calibration !== undefined ? { calibration: output.calibration } : {}),
    ...(output.dither === true ? { dither: true } : {})
  }
  if (transport === 'serial') {
    return { transport, format: output.format, ...carried }
  }
  const host = output.host ?? ''
  if (transport === 'wled') {
    // WLED has its own protocol: the format is meaningless, the calibration
    // bytes belong to an Awa frame that will never be sent, and the dither
    // works on a payload this transport does not produce.
    return { transport, host, segment: output.segment ?? 0, wledGamma: output.wledGamma ?? WLED_DEFAULT_GAMMA, format: 'Afx' }
  }
  return { transport, host, format: output.format, ...carried }
}

export const DEFAULT_CAPTURE: Readonly<CaptureConfig> = Object.freeze({
  source: 'screen' as CaptureSource,
  gridWidth: 128,
  gridHeight: 72,
  fps: 60,
  crop: Object.freeze({ left: 0, right: 0, top: 0, bottom: 0 })
})

export const DEFAULT_SMOOTHING: Readonly<SmoothingConfig> = Object.freeze({ ...SMOOTHING_PROFILES.balanced })

/** Every knob at its identity: exactly what the strip did before they existed. */
export const DEFAULT_COLOR: Readonly<ColorConfig> = Object.freeze({
  brightness: ADJUSTMENT_DEFAULTS.brightness,
  saturationGain: ADJUSTMENT_DEFAULTS.saturationGain,
  temperature: ADJUSTMENT_DEFAULTS.temperature,
  taper: ADJUSTMENT_DEFAULTS.taper,
  backlightThreshold: ADJUSTMENT_DEFAULTS.backlightThreshold,
  backlightColored: ADJUSTMENT_DEFAULTS.backlightColored
})

/**
 * Saturation ceiling.
 *
 * Well below the engine's `MAX_GAIN`: past about 2 every mid-tone is already
 * clipped to a primary, so the slider would spend most of its travel choosing
 * between shades of "fully saturated".
 */
export const SATURATION_MAX = 2
/** The taper's useful range. Above this it is a gamma curve masking a brightness problem. */
export const TAPER_MAX = 1.6

export const DEFAULT_BORDER: Readonly<BorderConfig> = Object.freeze({
  enabled: BORDER_DEFAULTS.enabled,
  mode: BORDER_DEFAULTS.mode,
  threshold: BORDER_DEFAULTS.threshold,
  blurRemovePx: BORDER_DEFAULTS.blurRemovePx
})

/** Exactly what the engine did before the sampling block existed. */
export const DEFAULT_SAMPLING: Readonly<SamplingConfig> = Object.freeze({
  mode: 'mean' as SampleMode,
  reducedPixelSetFactor: SAMPLER_DEFAULTS.reducedPixelSetFactor,
  accuracyLevel: SAMPLER_DEFAULTS.accuracyLevel
})

/** 0..3, Hyperion's disabled / low / medium / high. */
export const MAX_PIXEL_SET_FACTOR = 3

/**
 * Threshold ceiling.
 *
 * A "black" bar brighter than a fifth of full scale is not a bar, it is dark
 * content - and a detector that accepted it would crop the picture rather than
 * the bars, which is worse than not detecting anything.
 */
export const BORDER_THRESHOLD_MAX = 0.2
/** Deeper than this and the trim is eating picture rather than a scaler's soft edge. */
export const BLUR_REMOVE_MAX = 8

/**
 * Both off, so an update changes nothing on a strip that is already working.
 *
 * The colour is a warm white rather than Hyperion's orange: the request this
 * exists for is "warm white behind it", and an installation that switches the
 * background on should get the thing it was asked for without also having to
 * find the colour picker.
 */
export const DEFAULT_BACKGROUND: Readonly<LayerConfig> = Object.freeze({
  enabled: false,
  kind: 'color' as LayerConfig['kind'],
  color: Object.freeze({ r: 255, g: 170, b: 100 }),
  effect: 'candle' as EffectKind
})

export const DEFAULT_STARTUP: Readonly<StartupConfig> = Object.freeze({
  ...DEFAULT_BACKGROUND,
  kind: 'effect' as LayerConfig['kind'],
  effect: 'rainbow' as EffectKind,
  durationMs: 3000
})

/** Hyperion's own floor and a ceiling past which a boot animation is a hostage situation. */
export const STARTUP_MS_MIN = 100
export const STARTUP_MS_MAX = 30000

/**
 * Time-constant bounds.
 *
 * The low end is the smallest value the smoother itself accepts: it refuses a
 * constant that is not positive, and a parser floor of 0 let the smoothing
 * card's slider - dragged fully left - produce a configuration the parser
 * blessed and the engine threw on (on the extension host after persisting it).
 * A millisecond is well under one output period at 120 Hz, so the low end is
 * effectively "no smoothing", which the competitive profile's 6 ms already
 * approaches. The high end is where the strip stops following the screen and
 * starts following the last minute of it.
 */
export const SMOOTHING_MS_MIN = 1
export const SMOOTHING_MS_MAX = 2000

/** Grid bounds. The low end is where a 35-LED edge starts sharing cells between LEDs. */
export const GRID_MIN = 16
export const GRID_MAX = 480
export const FPS_MIN = 1
export const FPS_MAX = 240
/** Per side. Two opposite crops must still leave something, which is checked separately. */
export const CROP_MAX = 0.45

/** The reference rig: the 108-LED frame on the 27" panel, wired rgb. */
export const DEFAULT_ENGINE_CONFIG: Readonly<EngineConfig> = Object.freeze({
  layout: Object.freeze({ kind: 'classic', ...REFERENCE_LAYOUT }),
  blacklist: Object.freeze([]) as unknown as BlacklistRange[],
  colorOrder: Object.freeze({ order: DEFAULT_COLOR_ORDER }),
  output: DEFAULT_OUTPUT,
  capture: DEFAULT_CAPTURE,
  smoothing: DEFAULT_SMOOTHING,
  color: DEFAULT_COLOR,
  border: DEFAULT_BORDER,
  sampling: DEFAULT_SAMPLING,
  background: DEFAULT_BACKGROUND,
  startup: DEFAULT_STARTUP
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

/**
 * One of the two automatic layers.
 *
 * Both arms are read whatever `kind` says, so switching a layer from a colour
 * to an effect and back does not lose the colour that was picked - the same
 * reason `switchTransport` carries the host between the two network transports.
 */
function readLayer (value: unknown, path: string, fallback: Readonly<LayerConfig>): LayerConfig {
  const raw = value === undefined ? {} : object(value, `config.${path}`)
  const colorRaw = raw.color === undefined ? undefined : object(raw.color, `${path}.color`)
  const kind = raw.kind === undefined ? fallback.kind : readLayerKind(raw.kind, `${path}.kind`)
  return {
    enabled: raw.enabled === undefined ? fallback.enabled : boolean(raw.enabled, `${path}.enabled`),
    kind,
    color: colorRaw === undefined
      ? { ...fallback.color }
      : {
          r: integer(colorRaw.r, `${path}.color.r`, 0, 255),
          g: integer(colorRaw.g, `${path}.color.g`, 0, 255),
          b: integer(colorRaw.b, `${path}.color.b`, 0, 255)
        },
    // The effects module owns what a valid effect is; asking it here keeps one
    // definition rather than two that drift.
    effect: raw.effect === undefined
      ? fallback.effect
      : parseEffectSpec({ kind: raw.effect }).kind
  }
}

function readLayerKind (value: unknown, path: string): LayerConfig['kind'] {
  if (value !== 'color' && value !== 'effect') {
    throw new ConfigError(path, `must be one of ${LAYER_KINDS.join(', ')}, got ${describe(value)}`)
  }
  return value
}

function readSampleMode (value: unknown, path: string): SampleMode {
  if (typeof value !== 'string' || !SAMPLE_MODES.includes(value as SampleMode)) {
    throw new ConfigError(path, `must be one of ${SAMPLE_MODES.join(', ')}, got ${describe(value)}`)
  }
  return value as SampleMode
}

function readBorderMode (value: unknown, path: string): BorderMode {
  if (typeof value !== 'string' || !BORDER_MODES.includes(value as BorderMode)) {
    throw new ConfigError(path, `must be one of ${BORDER_MODES.join(', ')}, got ${describe(value)}`)
  }
  return value as BorderMode
}

function fraction (value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(path, `must be a finite number, got ${describe(value)}`)
  }
  return value
}

/** A fraction with bounds and a default, for the knobs that may be omitted. */
function boundedFraction (value: unknown, path: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  const n = fraction(value, path)
  if (n < min || n > max) throw new ConfigError(path, `must be in ${min}..${max}, got ${describe(value)}`)
  return n
}

function readTransport (value: unknown, path: string): OutputTransport {
  if (typeof value !== 'string' || !OUTPUT_TRANSPORTS.includes(value as OutputTransport)) {
    throw new ConfigError(path, `must be one of ${OUTPUT_TRANSPORTS.join(', ')}, got ${describe(value)}`)
  }
  return value as OutputTransport
}

function readCaptureSource (value: unknown, path: string): CaptureSource {
  if (typeof value !== 'string' || !CAPTURE_SOURCES.includes(value as CaptureSource)) {
    throw new ConfigError(path, `must be one of ${CAPTURE_SOURCES.join(', ')}, got ${describe(value)}`)
  }
  return value as CaptureSource
}

function readWireFormat (value: unknown, path: string): WireFormat {
  if (typeof value !== 'string' || !WIRE_FORMATS.includes(value as WireFormat)) {
    throw new ConfigError(path, `must be one of ${WIRE_FORMATS.join(', ')}, got ${describe(value)}`)
  }
  return value as WireFormat
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

  const outputRaw = raw.output === undefined ? {} : object(raw.output, 'config.output')
  const format = outputRaw.format === undefined
    ? DEFAULT_OUTPUT.format
    : readWireFormat(outputRaw.format, 'output.format')
  const transport = outputRaw.transport === undefined
    ? DEFAULT_OUTPUT.transport
    : readTransport(outputRaw.transport, 'output.transport')
  const output: OutputConfig = { transport, format }

  if (transport === 'serial') {
    // A host on a serial transport is a setting that does nothing, which is how
    // someone ends up staring at an address they are sure they typed correctly.
    if (outputRaw.host !== undefined) throw new ConfigError('output.host', 'is only used by the network transports')
    if (outputRaw.segment !== undefined) throw new ConfigError('output.segment', 'is only used by WLED')
    if (outputRaw.wledGamma !== undefined) throw new ConfigError('output.wledGamma', 'is only used by WLED')
  } else {
    const host = outputRaw.host
    if (typeof host !== 'string' || host.trim() === '') {
      throw new ConfigError('output.host', `must be a non-empty address for the ${transport} transport, got ${describe(host)}`)
    }
    output.host = host.trim()
    if (transport === 'wled') {
      output.segment = outputRaw.segment === undefined ? 0 : integer(outputRaw.segment, 'output.segment', 0)
      // The device's setting, copied here: 2.8 on a stock WLED. A wrong value
      // is a strip that is visibly wrong with nothing in the panel saying so,
      // which is why it is a setting beside the address and not a constant.
      output.wledGamma = boundedFraction(outputRaw.wledGamma, 'output.wledGamma', WLED_GAMMA_MIN, WLED_GAMMA_MAX, WLED_DEFAULT_GAMMA)
    } else {
      if (outputRaw.segment !== undefined) throw new ConfigError('output.segment', 'is only used by WLED')
      if (outputRaw.wledGamma !== undefined) throw new ConfigError('output.wledGamma', 'is only used by WLED')
    }
  }

  // WLED speaks its own JSON and never sees one of our wire formats. Letting the
  // two be set independently would put a format in the panel that the device
  // cannot receive, which reads as a setting that is quietly ignored.
  if (transport === 'wled' && outputRaw.format !== undefined && outputRaw.format !== 'Afx') {
    throw new ConfigError('output.format', 'is not used by WLED, which has its own JSON protocol')
  }
  if (outputRaw.calibration !== undefined) {
    if (format !== 'Awa') {
      // Silently dropping it would leave someone staring at a white balance
      // that does nothing, which is worse than being told.
      throw new ConfigError('output.calibration', `is only carried by the Awa format, not ${format}`)
    }
    const cal = object(outputRaw.calibration, 'output.calibration')
    output.calibration = {
      // Named as the protocol names them rather than as the UI might: one
      // vocabulary for the four bytes, so nothing has to translate between two.
      limit: integer(cal.limit, 'output.calibration.limit', 0, 255),
      red: integer(cal.red, 'output.calibration.red', 0, 255),
      green: integer(cal.green, 'output.calibration.green', 0, 255),
      blue: integer(cal.blue, 'output.calibration.blue', 0, 255)
    }
  }
  if (outputRaw.dither !== undefined) {
    if (typeof outputRaw.dither !== 'boolean') {
      throw new ConfigError('output.dither', `must be true or false, got ${describe(outputRaw.dither)}`)
    }
    // Only ASKING for it is refused, and only where it would do nothing: on Afx
    // the firmware is already dithering and a second diffuser over the same LSB
    // is noise, on WLED our payload is never built at all. An explicit `false`
    // is the default said out loud, so it carries anywhere.
    if (outputRaw.dither) {
      if (transport === 'wled') {
        throw new ConfigError('output.dither', 'is not used by WLED, which has its own JSON protocol')
      }
      if (format === 'Afx') {
        throw new ConfigError('output.dither', 'is not used by Afx, which the firmware dithers itself')
      }
      output.dither = true
    }
  }

  const captureRaw = raw.capture === undefined ? {} : object(raw.capture, 'config.capture')
  const cropRaw = captureRaw.crop === undefined ? {} : object(captureRaw.crop, 'config.capture.crop')
  const crop = {
    left: boundedFraction(cropRaw.left, 'capture.crop.left', 0, CROP_MAX, DEFAULT_CAPTURE.crop.left),
    right: boundedFraction(cropRaw.right, 'capture.crop.right', 0, CROP_MAX, DEFAULT_CAPTURE.crop.right),
    top: boundedFraction(cropRaw.top, 'capture.crop.top', 0, CROP_MAX, DEFAULT_CAPTURE.crop.top),
    bottom: boundedFraction(cropRaw.bottom, 'capture.crop.bottom', 0, CROP_MAX, DEFAULT_CAPTURE.crop.bottom)
  }
  // Each side is capped at 0.45, but 0.45 + 0.45 leaves a tenth of the screen
  // and 0.5 + 0.5 leaves nothing at all. The pair is what has to be checked.
  if (crop.left + crop.right > 0.9) {
    throw new ConfigError('capture.crop', `left and right crop leave ${(1 - crop.left - crop.right).toFixed(2)} of the width`)
  }
  if (crop.top + crop.bottom > 0.9) {
    throw new ConfigError('capture.crop', `top and bottom crop leave ${(1 - crop.top - crop.bottom).toFixed(2)} of the height`)
  }
  const source = captureRaw.source === undefined
    ? 'screen'
    : readCaptureSource(captureRaw.source, 'capture.source')
  if (source === 'screen' && captureRaw.deviceId !== undefined) {
    // Refused rather than ignored: a stored device id on a screen capture means
    // the two halves of the configuration disagree about what is being read,
    // and silently keeping one is how that survives into a bug report.
    throw new ConfigError('capture.deviceId', 'is only used when the source is a video input')
  }
  const capture: CaptureConfig = {
    source,
    gridWidth: integer(captureRaw.gridWidth ?? DEFAULT_CAPTURE.gridWidth, 'capture.gridWidth', GRID_MIN, GRID_MAX),
    gridHeight: integer(captureRaw.gridHeight ?? DEFAULT_CAPTURE.gridHeight, 'capture.gridHeight', GRID_MIN, GRID_MAX),
    fps: integer(captureRaw.fps ?? DEFAULT_CAPTURE.fps, 'capture.fps', FPS_MIN, FPS_MAX),
    crop
  }
  if (source === 'device' && captureRaw.deviceId !== undefined) {
    if (typeof captureRaw.deviceId !== 'string' || captureRaw.deviceId === '') {
      throw new ConfigError('capture.deviceId', `must be a non-empty string, got ${describe(captureRaw.deviceId)}`)
    }
    capture.deviceId = captureRaw.deviceId
  }

  const smoothingRaw = raw.smoothing === undefined ? {} : object(raw.smoothing, 'config.smoothing')
  const smoothing: SmoothingConfig = {
    attackMs: boundedFraction(smoothingRaw.attackMs, 'smoothing.attackMs', SMOOTHING_MS_MIN, SMOOTHING_MS_MAX, DEFAULT_SMOOTHING.attackMs),
    releaseMs: boundedFraction(smoothingRaw.releaseMs, 'smoothing.releaseMs', SMOOTHING_MS_MIN, SMOOTHING_MS_MAX, DEFAULT_SMOOTHING.releaseMs),
    cutThreshold: boundedFraction(smoothingRaw.cutThreshold, 'smoothing.cutThreshold', 0, 1, DEFAULT_SMOOTHING.cutThreshold)
  }

  const colorRaw = raw.color === undefined ? {} : object(raw.color, 'config.color')
  const color: ColorConfig = {
    brightness: boundedFraction(colorRaw.brightness, 'color.brightness', 0, 100, DEFAULT_COLOR.brightness),
    saturationGain: boundedFraction(colorRaw.saturationGain, 'color.saturationGain', 0, SATURATION_MAX, DEFAULT_COLOR.saturationGain),
    temperature: boundedFraction(colorRaw.temperature, 'color.temperature', TEMPERATURE_MIN, TEMPERATURE_MAX, DEFAULT_COLOR.temperature),
    taper: boundedFraction(colorRaw.taper, 'color.taper', 1, TAPER_MAX, DEFAULT_COLOR.taper),
    backlightThreshold: boundedFraction(colorRaw.backlightThreshold, 'color.backlightThreshold', 0, 100, DEFAULT_COLOR.backlightThreshold),
    backlightColored: colorRaw.backlightColored === undefined
      ? DEFAULT_COLOR.backlightColored
      : boolean(colorRaw.backlightColored, 'color.backlightColored')
  }

  const borderRaw = raw.border === undefined ? {} : object(raw.border, 'config.border')
  const border: BorderConfig = {
    enabled: borderRaw.enabled === undefined ? DEFAULT_BORDER.enabled : boolean(borderRaw.enabled, 'border.enabled'),
    mode: borderRaw.mode === undefined ? DEFAULT_BORDER.mode : readBorderMode(borderRaw.mode, 'border.mode'),
    threshold: boundedFraction(borderRaw.threshold, 'border.threshold', 0, BORDER_THRESHOLD_MAX, DEFAULT_BORDER.threshold),
    blurRemovePx: integer(borderRaw.blurRemovePx ?? DEFAULT_BORDER.blurRemovePx, 'border.blurRemovePx', 0, BLUR_REMOVE_MAX)
  }

  // Absent means the defaults, which are exactly the old hardcoded behaviour -
  // a config stored before this block existed must still load unchanged.
  const samplingRaw = raw.sampling === undefined ? {} : object(raw.sampling, 'config.sampling')
  const sampling: SamplingConfig = {
    mode: samplingRaw.mode === undefined ? DEFAULT_SAMPLING.mode : readSampleMode(samplingRaw.mode, 'sampling.mode'),
    reducedPixelSetFactor: integer(
      samplingRaw.reducedPixelSetFactor ?? DEFAULT_SAMPLING.reducedPixelSetFactor,
      'sampling.reducedPixelSetFactor', 0, MAX_PIXEL_SET_FACTOR
    ),
    accuracyLevel: integer(
      samplingRaw.accuracyLevel ?? DEFAULT_SAMPLING.accuracyLevel,
      'sampling.accuracyLevel', 0, MAX_ACCURACY_LEVEL
    )
  }

  const background = readLayer(raw.background, 'background', DEFAULT_BACKGROUND)
  const startupBase = readLayer(raw.startup, 'startup', DEFAULT_STARTUP)
  const startupRaw = raw.startup === undefined ? {} : object(raw.startup, 'config.startup')
  const startup: StartupConfig = {
    ...startupBase,
    durationMs: integer(
      startupRaw.durationMs ?? DEFAULT_STARTUP.durationMs,
      'startup.durationMs', STARTUP_MS_MIN, STARTUP_MS_MAX
    )
  }

  const config: EngineConfig = {
    layout, blacklist, colorOrder, output, capture, smoothing, color, border, sampling, background, startup
  }

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
  colorOrder: Object.freeze({ order: DEFAULT_COLOR_ORDER }),
  output: DEFAULT_OUTPUT,
  capture: DEFAULT_CAPTURE,
  smoothing: DEFAULT_SMOOTHING,
  color: DEFAULT_COLOR,
  border: DEFAULT_BORDER,
  sampling: DEFAULT_SAMPLING,
  background: DEFAULT_BACKGROUND,
  startup: DEFAULT_STARTUP
})
