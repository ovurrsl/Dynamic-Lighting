import type { LedColors } from '#lib/engine/types'
import { encodeLinear16, encodeLinear8 } from '#lib/light'

/**
 * Serial framing: LED colours -> the bytes the firmware reads.
 *
 * Port of the Adalight/AWA writer in Hyperion's
 * libsrc/leddevice/dev_serial/LedDeviceAdalight.cpp (bare `cpp:` references
 * below); the AWA protocol itself is HyperHDR's (MIT, (c) 2021 awawa-dev).
 * Section 7 of docs/hyperion-port-plan.md records the five details extracted
 * from that file; every one of them is a test in test/engine-protocol.test.ts.
 *
 * Three protocols, one header shape:
 *
 *   ADA  'A' 'd' 'a'      hi lo chk   N*3 bytes RGB                      (cpp:113-117)
 *   AWA  'A' 'w' 'a'|'A'  hi lo chk   N*3 bytes RGB [+4 calib]  +3 Fletcher (cpp:101-105, 161-179)
 *   Afx  'A' 'f' 'x'      hi lo chk   N*6 bytes 16-bit BE linear +3 Fletcher (ours)
 *
 * where `hi lo` is N-1 big-endian and `chk = hi ^ lo ^ 0x55` (cpp:104-105).
 * The count is sent as N-1 so that a 256-LED strip is 0x00ff and not 0x0100:
 * a legacy of 8-bit Arduinos, kept because every Adalight sketch expects it.
 * (LBAPA, the third protocol in that file, sends N instead and is not ported.)
 *
 * Afx is not in Hyperion: nothing there ever puts more than 8 bits per channel
 * on a serial line. It is the same header and trailer around 16-bit linear
 * payload, because the firmware is ours and the low end of a linear ramp needs
 * the bits (lib/light.ts). ADA and AWA stay as the proven 8-bit compatibility
 * path for anything that speaks Adalight.
 *
 * The Fletcher trailer is copied from cpp:165-178, not derived. Its shape is
 * where a rewrite goes wrong: it covers the PAYLOAD only (the header is not
 * hashed, `hasher` starts at HEADER_SIZE), `position` is a uint8 and wraps at
 * 256 (108 LEDs is 324 bytes, so it wraps for us), and ONLY the third byte is
 * escaped away from 0x41 ('A') so a checksum byte can never look like a frame
 * start - fletcher1 and fletcher2 may legitimately be 0x41, and the firmware
 * tolerates that because the header's count+XOR check rejects a false start.
 */

export type Protocol = 'ada' | 'awa' | 'afx'

export const HEADER_SIZE = 6
export const TRAILER_SIZE = 3
/** N-1 must fit in 16 bits. */
export const MAX_LED_COUNT = 65536

/** The byte a Fletcher extension of 'A' is replaced with (cpp:178). */
export const FLETCHER_ESCAPE = 0xaa

export const MAGIC: Readonly<Record<Protocol, readonly [number, number, number]>> = Object.freeze({
  ada: [0x41, 0x64, 0x61], // 'A' 'd' 'a'
  awa: [0x41, 0x77, 0x61], // 'A' 'w' 'a'
  afx: [0x41, 0x66, 0x78] //  'A' 'f' 'x'
})

/**
 * AWA's optional white-channel calibration. When present the third magic byte
 * becomes 'A' and these four bytes follow the pixel data, inside the checksum
 * (cpp:103, whiteChannelExtension at cpp:163). The firmware does the RGBW
 * conversion itself from them. Each 0..255.
 */
export interface AwaCalibration {
  limit: number
  red: number
  green: number
  blue: number
}

export const AWA_CALIBRATION_SIZE = 4

/** Colours as the framer accepts them: linear floats, or codes a dither stage already produced. */
export type PayloadSource = LedColors | Uint8Array | Uint16Array

export interface Framer {
  readonly protocol: Protocol
  readonly count: number
  /** Total frame length in bytes. */
  readonly size: number
  /**
   * Writes one frame. `out` (allocated when absent, sized `size`) gets header,
   * payload, calibration and trailer; the returned view is exactly `size`
   * bytes long. Float input is encoded with plain rounding (encodeLinear8 /
   * encodeLinear16); a Uint8Array (ADA/AWA) or Uint16Array (Afx) of codes is
   * copied as is, which is how a dithered frame goes out.
   *
   * The caller owns `out`. A serial writer with a write in flight must not hand
   * the same buffer to the next frame; see lib/engine/serial.ts.
   */
  frame (source: PayloadSource, out?: Uint8Array): Uint8Array
}

export function bytesPerLed (protocol: Protocol): number {
  return protocol === 'afx' ? 6 : 3
}

