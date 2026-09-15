import { srgbToLinear } from '#lib/light'
import type { EffectGeometry } from '#lib/engine/effects'
import type { LedColors } from '#lib/engine/types'

/**
 * Sound on the strip.
 *
 * The cheapest feature on the roadmap and the most visible: Web Audio exists in
 * every browser, including iOS Safari, so this is one of the few things that
 * works identically on every platform the application runs on. Hyperion needs a
 * system audio grabber and a platform-specific one at that; a browser is handed
 * an `AnalyserNode` and the rest is arithmetic.
 *
 * Everything here is pure. The microphone, the `AudioContext` and the FFT live
 * in `lib/engine/audio-input.ts`; what this file does is turn a frequency
 * spectrum into LED colours, which is where all the decisions are:
 *
 * - **Bands are logarithmic, not linear.** An FFT gives bins evenly spaced in
 *   frequency, and a spectrum that maps them evenly onto a strip puts all of
 *   the music in the first tenth of it - a kick drum at 60 Hz and a hi-hat at
 *   12 kHz would be four LEDs apart out of a hundred. Hearing is roughly
 *   logarithmic and the bands are too, which is the difference between a
 *   display that dances and one where the left corner twitches.
 * - **The gain follows the material.** Music is mastered anywhere from -20 to
 *   -6 dB and a room's microphone level is anyone's guess. A fixed gain gives
 *   either a strip that never lights or one that is permanently white, so a
 *   peak follower normalises - fast to rise, slow to fall, which is the shape
 *   that keeps a quiet passage visible without pumping on every snare.
 * - **A noise floor, below which nothing lights.** A silent room is not
 *   silence: it is a fan, a hard disk and mains hum. Without a floor the strip
 *   shimmers faintly forever and the user reasonably concludes it is broken.
 */

export const AUDIO_KINDS = ['spectrum', 'level', 'pulse'] as const

export type AudioKind = (typeof AUDIO_KINDS)[number]

export function isAudioKind (value: unknown): value is AudioKind {
  return typeof value === 'string' && (AUDIO_KINDS as readonly string[]).includes(value)
}

export interface AudioSpec {
  kind: AudioKind
  /** Manual gain on top of the automatic follower, 0.1..10. */
  gain?: number
  /** A ceiling on the output, 0..1 in linear light. */
  brightness?: number
  /** sRGB 0..255, for the kinds that take one. */
  color?: { r: number, g: number, b: number }
  /**
   * How quickly the display falls back, 0..1 per frame. Low is sluggish, high
   * is twitchy; the default is the one that reads as "in time with the music"
   * at the output rate.
   */
  decay?: number
}

export const GAIN_MIN = 0.1
export const GAIN_MAX = 10
export const DEFAULT_GAIN = 1
export const DEFAULT_DECAY = 0.12
/**
 * Below this, nothing lights.
 *
 * A silent room is a fan, a disk and mains hum. Without a floor the strip
 * shimmers faintly forever and a user reasonably concludes it is broken.
 */
export const NOISE_FLOOR = 0.02

export interface Visualiser {
  readonly kind: AudioKind
  /**
   * Renders one frame from a spectrum.
   *
   * `bins` is magnitude per FFT bin, 0..1, lowest frequency first - exactly
   * what `AnalyserNode.getByteFrequencyData` gives once divided by 255.
   */
  render: (bins: Float32Array, out: LedColors, nowMs: number) => void
  /**
   * The OVERALL level the follower is tracking, whatever the visualiser is
   * doing with it.
   *
   * Deliberately not each kind's own response. The panel's meter answers one
   * question - "is the engine hearing anything at all" - and a strip is across
   * the room, so that question has to be answerable without looking at it. The
   * pulse visualiser listens only to the bass, so reporting ITS response would
   * show a flat zero on music with no bass and send the user to check an input
   * that is working perfectly.
   */
  level: () => number
}

/**
 * Logarithmic band edges over the FFT bins.
 *
 * Returned as bin indices rather than frequencies because that is what the
 * render loop needs, and computing them per frame would be a logarithm per band
 * per frame for numbers that never change.
 *
 * `sampleRate` is the context's, and the top usable frequency is half of it -
 * so the highest band is capped there rather than at a constant, which is what
 * makes this correct on a 48 kHz context and on a 44.1 kHz one alike.
 */
