import { parseAddress, formatAddress } from '#lib/engine/address'
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
 * Three facts about WLED's side of the socket shape everything below. All
 * three were read from WLED's source (json.cpp, ws.cpp), none was measured on
 * a device, and the file says which is which:
 *
 * 1. `gamma32()` is applied to every colour handed over the JSON API when the
 *    device's colour gamma is on - which it is by default, at 2.8. A linear
 *    byte sent as-is is therefore raised to the 2.8 on the way to the strip:
 *    the very double gamma the rest of the engine exists to avoid. The bytes
 *    here are PRE-COMPENSATED (`linear^(1/gamma)`) so the device's curve
 *    lands back on linear light.
 * 2. The WebSocket handler parses a message only when it arrives whole in one
 *    frame - its own comment says "max. 1450 bytes" - and answers
 *    `{"error":9}` to anything split. A long strip is therefore sent as
 *    several messages, each addressed by its first LED index.
 * 3. `"live":true`, which an earlier version sent as its handshake, puts the
 *    device into its UDP realtime mode - in which the main loop stops
 *    servicing the strip, so pixels written over JSON are never shown. It is
 *    not sent. Since 0.13 an individual-LED write freezes the segment it
 *    lands on, which is what stops the running effect repainting over it.
 */

/** The path WLED serves its socket on. */
export const WLED_PATH = '/ws'

export interface WledFrameOptions {
  /**
   * Which segment to write. WLED's default single segment is 0, and a rig with
   * several segments needs to say which - writing every one would fight with
   * whatever else is configured on the device.
   */
  segment?: number
  /**
   * The device's own colour gamma, undone in advance.
   *
   * Matches the device's setting, which is why it is a number rather than a
   * switch: 2.8 for a stock WLED, 1 for one with colour gamma turned off in
   * its LED settings, and whatever the user set in between. Sending the
   * wrong value leaves the strip visibly wrong in a way that a preview cannot
   * show, which is why the panel carries it as a setting beside the address.
   */
  gamma?: number
}

/** WLED's factory `gammaCorrectVal`. */
export const WLED_DEFAULT_GAMMA = 2.8
export const WLED_GAMMA_MIN = 1
export const WLED_GAMMA_MAX = 4

/**
 * The largest text message sent in one piece.
 *
 * WLED's figure is 1450 (the comment in ws.cpp); fifty bytes of margin cover
 * the WebSocket frame header and a path MTU smaller than Ethernet's, because
 * the failure mode on the wrong side of the line is a strip that shows
 * nothing and a device answering `{"error":9}` to a message nobody reads.
 */
export const WLED_MAX_FRAME_BYTES = 1400

/** `{"seg":{"id":NNNNN,"i":[NNNN` and `]}}`, generously. */
const FRAME_OVERHEAD_BYTES = 40
/** `"RRGGBB",` */
const LED_BYTES = 9

/** LEDs per message: 151. A 108-LED strip is one message, 512 LEDs are four. */
export const WLED_LEDS_PER_FRAME = Math.floor((WLED_MAX_FRAME_BYTES - FRAME_OVERHEAD_BYTES) / LED_BYTES)

const HEX = '0123456789ABCDEF'

/**
 * Linear 0..1 to the byte that, after the device's own gamma, is linear again.
 *
 * `Math.pow` per channel rather than a 256-entry table: a table indexed by the
 * linear byte would quantise BEFORE the compensation and crush exactly the low
 * end the compensation exists to keep (linear 0.001 is byte 0 in such a table
 * and byte 22 here). Three hundred pow calls a frame is nothing.
 *
 * A NaN - a smoother fed before its buffer was sized, once - would otherwise
 * become the string "NaN" inside a hex colour, which the device parses as
 * black and nobody sees why.
 */
function channel (value: number, gamma: number): number {
  const linear = clamp01(Number.isFinite(value) ? value : 0)
  const encoded = gamma === 1 ? linear : Math.pow(linear, 1 / gamma)
  return Math.round(encoded * 255)
}

function hex2 (value: number): string {
  return `${HEX[value >> 4] as string}${HEX[value & 15] as string}`
}