export function frameSize (protocol: Protocol, count: number, calibrated = false): number {
  validateProtocol(protocol)
  validateCount(count)
  switch (protocol) {
    case 'ada': return HEADER_SIZE + count * 3
    case 'awa': return HEADER_SIZE + count * 3 + (calibrated ? AWA_CALIBRATION_SIZE : 0) + TRAILER_SIZE
    case 'afx': return HEADER_SIZE + count * 6 + TRAILER_SIZE
  }
}

/**
 * Writes the six header bytes at `out[at..at+6)` and returns the offset after
 * them. `calibrated` only means something for AWA.
 */
export function writeHeader (out: Uint8Array, at: number, protocol: Protocol, count: number, calibrated = false): number {
  validateProtocol(protocol)
  validateCount(count)
  if (out.length < at + HEADER_SIZE) throw new RangeError(`protocol: no room for a header at ${at} in ${out.length} bytes`)
  const magic = MAGIC[protocol]
  const n = count - 1
  const hi = (n >> 8) & 0xff
  const lo = n & 0xff
  out[at] = magic[0]
  out[at + 1] = magic[1]
  out[at + 2] = protocol === 'awa' && calibrated ? 0x41 : magic[2]
  out[at + 3] = hi
  out[at + 4] = lo
  out[at + 5] = hi ^ lo ^ 0x55
  return at + HEADER_SIZE
}

/**
 * The three Fletcher bytes over `bytes[start..end)`, written to `out[at..at+3)`
 * (cpp:165-178, verbatim in structure). Returns the offset after them.
 *
 * `position` is masked to a byte on every increment: that is the `uint8_t` of
 * the original and it is load-bearing, not incidental.
 */
export function writeFletcher (bytes: Uint8Array, start: number, end: number, out: Uint8Array, at: number): number {
  if (start < 0 || end > bytes.length || start > end) throw new RangeError(`protocol: fletcher range ${start}..${end} outside ${bytes.length} bytes`)
  if (out.length < at + TRAILER_SIZE) throw new RangeError(`protocol: no room for a trailer at ${at} in ${out.length} bytes`)
  let fletcher1 = 0
  let fletcher2 = 0
  let fletcherExt = 0
  let position = 0
  for (let i = start; i < end; i++) {
    const byte = bytes[i] as number
    fletcherExt = (fletcherExt + (byte ^ position)) % 255
    position = (position + 1) & 0xff
    fletcher1 = (fletcher1 + byte) % 255
    fletcher2 = (fletcher2 + fletcher1) % 255
  }
  out[at] = fletcher1
  out[at + 1] = fletcher2
  out[at + 2] = fletcherExt !== 0x41 ? fletcherExt : FLETCHER_ESCAPE
  return at + TRAILER_SIZE
}

/** Convenience for tests and tools: the trailer for a payload, as three bytes. */
export function fletcher (payload: Uint8Array, start = 0, end = payload.length): Uint8Array {
  const out = new Uint8Array(TRAILER_SIZE)
  writeFletcher(payload, start, end, out, 0)
  return out
}

export interface FramerOptions {
  /** AWA only. Presence switches the magic to 'AwA' and appends the four bytes. */
  calibration?: AwaCalibration
}

export function createFramer (protocol: Protocol, count: number, options: FramerOptions = {}): Framer {
  validateProtocol(protocol)
  validateCount(count)
  if (options.calibration !== undefined && protocol !== 'awa') {
    throw new RangeError(`protocol: calibration is an AWA feature, not ${protocol}`)
  }
  const calibration = options.calibration === undefined ? null : validateCalibration(options.calibration)
  const calibrated = calibration !== null
  const size = frameSize(protocol, count, calibrated)
  const perLed = bytesPerLed(protocol)
  const payloadEnd = HEADER_SIZE + count * perLed
  const hashedEnd = payloadEnd + (calibrated ? AWA_CALIBRATION_SIZE : 0)

  // The header never changes for a given framer; write it once and copy.
  const header = new Uint8Array(HEADER_SIZE)
  writeHeader(header, 0, protocol, count, calibrated)

  return {
    protocol,
    count,
    size,
    frame (source: PayloadSource, out?: Uint8Array): Uint8Array {
      const buffer = out ?? new Uint8Array(size)
      if (buffer.length < size) throw new RangeError(`protocol: output holds ${buffer.length} bytes, frame is ${size}`)
      if (source instanceof Uint16Array) {
        if (perLed !== 6) throw new TypeError(`protocol: 16-bit codes cannot go out over ${protocol}; use Afx or 8-bit codes`)
      } else if (source instanceof Uint8Array) {
        if (perLed !== 3) throw new TypeError('protocol: 8-bit codes cannot go out over afx; use 16-bit codes or floats')
      } else if (!(source instanceof Float32Array)) {
        throw new TypeError('protocol: source must be a Float32Array, Uint8Array or Uint16Array')
      }
      if (source.length !== count * 3) {
        throw new RangeError(`protocol: source has ${source.length} channels, ${count} LEDs need ${count * 3}`)
      }

      buffer.set(header, 0)
      const payload = buffer.subarray(HEADER_SIZE, payloadEnd)
      if (source instanceof Float32Array) {
        if (perLed === 6) encodeLinear16(source, payload)
        else encodeLinear8(source, payload)
      } else if (source instanceof Uint16Array) {
        for (let i = 0; i < source.length; i++) {
          const v = source[i] as number
          payload[i * 2] = v >> 8
          payload[i * 2 + 1] = v & 0xff
        }
      } else {
        payload.set(source)
      }

      if (calibration !== null) {
        buffer[payloadEnd] = calibration.limit
        buffer[payloadEnd + 1] = calibration.red
        buffer[payloadEnd + 2] = calibration.green
        buffer[payloadEnd + 3] = calibration.blue
      }
      if (protocol !== 'ada') writeFletcher(buffer, HEADER_SIZE, hashedEnd, buffer, hashedEnd)
      return buffer.length === size ? buffer : buffer.subarray(0, size)
    }
  }
}