export function logBands (binCount: number, bands: number, sampleRate: number, fMin = 40, fMax = 16000): Uint16Array {
  if (!Number.isInteger(binCount) || binCount < 2) {
    throw new RangeError(`audio: binCount must be at least 2, got ${String(binCount)}`)
  }
  if (!Number.isInteger(bands) || bands < 1) {
    throw new RangeError(`audio: bands must be a positive integer, got ${String(bands)}`)
  }
  const nyquist = sampleRate / 2
  const top = Math.min(fMax, nyquist)
  const bottom = Math.min(fMin, top / 2)
  const edges = new Uint16Array(bands + 1)
  const ratio = Math.log(top / bottom)
  for (let i = 0; i <= bands; i++) {
    const frequency = bottom * Math.exp((ratio * i) / bands)
    const bin = Math.round((frequency / nyquist) * binCount)
    // Monotone and at least one bin wide: two identical edges would make a band
    // that is always silent, which on a strip is a dead LED nobody can explain.
    edges[i] = Math.min(binCount, Math.max(i === 0 ? 0 : (edges[i - 1] as number) + 1, bin))
  }
  return edges
}

/**
 * A peak follower: fast attack, slow release.
 *
 * The asymmetry is the same idea as the capture smoother's and for the same
 * reason. A symmetric follower either tracks every snare (and the whole display
 * pumps) or lags the music entirely. Rising instantly and falling over a second
 * or two is what keeps a quiet passage visible without the loud one flattening
 * it.
 */
export interface Follower {
  /** Feeds a new peak and returns the normalising divisor. */
  push: (peak: number) => number
  value: () => number
  reset: () => void
}