function checkGamma (gamma: number): number {
  if (!Number.isFinite(gamma) || gamma < WLED_GAMMA_MIN || gamma > WLED_GAMMA_MAX) {
    throw new RangeError(`wled: gamma must be in ${WLED_GAMMA_MIN}..${WLED_GAMMA_MAX}, got ${String(gamma)}`)
  }
  return gamma
}

function checkSegment (segment: number): number {
  if (!Number.isInteger(segment) || segment < 0) {
    throw new RangeError(`wled: segment must be a non-negative integer, got ${String(segment)}`)
  }
  return segment
}

/**
 * One frame as the JSON messages to put on the socket: one message for a
 * strip that fits, several for one that does not.
 *
 * Strings rather than objects, deliberately: this is the hot path at up to 60
 * frames a second, and building an object for `JSON.stringify` to walk would
 * allocate an array of 108 strings plus the object around it, every frame.
 * The shape is small and fixed, so it is written directly.
 *
 * Each message is `{"seg":{"id":S,"i":[start,"RRGGBB",…]}}`: the leading
 * integer is the index the run begins at, and each colour after it lands on
 * the next LED. That is the documented per-LED form, and it is what lets a
 * long strip cross the device's one-frame limit as several runs rather than
 * as one message it refuses.
 */
export function wledFrames (colors: LedColors, leds: number, options: WledFrameOptions = {}): string[] {
  if (!Number.isInteger(leds) || leds < 1) {
    throw new RangeError(`wled: leds must be a positive integer, got ${String(leds)}`)
  }
  if (colors.length < leds * 3) {
    throw new RangeError(`wled: colors holds ${colors.length} floats, needs ${leds * 3}`)
  }
  const segment = checkSegment(options.segment ?? 0)
  const gamma = checkGamma(options.gamma ?? WLED_DEFAULT_GAMMA)
  const frames: string[] = []
  for (let start = 0; start < leds; start += WLED_LEDS_PER_FRAME) {
    const stop = Math.min(leds, start + WLED_LEDS_PER_FRAME)
    let text = `{"seg":{"id":${segment},"i":[${start}`
    for (let led = start; led < stop; led++) {
      const at = led * 3
      const r = channel(colors[at] ?? 0, gamma)
      const g = channel(colors[at + 1] ?? 0, gamma)
      const b = channel(colors[at + 2] ?? 0, gamma)
      text += `,"${hex2(r)}${hex2(g)}${hex2(b)}"`
    }
    frames.push(`${text}]}}`)
  }
  return frames
}

/**
 * The one-off message that puts the device into a state where our pixels show.
 *
 * `on`, because WLED shows nothing while it is off and a user whose strip
 * stays dark because a switch in another app was flipped has no way to know
 * that from here. `bri` at full, because the engine's own brightness limit is
 * the one place brightness is meant to be set, and a device left at 40 % by
 * another app would otherwise dim every frame silently. `frz` freezes the
 * segment so the effect it was running stops repainting over our pixels:
 * WLED 0.13 and later freeze on an individual-LED write anyway, saying it here
 * covers the ones that do not.
 */
export function wledHello (options: WledFrameOptions = {}): string {
  const segment = checkSegment(options.segment ?? 0)
  return `{"on":true,"bri":255,"seg":{"id":${segment},"frz":true}}`
}

/**
 * Hands the segment back to its own effect on the way out.
 *
 * Without it a device we stop driving keeps showing our last frame for ever:
 * a frozen segment is frozen until something unfreezes it, and the user's
 * rainbow does not come back on its own.
 */
export function wledGoodbye (options: WledFrameOptions = {}): string {
  const segment = checkSegment(options.segment ?? 0)
  return `{"seg":{"id":${segment},"frz":false}}`
}

/**
 * The WebSocket URL for a device, from whatever the user typed.
 *
 * `/ws` unless they typed a path of their own - someone behind a reverse proxy
 * has put the device somewhere else and knows where - and `/ws` exactly once:
 * an address pasted from the device's own page (`http://wled.local/ws`, or
 * with a trailing slash) used to come out as `/ws/ws`.
 */
export function wledUrl (host: string): string {
  const url = parseAddress(host, 'wled')
  const path = url.pathname.replace(/\/+$/, '')
  return formatAddress(url, path === '' || path === WLED_PATH ? WLED_PATH : path)
}