/** What a receiver makes of one frame. `checksumOk` is null for ADA, which has no trailer. */
export interface DecodedFrame {
  protocol: Protocol
  count: number
  /** The raw pixel bytes: N*3 for ADA/AWA, N*6 (big-endian pairs) for Afx. */
  payload: Uint8Array
  calibration: AwaCalibration | null
  checksumOk: boolean | null
}

/**
 * Reference receiver: exactly what the firmware must accept. Throws on
 * anything that is not a complete, well-formed frame. Used by the tests to
 * prove round trips and by the loopback writer to count frames a device would
 * have taken. The firmware's stream resynchronisation is its own concern;
 * this decodes one frame that starts at byte 0.
 */
export function decodeFrame (bytes: Uint8Array): DecodedFrame {
  if (bytes.length < HEADER_SIZE) throw new RangeError(`protocol: ${bytes.length} bytes is shorter than a header`)
  const b0 = bytes[0] as number
  const b1 = bytes[1] as number
  const b2 = bytes[2] as number
  let protocol: Protocol
  let calibrated = false
  if (b0 === 0x41 && b1 === 0x64 && b2 === 0x61) {
    protocol = 'ada'
  } else if (b0 === 0x41 && b1 === 0x77 && (b2 === 0x61 || b2 === 0x41)) {
    protocol = 'awa'
    calibrated = b2 === 0x41
  } else if (b0 === 0x41 && b1 === 0x66 && b2 === 0x78) {
    protocol = 'afx'
  } else {
    throw new RangeError(`protocol: unknown magic ${hex(b0)} ${hex(b1)} ${hex(b2)}`)
  }

  const hi = bytes[3] as number
  const lo = bytes[4] as number
  if ((bytes[5] as number) !== (hi ^ lo ^ 0x55)) throw new RangeError('protocol: header checksum mismatch')
  const count = ((hi << 8) | lo) + 1
  const size = frameSize(protocol, count, calibrated)
  if (bytes.length !== size) throw new RangeError(`protocol: ${protocol} frame for ${count} LEDs is ${size} bytes, got ${bytes.length}`)

  const payloadEnd = HEADER_SIZE + count * bytesPerLed(protocol)
  const payload = bytes.subarray(HEADER_SIZE, payloadEnd)
  let calibration: AwaCalibration | null = null
  let hashedEnd = payloadEnd
  if (calibrated) {
    calibration = {
      limit: bytes[payloadEnd] as number,
      red: bytes[payloadEnd + 1] as number,
      green: bytes[payloadEnd + 2] as number,
      blue: bytes[payloadEnd + 3] as number
    }
    hashedEnd += AWA_CALIBRATION_SIZE
  }
  let checksumOk: boolean | null = null
  if (protocol !== 'ada') {
    const expected = fletcher(bytes, HEADER_SIZE, hashedEnd)
    checksumOk = expected[0] === bytes[hashedEnd] && expected[1] === bytes[hashedEnd + 1] && expected[2] === bytes[hashedEnd + 2]
  }
  return { protocol, count, payload, calibration, checksumOk }
}

function validateProtocol (protocol: Protocol): void {
  if (!(protocol in MAGIC)) throw new RangeError(`protocol: unknown protocol ${String(protocol)}`)
}

function validateCount (count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > MAX_LED_COUNT) {
    throw new RangeError(`protocol: LED count must be an integer 1..${MAX_LED_COUNT}, got ${count}`)
  }
}

function validateCalibration (c: AwaCalibration): AwaCalibration {
  for (const key of ['limit', 'red', 'green', 'blue'] as const) {
    const v = c[key]
    if (!Number.isInteger(v) || v < 0 || v > 255) throw new RangeError(`protocol: calibration ${key} must be an integer 0..255, got ${v}`)
  }
  return { limit: c.limit, red: c.red, green: c.green, blue: c.blue }
}

function hex (byte: number): string {
  return `0x${byte.toString(16).padStart(2, '0')}`
}
