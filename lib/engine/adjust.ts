import type { LedColors, LinearRgb } from '#lib/engine/types'
import { clamp01, srgbToLinear } from '#lib/light'

/**
 * Colour correction: the per-LED calibration chain, in linear light.
 *
 * Port of `MultiColorAdjustment::applyAdjustment` (MultiColorAdjustment.cpp:
 * 97-164) together with the parts of RgbTransform.cpp and
 * RgbChannelAdjustment.cpp it calls, in the same eight-stage order:
 *
 *   1. saturation / brightness gain      (Hyperion: Okhsv; here Oklab LCh)
 *   2. per-channel power curve            (Hyperion: "gamma" LUT; here `taper`)
 *   3. three brightness scalars           (rgb, cmy, white)
 *   4. eight-corner trilinear weights
 *   5. weight * scalar * calibrated corner colour
 *   6. sum of the eight contributions     (clamped here, wrapping there)
 *   7. colour temperature multiplier      (Tanner Helland's fit)
 *   8. backlight floor
 *
 * The order is Hyperion's. What is not Hyperion's is the number line: this
 * chain runs on linear floats 0..1 (lib/engine/types.ts), and several stages
 * change meaning once the input is linear light rather than sRGB bytes. Each
 * such change is a deliberate deviation, marked at the stage below and pinned
 * by a test in test/engine-adjust.test.ts that fails on the Hyperion
 * behaviour. Four of the ten defects in docs/hyperion-port-plan.md section 11
 * live in this chain - #3 unclamped byte sum, #4 truncating casts, #8 the
 * compensation default, #9 the range parser - and none is replicated.
 *
 * Nothing here knows about time; the chain is a pure function of one frame.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The eight corners of the RGB cube, in the order `cornerWeights` returns them. */
export const CUBE_CORNERS = Object.freeze(
  ['black', 'red', 'green', 'blue', 'cyan', 'magenta', 'yellow', 'white'] as const
)
export type CubeCorner = (typeof CUBE_CORNERS)[number]

/** The uncalibrated corners: each maps to itself, so the stage is the identity. */
export const IDENTITY_CORNERS: Readonly<Record<CubeCorner, Readonly<LinearRgb>>> = Object.freeze({
  black: Object.freeze({ r: 0, g: 0, b: 0 }),
  red: Object.freeze({ r: 1, g: 0, b: 0 }),
  green: Object.freeze({ r: 0, g: 1, b: 0 }),
  blue: Object.freeze({ r: 0, g: 0, b: 1 }),
  cyan: Object.freeze({ r: 0, g: 1, b: 1 }),
  magenta: Object.freeze({ r: 1, g: 0, b: 1 }),
  yellow: Object.freeze({ r: 1, g: 1, b: 0 }),
  white: Object.freeze({ r: 1, g: 1, b: 1 })
})

/**
 * One calibration profile and the LEDs it applies to. Every value is optional
 * and defaults to "off" (`ADJUSTMENT_DEFAULTS`), so `{ leds: '*' }` is a no-op.
 *
 * Corner colours are the user's measured LINEAR colour for that corner of the
 * cube: "when I ask this strip for pure red I want (1, 0.1, 0)". A channel
 * above 1 is allowed and means "drive it harder than the input asks" - it
 * saturates at full scale; see stage 6.
 */
export interface AdjustmentProfile extends Partial<Record<CubeCorner, LinearRgb>> {
  /** `'*'` for every LED, or a list like `'0-24, 30, 40-50'` (inclusive ranges). */
  leds: string
  /** Oklab chroma multiplier. 1 = untouched. */
  saturationGain?: number
  /** Oklab lightness multiplier. 1 = untouched. */
  brightnessGain?: number
  /**
   * Per-channel exponent applied in linear light. 1 = off. Artistic knob;
   * useful range 1.0-1.3. NOT Hyperion's 2.2 - see stage 2 before changing it.
   */
  taper?: number
  /** 0..100. Overall brightness, hinged at 50 exactly as Hyperion's is. */
  brightness?: number
  /** 0..100. Extra dimming of the cmy and white corners relative to rgb. */
  brightnessCompensation?: number
  /** Kelvin, clamped to 1000..40000. 6600 is the identity. */
  temperature?: number
  /** 0..100. Minimum output level; 0 = no floor. */
  backlightThreshold?: number
  /** Keep the hue when lifting to the floor, rather than snapping to grey. */
  backlightColored?: boolean
}