export function createFollower (releasePerSecond = 0.5, outputHz = 120): Follower {
  // Per frame rather than per second: the caller runs at the output rate and a
  // per-second constant would make the release depend on the frame rate.
  const decay = Math.pow(1 - releasePerSecond, 1 / outputHz)
  let peak = NOISE_FLOOR
  return {
    push (next: number): number {
      peak = next > peak ? next : Math.max(NOISE_FLOOR, peak * decay)
      return peak
    },
    value: () => peak,
    reset () { peak = NOISE_FLOOR }
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** The same sRGB hue wheel the effects use, decoded once into linear. */
function hue (h: number, out: Float32Array, at: number, value: number): void {
  const t = ((h % 1) + 1) % 1
  const sector = t * 6
  const c = Math.floor(sector)
  const f = sector - c
  let r = 0
  let g = 0
  let b = 0
  switch (c % 6) {
    case 0: r = 1; g = f; break
    case 1: r = 1 - f; g = 1; break
    case 2: g = 1; b = f; break
    case 3: g = 1 - f; b = 1; break
    case 4: r = f; b = 1; break
    default: r = 1; b = 1 - f; break
  }
  out[at] = srgbToLinear(r) * value
  out[at + 1] = srgbToLinear(g) * value
  out[at + 2] = srgbToLinear(b) * value
}

export interface VisualiserOptions {
  spec: AudioSpec
  geometry: EffectGeometry
  /** The audio context's rate, so the bands land on the right frequencies. */
  sampleRate: number
  binCount: number
  outputHz?: number
}

export function createVisualiser (options: VisualiserOptions): Visualiser {
  const { spec, geometry, sampleRate, binCount } = options
  const outputHz = options.outputHz ?? 120
  const gain = Math.min(GAIN_MAX, Math.max(GAIN_MIN, spec.gain ?? DEFAULT_GAIN))
  const brightness = clamp01(spec.brightness ?? 1)
  const decay = clamp01(spec.decay ?? DEFAULT_DECAY)
  const { count, centres, along } = geometry

  const base = spec.color ?? { r: 0, g: 180, b: 255 }
  const baseLinear = new Float32Array([
    srgbToLinear(base.r / 255),
    srgbToLinear(base.g / 255),
    srgbToLinear(base.b / 255)
  ])

  /**
   * One band per LED for the spectrum, capped.
   *
   * More bands than LEDs would average straight back down again; far fewer
   * would make visible steps. Capped at 64 because beyond that each band is a
   * couple of FFT bins and the display becomes noise rather than music.
   */
  const bandCount = Math.max(1, Math.min(64, count))
  const edges = logBands(binCount, bandCount, sampleRate)
  const bands = new Float32Array(bandCount)
  /** Per-band decay state, so each bar falls at its own pace. */
  const held = new Float32Array(bandCount)
  const follower = createFollower(0.5, outputHz)
  let smoothLevel = 0

  const readBands = (bins: Float32Array): number => {
    let peak = 0
    for (let b = 0; b < bandCount; b++) {
      const from = edges[b] as number
      const to = Math.max(from + 1, edges[b + 1] as number)
      let sum = 0
      let n = 0
      for (let i = from; i < to && i < bins.length; i++) {
        sum += bins[i] as number
        n++
      }
      const value = n === 0 ? 0 : sum / n
      bands[b] = value
      if (value > peak) peak = value
    }
    return peak
  }

  const render = (bins: Float32Array, out: LedColors, _nowMs: number): void => {
    const peak = readBands(bins)
    const divisor = follower.push(peak)
    const scale = gain / Math.max(NOISE_FLOOR, divisor)

    switch (spec.kind) {
      case 'spectrum': {
        // Bands laid out along the strip in wire order, low frequencies first,
        // hue running with them. Using `along` rather than the index means the
        // spectrum is spread evenly in SPACE around the rig.
        for (let b = 0; b < bandCount; b++) {
          const value = clamp01((bands[b] as number) * scale)
          const previous = held[b] as number
          // Fall at the configured rate, rise immediately: a bar that lags on
          // the way up is a bar that is never in time with the music.
          held[b] = value > previous ? value : previous * (1 - decay)
        }
        for (let i = 0; i < count; i++) {
          const position = count === 1 ? 0 : (along[i] as number)
          const b = Math.min(bandCount - 1, Math.floor(position * bandCount))
          const value = held[b] as number
          hue(0.66 - 0.66 * (b / Math.max(1, bandCount - 1)), out as unknown as Float32Array, i * 3,
            value < NOISE_FLOOR ? 0 : value * brightness)
        }
        break
      }

      case 'level': {
        // One colour, the whole rig, brightness following the overall level.
        let sum = 0
        for (let b = 0; b < bandCount; b++) sum += bands[b] as number
        const value = clamp01((sum / bandCount) * scale)
        smoothLevel = value > smoothLevel ? value : smoothLevel * (1 - decay)
        const level = smoothLevel < NOISE_FLOOR ? 0 : smoothLevel * brightness
        for (let i = 0; i < count; i++) {
          const at = i * 3
          out[at] = (baseLinear[0] as number) * level
          out[at + 1] = (baseLinear[1] as number) * level
          out[at + 2] = (baseLinear[2] as number) * level
        }
        break
      }

      default: {
        // pulse: the bass drives a flash that spreads from the centre outwards.
        // Only the lowest quarter of the bands, because that is where a kick
        // lives and including the rest turns every cymbal into a flash.
        const lowBands = Math.max(1, Math.floor(bandCount / 4))
        let bass = 0
        for (let b = 0; b < lowBands; b++) bass = Math.max(bass, bands[b] as number)
        const value = clamp01(bass * scale)
        smoothLevel = value > smoothLevel ? value : smoothLevel * (1 - decay)
        const reach = smoothLevel
        for (let i = 0; i < count; i++) {
          // Distance from the centre of the frame, so a beat opens outwards
          // rather than running along the wire.
          const dx = (centres[i * 2] as number) - 0.5
          const dy = (centres[i * 2 + 1] as number) - 0.5
          const d = Math.min(1, Math.hypot(dx, dy) / 0.7071)
          const lit = clamp01((reach - d) / 0.35)
          const level = lit < NOISE_FLOOR ? 0 : lit * brightness
          const at = i * 3
          out[at] = (baseLinear[0] as number) * level
          out[at + 1] = (baseLinear[1] as number) * level
          out[at + 2] = (baseLinear[2] as number) * level
        }
        break
      }
    }
  }

  return {
    kind: spec.kind,
    render,
    level: () => follower.value()
  }
}

/** Validates a specification off the wire; the panel is another process. */
export function parseAudioSpec (value: unknown): AudioSpec {
  if (typeof value !== 'object' || value === null) throw new TypeError('audio: a spec must be an object')
  const raw = value as Record<string, unknown>
  if (!isAudioKind(raw.kind)) {
    throw new RangeError(`audio: kind must be one of ${AUDIO_KINDS.join(', ')}, got ${String(raw.kind)}`)
  }
  const spec: AudioSpec = { kind: raw.kind }
  if (raw.gain !== undefined) {
    if (typeof raw.gain !== 'number' || !Number.isFinite(raw.gain)) throw new TypeError('audio: gain must be a finite number')
    spec.gain = Math.min(GAIN_MAX, Math.max(GAIN_MIN, raw.gain))
  }
  if (raw.brightness !== undefined) {
    if (typeof raw.brightness !== 'number' || !Number.isFinite(raw.brightness)) {
      throw new TypeError('audio: brightness must be a finite number')
    }
    spec.brightness = clamp01(raw.brightness)
  }
  if (raw.decay !== undefined) {
    if (typeof raw.decay !== 'number' || !Number.isFinite(raw.decay)) throw new TypeError('audio: decay must be a finite number')
    spec.decay = clamp01(raw.decay)
  }
  if (raw.color !== undefined) {
    const color = raw.color as Record<string, unknown>
    if (typeof color !== 'object' || color === null) throw new TypeError('audio: color must be an object')
    spec.color = { r: channel(color.r), g: channel(color.g), b: channel(color.b) }
  }
  return spec
}

function channel (value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`audio: a colour channel is an integer 0..255, got ${String(value)}`)
  }
  return value
}
