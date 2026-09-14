import type { LedColors } from '#lib/engine/types'
import { clamp01 } from '#lib/light'

/**
 * WLED, over the one door a browser can open.
 *
 * Hyperion drives WLED over DDP or WARLS, both UDP, and a browser cannot open a
 * UDP socket at all - `chrome.sockets` is undefined even in an extension, which
 * was measured rather than assumed. That is where the analysis used to stop,
 * and it stopped one step too early: **a device using the transport Hyperion
 * chose does not mean that is its only transport.**
 *
 * WLED has had a WebSocket at `ws://[ip]/ws` since 0.10.2, on by default, and it
 * accepts a subset of the JSON API - including the part that sets individual
 * LEDs. So a browser can drive a WLED strip per-LED, through a door Hyperion
 * never uses.
 *
 * What this costs, stated plainly because it decides whether the driver is
 * usable: every frame is TEXT, and WLED parses JSON per frame on an ESP. At 108
 * LEDs a frame is roughly a kilobyte. The network is not the constraint; the
 * ESP's CPU is. **The achievable frame rate has not been measured** (N1 in
 * docs/firmware-and-devices.md) and nothing here claims one.
 *
 * Two encodings are offered because WLED accepts both and they are not the same
 * size: hex strings are 8 bytes per LED including quotes and commas, numeric
 * triples are about 12. Hex is the default for that reason alone.
 */

export interface WledFrameOptions {
  /**
   * Which segment to write. WLED's default single segment is 0, and a rig with
   * several segments needs to say which - writing every one would fight with
   * whatever else is configured on the device.
   */
  segment?: number
  /** 'hex' is smaller on the wire; 'rgb' is easier to read while debugging. */
  encoding?: 'hex' | 'rgb'
  /**
   * Sent alongside the pixels on every frame.
   *
   * WLED will not show live pixels while the device is off, and a user whose
   * strip stays dark because a switch in another app was flipped has no way to
   * know that from here. Costs a handful of bytes; saves a support conversation.
   */
  keepOn?: boolean
}

const HEX = '0123456789ABCDEF'

/** Linear 0..1 to the byte WLED wants: the same reasoning as the Adalight path. */
function channel (value: number): number {
  return Math.round(clamp01(value) * 255)
}

function hex2 (value: number): string {
  return `${HEX[value >> 4] as string}${HEX[value & 15] as string}`
}

/**
 * One frame as the JSON string to put on the socket.
 *
 * A string rather than an object, deliberately: this is the hot path at up to
 * 60 frames a second, and building an object for `JSON.stringify` to walk would
 * allocate an array of 108 strings plus the object around it, every frame. The
 * shape is small and fixed, so it is written directly.
 *
 * **Linear 8-bit, not sRGB**, for the same reason the Adalight path sends
 * linear: WLED writes the byte to its LED driver, and a WS2812's brightness
 * follows PWM duty, which follows the byte. Gamma here would be applied a second
 * time by the physics.
 */
export function wledFrame (colors: LedColors, leds: number, options: WledFrameOptions = {}): string {
  if (!Number.isInteger(leds) || leds < 1) {
    throw new RangeError(`wled: leds must be a positive integer, got ${String(leds)}`)
  }
  if (colors.length < leds * 3) {
    throw new RangeError(`wled: colors holds ${colors.length} floats, needs ${leds * 3}`)
  }
  const segment = options.segment ?? 0
  if (!Number.isInteger(segment) || segment < 0) {
    throw new RangeError(`wled: segment must be a non-negative integer, got ${String(segment)}`)
  }
  const encoding = options.encoding ?? 'hex'
  const parts: string[] = []
  for (let led = 0; led < leds; led++) {
    const at = led * 3
    const r = channel(colors[at] ?? 0)
    const g = channel(colors[at + 1] ?? 0)
    const b = channel(colors[at + 2] ?? 0)
    parts.push(encoding === 'hex' ? `"${hex2(r)}${hex2(g)}${hex2(b)}"` : `[${r},${g},${b}]`)
  }
  // `"i"` starting at index 0 replaces the whole run; `"id"` names the segment
  // so a device with several does not have the others rewritten underneath it.
  const body = `{"id":${segment},"i":[${parts.join(',')}]}`
  return options.keepOn === false ? `{"seg":${body}}` : `{"on":true,"seg":${body}}`
}

/**
 * The one-off message that puts a device into a state where live pixels show.
 *
 * Sent on connect rather than per frame. `live` is WLED's realtime override; a
 * device running an effect ignores pixel writes until something claims it.
 */
export function wledHello (options: WledFrameOptions = {}): string {
  const segment = options.segment ?? 0
  return `{"on":true,"live":true,"seg":{"id":${segment}}}`
}

/** The WebSocket URL for a host, accepting an address with or without a scheme. */
export function wledUrl (host: string): string {
  const trimmed = host.trim()
  if (trimmed === '') throw new RangeError('wled: host is empty')
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    return trimmed.endsWith('/ws') ? trimmed : `${trimmed.replace(/\/+$/, '')}/ws`
  }
  // A user types an address, not a URL. http:// is accepted because it is what
  // they would have copied out of their browser's bar.
  const bare = trimmed.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const scheme = trimmed.startsWith('https://') ? 'wss' : 'ws'
  return `${scheme}://${bare}/ws`
}