/**
 * Hyperion's schema defaults (libsrc/hyperion/schema/schema-color.json), not
 * its C++ fallbacks. The two disagree in two places and the schema is what a
 * saved config actually carries: `brightnessCompensation` is 0 in the schema
 * and 100 in `utils/hyperion.h:77` (plan defect #8; 100 would dim every white
 * to a third), and gamma is 2.2 in the schema, which is precisely the value
 * stage 2 must not inherit.
 */
export const ADJUSTMENT_DEFAULTS = Object.freeze({
  saturationGain: 1,
  brightnessGain: 1,
  taper: 1,
  brightness: 100,
  brightnessCompensation: 0,
  temperature: 6600,
  backlightThreshold: 0,
  backlightColored: false
})

export interface Adjustment {
  /** LEDs the table was built for. A frame of another size is adjusted on the overlap. */
  readonly count: number
  /** LEDs no profile selected. They pass through untouched; the UI may want to say so. */
  readonly unassigned: readonly number[]
  /** Runs the chain on every LED that has a profile, in place, and returns `colors`. */
  apply (colors: LedColors): LedColors
  /**
   * Not a user setting. The caller turns the floor off while a solid colour or
   * an effect is showing so that "make the LEDs black" is black
   * (Hyperion.cpp:655-664), and on again for captured video. Default on.
   */
  setBacklightEnabled (enabled: boolean): void
  backlightEnabled (): boolean
}

// ---------------------------------------------------------------------------
// Stage 1 - saturation and brightness gain, in Oklab
// ---------------------------------------------------------------------------

/**
 * Hyperion does this in Okhsv (OkhsvTransform.cpp:53-64): decode sRGB, scale
 * s and v, encode. We are already in linear sRGB, and Oklab is DEFINED from
 * linear sRGB, so the decode step vanishes and the gains can be applied where
 * they are meaningful: chroma and lightness in Oklab's LCh form. Deliberate
 * deviation - Okhsv's s and v are gamut-relative quantities and its 1.0 clamp
 * is a gamut boundary; Oklab C and L are absolute, so a lightness gain above
 * 1 can push a channel past full scale and is clamped per channel instead.
 * For gains below 1, which is what the knobs are for, the two agree in spirit.
 *
 * Matrices from Bjorn Ottosson, "A perceptual color space for image
 * processing" (https://bottosson.github.io/posts/oklab/, 2020): M1 takes
 * linear sRGB to cone response (LMS), M2 takes cube-rooted LMS to Lab. The
 * inverses are his published ones (ok_color.h:85-100 carries the same digits).
 */
export interface Oklab {
  L: number
  a: number
  b: number
}

function linearToOklabInto (r: number, g: number, b: number, out: Float64Array): void {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  out[0] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
  out[1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
}

function oklabToLinearInto (L: number, a: number, b: number, out: Float64Array): void {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
}

/** Linear sRGB -> Oklab. Boundary form; the chain uses the array form above. */
export function linearToOklab (c: LinearRgb): Oklab {
  const out = new Float64Array(3)
  linearToOklabInto(c.r, c.g, c.b, out)
  return { L: out[0] ?? 0, a: out[1] ?? 0, b: out[2] ?? 0 }
}

/** Oklab -> linear sRGB. Unclamped: a colour outside the gamut comes back outside 0..1. */
export function oklabToLinear (c: Oklab): LinearRgb {
  const out = new Float64Array(3)
  oklabToLinearInto(c.L, c.a, c.b, out)
  return { r: out[0] ?? 0, g: out[1] ?? 0, b: out[2] ?? 0 }
}

/**
 * Scales chroma by `saturationGain` and lightness by `brightnessGain`, writing
 * the result to `out`. Chroma is `hypot(a, b)`, so scaling a and b together
 * scales C and keeps the hue - no polar conversion needed.
 *
 * Clamped on the way out. ColorSys.cpp:80 records the reason for the Okhsv
 * version - "okhsv_to_srgb can output rgb colors with slightly negative
 * components" - and the same holds for any Oklab inverse near the gamut edge.
 */
export function oklabGain (
  r: number, g: number, b: number,
  saturationGain: number, brightnessGain: number,
  out: Float64Array
): void {
  linearToOklabInto(r, g, b, out)
  const L = (out[0] ?? 0) * brightnessGain
  const a = (out[1] ?? 0) * saturationGain
  const bb = (out[2] ?? 0) * saturationGain
  oklabToLinearInto(L, a, bb, out)
  out[0] = clamp01(out[0] ?? 0)
  out[1] = clamp01(out[1] ?? 0)
  out[2] = clamp01(out[2] ?? 0)
}

// ---------------------------------------------------------------------------
// Stage 2 - taper
// ---------------------------------------------------------------------------

/*
 * Stage 2 - taper. READ THIS BEFORE SETTING IT TO 2.2.
 *
 * Hyperion's "gamma" (RgbTransform.cpp:55-79) is a 256-entry LUT
 * `255 * (i/255)^gamma`, schema default 2.2, applied to values that are
 * ALREADY sRGB encoded (port plan section 9 proves nothing in its LED path is
 * ever linearised). It is not a decode - it is a perceptual darkening knob
 * that happens to wear a decode's number.
 *
 * Here the decode has already happened at capture, so the same exponent on
 * linear values is a second power curve on top of the first: mid-grey
 * (sRGB 128, linear 0.216) becomes 0.034, a sixfold crush. That is also what
 * Hyperion's default does to the light output (its LUT sends byte 128 to 55,
 * which is 0.038 linear), which is exactly why the number must not be
 * carried over: the correct light level of mid-grey is 0.216, and a linear
 * pipeline delivers it with taper 1.0. Deliberate deviation: DEFAULT 1.0.
 *
 * What survives is an artistic "make the dark end darker" knob. Useful values
 * are 1.0-1.3. It is applied per channel with one exponent; Hyperion's three
 * (gammaRed/Green/Blue) are a white-balance hack that the corner calibration
 * and the temperature stage do properly.
 */

// ---------------------------------------------------------------------------
// Stage 3 - brightness scalars
// ---------------------------------------------------------------------------

export interface BrightnessScalars {
  /** Multiplier for the red, green and blue corners. */
  rgb: number
  /** Multiplier for cyan, magenta and yellow. */
  cmy: number
  /** Multiplier for white. */
  w: number
}

/**
 * Port of `RgbTransform::updateBrightnessComponents` (RgbTransform.cpp:
 * 146-164), normalised to 0..1. `B_in` is Hyperion's hand-fitted divisor - two
 * line segments hinged at 50, continuous there (both give 3.0) - and the
 * compensation factors dim the corners that light more emitters, so a white
 * does not draw three times the current of a red at the same setting.
 *
 * Hyperion `ceil()`s each result to a byte; a float has nothing to ceil.
 * Brightness 0 is all zero, as there.
 */
export function brightnessScalars (brightness: number, compensation: number): BrightnessScalars {
  if (brightness <= 0) return { rgb: 0, cmy: 0, w: 0 }
  const bIn = brightness < 50 ? -0.09 * brightness + 7.5 : -0.04 * brightness + 5.0
  const fCmy = compensation / 100 + 1
  const fW = compensation * 2 / 100 + 1
  return {
    rgb: Math.min(1, 1 / bIn),
    cmy: Math.min(1, 1 / (bIn * fCmy)),
    w: Math.min(1, 1 / (bIn * fW))
  }
}

// ---------------------------------------------------------------------------
// Stage 4 - eight-corner trilinear decomposition
// ---------------------------------------------------------------------------

/**
 * Barycentric weights of `(r, g, b)` over the eight corners of the unit cube,
 * in `CUBE_CORNERS` order. Port of MultiColorAdjustment.cpp:125-137 in float:
 * the eight products sum to exactly 1 by construction, `((1-r)+r)((1-g)+g)
 * ((1-b)+b)` expanded.
 *
 * Hyperion computes each weight as an integer product over 255^2 and casts it
 * to uint8, which truncates rather than rounds (plan defect #4): up to one
 * count lost per weight, eight weights per LED, a systematic darkening of up
 * to 8/255 that a float never sees.
 *
 * This is the whole calibration model in one line: the user's eight corner
 * colours are a 3-D colour LUT with only its corners exposed, and every
 * intermediate colour follows them trilinearly.
 */
export function cornerWeights (r: number, g: number, b: number, out = new Float64Array(8)): Float64Array {
  const nr = 1 - r
  const ng = 1 - g
  const nb = 1 - b
  out[0] = nr * ng * nb // black
  out[1] = r * ng * nb // red
  out[2] = nr * g * nb // green
  out[3] = nr * ng * b // blue
  out[4] = nr * g * b // cyan
  out[5] = r * ng * b // magenta
  out[6] = r * g * nb // yellow
  out[7] = r * g * b // white
  return out
}

// ---------------------------------------------------------------------------
// Stage 7 - colour temperature
// ---------------------------------------------------------------------------

/** Encoded (gamma-space) sRGB triple, 0..1. Not light; see `kelvinToLinearRgb`. */
export interface EncodedRgb {
  r: number
  g: number
  b: number
}

export const TEMPERATURE_MIN = 1000
export const TEMPERATURE_MAX = 40000
export const TEMPERATURE_DEFAULT = 6600

/**
 * Tanner Helland's black-body fit, as ported in KelvinToRgb.h:16-73: three
 * curve pieces per channel in "temperature / 100" units, clamped to
 * 1000..40000 K, all channels at full scale at 6600 K. Returned normalised
 * to 0..1 but otherwise as Helland defined it - which is a set of sRGB
 * ENCODED byte values, because the fit was made against rendered colour
 * swatches, not against light.
 *
 * Two byte artefacts of the port are dropped: Hyperion divides the Kelvin
 * value by 100 as an integer (so 6699 K is 6600 K) and truncates each channel
 * to an int; this takes the Kelvin value as given. One property of the fit
 * itself is kept, because it is the fit: its pieces do not quite meet at 66,
 * so green dips about 1% encoded just above 6600 K and blue just below.
 * Hyperion's integer division moves that seam, it does not remove it.
 */
export function kelvinToSrgb (kelvin: number): EncodedRgb {
  if (!Number.isFinite(kelvin)) throw new RangeError(`adjust: temperature must be a finite Kelvin value, got ${kelvin}`)
  const t = Math.min(TEMPERATURE_MAX, Math.max(TEMPERATURE_MIN, kelvin)) / 100

  const red = t <= 66
    ? 255
    : 329.698727446 * Math.pow(t - 60, -0.1332047592)
  const green = t <= 66
    ? 99.4708025861 * Math.log(t) - 161.1195681661
    : 288.1221695283 * Math.pow(t - 60, -0.0755148492)
  const blue = t >= 66
    ? 255
    : t <= 19
      ? 0
      : 138.5177312231 * Math.log(t - 10) - 305.0447927307

  return { r: clamp01(red / 255), g: clamp01(green / 255), b: clamp01(blue / 255) }
}

/**
 * The per-channel multiplier the chain actually uses.
 *
 * Hyperion multiplies its sRGB bytes by Helland's sRGB bytes
 * (RgbTransform.cpp:212-217) - both encoded, so the tint is at least
 * self-consistent. Our channels are linear, and multiplying linear light by
 * an ENCODED ratio would be wrong by the whole transfer curve: at 3000 K
 * Helland's blue is 0.43 encoded, which is 0.15 in light, so the naive
 * multiply would leave blue nearly three times too strong and the "warm"
 * setting would barely warm. Deliberate deviation: decode the triple first.
 */
export function kelvinToLinearRgb (kelvin: number): LinearRgb {
  const m = kelvinToSrgb(kelvin)
  return { r: srgbToLinear(m.r), g: srgbToLinear(m.g), b: srgbToLinear(m.b) }
}

// ---------------------------------------------------------------------------
// Stage 8 - backlight floor
// ---------------------------------------------------------------------------

/**
 * Minimum output level, linear, for a threshold of 0..100.
 *
 * The curve is Hyperion's (RgbTransform.cpp:87-102): `shaped = (2^(2t)-1)/3`
 * with k = 2, chosen there for "full dynamic use of 0..100", so the slider is
 * fine at the dark end where a floor is actually chosen; 50 gives a third of
 * full scale, byte 85. That byte is a floor in Hyperion's sRGB-encoded world,
 * so its light level is `srgbToLinear(85/255)` - which is what a user who
 * tuned "50" on Hyperion expects to see, and what a linear floor of 1/3 (three
 * times brighter) would not be. Hyperion's truncation of the byte is dropped.
 */
export function backlightFloor (threshold: number): number {
  const t = Math.min(100, Math.max(0, threshold)) / 100
  const shaped = (Math.pow(2, 2 * t) - 1) / 3
  return srgbToLinear(shaped)
}

// ---------------------------------------------------------------------------
// LED selector
// ---------------------------------------------------------------------------

/**
 * Parses Hyperion's `leds` selector: `'*'`, or a comma list of indices and
 * inclusive ranges such as `'0-24, 30, 40-50'`. Returns the LED indices in
 * order of first mention, without duplicates.
 *
 * Stricter than the original on purpose. Hyperion's regexp
 * (utils/hyperion.h:131) is unanchored, so any string with a digit in it
 * passes; a descending range is logged and skipped; an end past the strip is
 * clamped with a warning. All three throw here, because a calibration that
 * silently lands on the wrong LEDs is worse than one that refuses to load.
 *
 * And the single-index branch reads its own token. Hyperion's reads
 * `ledIndexList[i]` where `i` is the PROFILE index, not the token index `j`
 * (utils/hyperion.h:172, plan defect #9): with the second profile set to
 * `'7'` it looks up token 1 of a one-token list, and with a first profile of
 * `'3, 5'` LED 5 is never assigned because token 0 is read twice.
 */
export function parseLedSelector (selector: string, count: number): number[] {
  const text = selector.trim()
  if (text === '*') return Array.from({ length: count }, (_, i) => i)

  const picked = new Set<number>()
  for (const token of text.split(',')) {
    const item = token.trim()
    const match = /^(\d+)(?:-(\d+))?$/.exec(item)
    if (match === null) throw new SyntaxError(`adjust: bad LED selector "${item}" in "${selector}"`)
    const start = Number(match[1])
    const end = match[2] === undefined ? start : Number(match[2])
    if (start > end) throw new RangeError(`adjust: descending LED range "${item}"`)
    if (end >= count) throw new RangeError(`adjust: LED ${end} is outside the strip of ${count}`)
    for (let i = start; i <= end; i++) picked.add(i)
  }
  return [...picked]
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/**
 * Scratch for the two stages that hand back more than one number. Module
 * level so a frame allocates nothing; JavaScript is single-threaded and the
 * chain never re-enters, so sharing is safe.
 */
const LAB_SCRATCH = new Float64Array(3)
const WEIGHT_SCRATCH = new Float64Array(8)

/**
 * A profile with everything that does not depend on the input colour done
 * once: the scalars folded into the corner colours, the temperature decoded
 * to linear, the floor decoded to linear, and an "is this stage the identity"
 * flag per stage so the default profile costs nothing per LED beyond the
 * checks. Hyperion keeps the same kind of skip for its Okhsv stage only
 * (MultiColorAdjustment.cpp:117).
 */
class CompiledProfile {
  private readonly saturationGain: number
  private readonly brightnessGain: number
  private readonly gainIsIdentity: boolean
  private readonly taper: number
  private readonly taperIsIdentity: boolean
  /** Eight corner colours in `CUBE_CORNERS` order, each premultiplied by its scalar. */
  private readonly corners = new Float64Array(24)
  private readonly cornersAreIdentity: boolean
  private readonly tempR: number
  private readonly tempG: number
  private readonly tempB: number
  private readonly tempIsIdentity: boolean
  private readonly floor: number
  private readonly backlightColored: boolean

  constructor (profile: AdjustmentProfile) {
    const d = ADJUSTMENT_DEFAULTS
    this.saturationGain = finite('saturationGain', profile.saturationGain ?? d.saturationGain, 0)
    this.brightnessGain = finite('brightnessGain', profile.brightnessGain ?? d.brightnessGain, 0)
    this.gainIsIdentity = this.saturationGain === 1 && this.brightnessGain === 1

    this.taper = finite('taper', profile.taper ?? d.taper, 0)
    if (this.taper === 0) throw new RangeError('adjust: taper must be positive; 0 would send every colour to full scale')
    this.taperIsIdentity = this.taper === 1

    const brightness = finite('brightness', profile.brightness ?? d.brightness, 0, 100)
    const compensation = finite('brightnessCompensation', profile.brightnessCompensation ?? d.brightnessCompensation, 0, 100)
    const scalars = brightnessScalars(brightness, compensation)

    // Stage 5's scalar per corner. Black is always 1: the black floor is the
    // user's "this is what off looks like" and dimming it would move the
    // floor with the brightness slider (MultiColorAdjustment.cpp:148 passes
    // UINT8_MAX for black where every other corner gets its component).
    const scalarFor: Record<CubeCorner, number> = {
      black: 1,
      red: scalars.rgb,
      green: scalars.rgb,
      blue: scalars.rgb,
      cyan: scalars.cmy,
      magenta: scalars.cmy,
      yellow: scalars.cmy,
      white: scalars.w
    }
    let identity = true
    CUBE_CORNERS.forEach((name, k) => {
      const colour = profile[name] ?? IDENTITY_CORNERS[name]
      const ident = IDENTITY_CORNERS[name]
      const scale = scalarFor[name]
      const r = finite(`${name}.r`, colour.r, 0)
      const g = finite(`${name}.g`, colour.g, 0)
      const b = finite(`${name}.b`, colour.b, 0)
      if (scale !== 1 || r !== ident.r || g !== ident.g || b !== ident.b) identity = false
      this.corners[k * 3] = r * scale
      this.corners[k * 3 + 1] = g * scale
      this.corners[k * 3 + 2] = b * scale
    })
    this.cornersAreIdentity = identity

    const temperature = kelvinToLinearRgb(profile.temperature ?? d.temperature)
    this.tempR = temperature.r
    this.tempG = temperature.g
    this.tempB = temperature.b
    this.tempIsIdentity = this.tempR === 1 && this.tempG === 1 && this.tempB === 1

    const threshold = finite('backlightThreshold', profile.backlightThreshold ?? d.backlightThreshold, 0, 100)
    this.floor = backlightFloor(threshold)
    this.backlightColored = profile.backlightColored ?? d.backlightColored
  }

  /** Runs the eight stages on the triple at `colors[i..i+2]`, in place. */
  adjust (colors: LedColors, i: number, backlightEnabled: boolean): void {
    let r = colors[i] ?? 0
    let g = colors[i + 1] ?? 0
    let b = colors[i + 2] ?? 0

    // 1. Gains in Oklab. Skipped at the defaults, exactly as Hyperion skips
    //    its Okhsv stage, so the default profile does not pay a round trip.
    if (!this.gainIsIdentity) {
      oklabGain(r, g, b, this.saturationGain, this.brightnessGain, LAB_SCRATCH)
      r = LAB_SCRATCH[0] ?? 0
      g = LAB_SCRATCH[1] ?? 0
      b = LAB_SCRATCH[2] ?? 0
    }

    // 2. Taper - see the stage 2 comment above for why this is 1.0 and not 2.2.
    if (!this.taperIsIdentity) {
      r = Math.pow(r, this.taper)
      g = Math.pow(g, this.taper)
      b = Math.pow(b, this.taper)
    }

    // 3-6. Decompose onto the eight corners, weight each calibrated corner
    //      (already carrying its brightness scalar) and sum. The sum is CLAMPED.
    //      Hyperion adds its eight byte contributions into a uint8 with no
    //      clamp (MultiColorAdjustment.cpp:157-159, plan defect #3); with byte
    //      corners the sum happens to stay in range only because no corner
    //      can exceed full scale, so the missing clamp is a wrap waiting for
    //      the first calibration that does. Ours can - a "hot" corner above 1
    //      is a legitimate way to say a weak channel needs driving harder -
    //      and so the clamp is load-bearing here.
    if (!this.cornersAreIdentity) {
      const w = cornerWeights(r, g, b, WEIGHT_SCRATCH)
      const c = this.corners
      let sr = 0
      let sg = 0
      let sb = 0
      for (let k = 0; k < 8; k++) {
        const wk = w[k] ?? 0
        sr += wk * (c[k * 3] ?? 0)
        sg += wk * (c[k * 3 + 1] ?? 0)
        sb += wk * (c[k * 3 + 2] ?? 0)
      }
      r = clamp01(sr)
      g = clamp01(sg)
      b = clamp01(sb)
    }

    // 7. Temperature, as a LINEAR multiplier (see kelvinToLinearRgb).
    if (!this.tempIsIdentity) {
      r *= this.tempR
      g *= this.tempG
      b *= this.tempB
    }

    // 8. Backlight floor, port of RgbTransform::applyBacklight
    //    (RgbTransform.cpp:181-199). Note the uncoloured branch SETS every
    //    channel to the floor, so a dim pure red below the threshold becomes
    //    grey; that is Hyperion's behaviour and the reason `backlightColored`
    //    exists. A floor of 0 can never trigger and is skipped.
    if (backlightEnabled && this.floor > 0 && r + g + b < 3 * this.floor) {
      const f = this.floor
      if (this.backlightColored) {
        r = Math.max(r, f)
        g = Math.max(g, f)
        b = Math.max(b, f)
      } else {
        r = f
        g = f
        b = f
      }
    }

    colors[i] = r
    colors[i + 1] = g
    colors[i + 2] = b
  }
}

function finite (name: string, value: number, min: number, max = Number.POSITIVE_INFINITY): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`adjust: ${name} must be a number in [${min}, ${max}], got ${value}`)
  }
  return value
}

/**
 * Builds the per-LED table for a strip of `count` LEDs and returns the chain.
 *
 * Profiles are applied in order and a later profile wins where two select the
 * same LED, as in Hyperion's `setAdjustmentForLed` (MultiColorAdjustment.cpp:
 * 31-52). A LED that no profile selects passes through unchanged; Hyperion
 * warns per LED at start-up (MultiColorAdjustment.cpp:54-68) and then skips
 * it per frame (:102-107). The list of those LEDs is exposed as `unassigned`
 * so a UI can do the warning.
 */
export function createAdjustment (profiles: readonly AdjustmentProfile[], count: number): Adjustment {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`adjust: count must be a positive integer, got ${count}`)

  const table: Array<CompiledProfile | null> = new Array<CompiledProfile | null>(count).fill(null)
  for (const profile of profiles) {
    const compiled = new CompiledProfile(profile)
    for (const led of parseLedSelector(profile.leds, count)) table[led] = compiled
  }
  const unassigned: number[] = []
  table.forEach((entry, led) => { if (entry === null) unassigned.push(led) })

  let backlight = true

  return {
    count,
    unassigned: Object.freeze(unassigned),
    apply (colors) {
      // Hyperion iterates the shorter of table and frame
      // (MultiColorAdjustment.cpp:99); a size mismatch is the caller's bug
      // but not a reason to read past either buffer.
      const n = Math.min(count, Math.floor(colors.length / 3))
      for (let led = 0; led < n; led++) {
        const profile = table[led]
        if (profile == null) continue
        profile.adjust(colors, led * 3, backlight)
      }
      return colors
    },
    setBacklightEnabled (enabled) {
      backlight = enabled
    },
    backlightEnabled () {
      return backlight
    }
  }
}
