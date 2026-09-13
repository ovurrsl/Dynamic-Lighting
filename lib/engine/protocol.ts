/**
 * The serial wire format: the encoder is what the extension writes to the port,
 * the parser is the reference the ESP32-S3 firmware is written against and what
 * loopback mode runs. Both sides live in one file so they cannot drift.
 *
 * Port of the Adalight/AWA framing in Hyperion's
 * `libsrc/leddevice/dev_serial/LedDeviceAdalight.cpp`, 2.2.2-beta.1:
 * `prepareHeader()` (:73-123) builds the header, `write()` (:125-186) appends
 * the Fletcher trailer (:165-178), `whiteChannelExtension()` (:213) the calibration
 * bytes. The port plan, section 7, holds the verbatim excerpt this was read
 * from; nothing below is from memory. AWA itself originates in HyperHDR
 * (MIT, awawa-dev), which is what makes the format clean for us to ship.
 *
 * Three frame kinds share one 6-byte header:
 *
 *   magic[3]  hi(N-1)  lo(N-1)  (hi ^ lo ^ 0x55)
 *
 *   'Ada'  + N*3 bytes RGB. No trailer, no integrity check at all: a flipped
 *          pixel byte is shown, not detected. Kept for stock Adalight sketches.
 *   'Awa'  + N*3 bytes RGB [+ 4 calibration bytes] + Fletcher(3). The third
 *          magic byte is a FLAG: 'a' plain, 'A' when the four calibration bytes
 *          (limit, red, green, blue) follow the pixels. The firmware derives
 *          its RGBW mix from those four itself.
 *   'Afx'  + N*6 bytes, 16-bit big-endian LINEAR per channel + Fletcher(3).
 *          OURS, NOT HYPERION'S. Hyperion never puts more than 8 bits per
 *          channel on a serial line - its device-facing type is a packed
 *          3-byte `ColorRgb` and even its one 16-bit driver (dev_spi HD108)
 *          copies an 8-bit value up. We write the firmware, so we can send the
 *          16 bits the dark end of a linear ramp needs (lib/light.ts explains
 *          why 8-bit linear bands). "Adalight compatible" still means 8-bit;
 *          that is what 'Awa' is for.
 *
 * The LED count goes on the wire as N-1, big-endian, so N is 1..65536 and a
 * zero-LED frame cannot be expressed. (Hyperion's third protocol, LBAPA, sends
 * N instead - a known inconsistency, and one reason we do not carry LBAPA.)
 *
 * Bytes on this wire are the ONLY place the engine holds anything but linear
 * floats: the 8-bit and 16-bit payloads arrive already quantised from
 * lib/light.ts or lib/engine/dither.ts, and this module treats them as opaque
 * bytes. It never converts a colour.
 */

export const HEADER_SIZE = 6
export const TRAILER_SIZE = 3
export const CALIBRATION_SIZE = 4
/** N-1 must fit in 16 bits. */
export const MAX_LEDS = 65536

export type FrameKind = 'Ada' | 'Awa' | 'Afx'

/** Bytes per LED in the payload of each kind. */
export const BYTES_PER_LED: Readonly<Record<FrameKind, number>> = Object.freeze({ Ada: 3, Awa: 3, Afx: 6 })

/**
 * The four 'AwA' calibration bytes, each 0..255, in wire order. They are what
 * Hyperion's `whiteChannelExtension()` writes from `white_channel_limit`
 * (already scaled from percent to 0..255) and `white_channel_red/green/blue`;
 * the host does not interpret them, the firmware does.
 */
export interface Calibration {
  limit: number
  red: number
  green: number
  blue: number
}

/**
 * A parsed frame. `payload` is the parser's own copy - it does not alias the
 * pushed chunk or the parser's scratch - so a consumer may keep it.
 */
export interface Frame {
  readonly kind: FrameKind
  readonly count: number
  readonly payload: Uint8Array
  /** Present only for an 'AwA' frame. */
  readonly calibration?: Calibration
}

export interface ParserStats {
  /** Frames delivered. */
  frames: number
  /**
   * Every time a partially parsed frame was abandoned and the parser went back
   * to hunting for magic, whatever the reason. `countMismatch` and
   * `badChecksum` classify the abandonments that got past the magic, so
   * `resyncs >= countMismatch + badChecksum`; the difference is magic bytes
   * that did not pan out. Garbage met while already hunting is not a resync.
   */
  resyncs: number
  /** Trailer did not match the payload; frame dropped. */
  badChecksum: number
  /** Header check byte did not match hi/lo; frame dropped. */
  countMismatch: number
}

const MAGIC_A = 0x41 // 'A'
const MAGIC_ADA_1 = 0x64 // 'd'
const MAGIC_ADA_2 = 0x61 // 'a'
const MAGIC_AWA_1 = 0x77 // 'w'
const MAGIC_AWA_2 = 0x61 // 'a'
const MAGIC_AWA_2_CALIBRATED = 0x41 // 'A'
const MAGIC_AFX_1 = 0x66 // 'f'
const MAGIC_AFX_2 = 0x78 // 'x'
const HEADER_XOR = 0x55

/**
 * Hyperion emits the third trailer byte as `fletcherExt != 0x41 ? fletcherExt
 * : 0xaa`. 0x41 is 'A': the intent is that the trailer never ends in a byte a
 * scanner could take for the next frame's magic. The escape is asymmetric -
 * fletcher1 and fletcher2 go out raw and may legitimately be 0x41 - and it is
 * not invertible, since 0xaa is also a legitimate value of fletcherExt; the
 * receiver therefore recomputes the escaped byte and compares, it never
 * decodes. Replicated verbatim because a HyperSerial firmware expects exactly
 * this, quirks included.
 */
const FLETCHER_ESCAPE = 0x41
const FLETCHER_ESCAPED = 0xaa

/**
 * The AWA trailer over `bytes[start, end)`, written to `out[at .. at+3)`.
 *
 * LedDeviceAdalight.cpp `write()`, verbatim from the plan's excerpt:
 *
 *   fletcherExt = (fletcherExt + (*(hasher) ^ (position++))) % 255;
 *   fletcher1   = (fletcher1 + *(hasher++)) % 255;
 *   fletcher2   = (fletcher2 + fletcher1) % 255;
 *
 * `hasher` starts at `_ledBuffer.data() + HEADER_SIZE`: the checksum covers the
 * PAYLOAD ONLY - pixels, plus the calibration bytes when present - never the
 * header. The header protects itself with its own XOR byte.
 *
 * `position` is a `uint8_t` and WRAPS AT 256. That is the detail every rewrite
 * gets wrong: a 108-LED frame is 324 payload bytes, so it crosses the wrap on
 * every frame, and a counter that keeps going past 255 diverges from byte 256
 * onward - the checksum simply never matches and nothing says why. Masking
 * with `& 0xff` is not an optimisation, it is the specification.
 */
function fletcherInto (bytes: Uint8Array, start: number, end: number, out: Uint8Array, at: number): void {
  let fletcher1 = 0
  let fletcher2 = 0
  let fletcherExt = 0
  let position = 0
  for (let i = start; i < end; i++) {
    const b = bytes[i] as number
    fletcherExt = (fletcherExt + (b ^ position)) % 255
    position = (position + 1) & 0xff
    fletcher1 = (fletcher1 + b) % 255
    fletcher2 = (fletcher2 + fletcher1) % 255
  }
  out[at] = fletcher1
  out[at + 1] = fletcher2
  out[at + 2] = fletcherExt !== FLETCHER_ESCAPE ? fletcherExt : FLETCHER_ESCAPED
}

/**
 * The three AWA trailer bytes for a payload, exactly as they go on the wire:
 * `[fletcher1, fletcher2, escapedExt]`. The escape is applied, so the third
 * element is 0xaa whenever the raw fletcherExt was 0x41 (and also whenever it
 * was 0xaa). Exposed so tests and the firmware's own vectors can hit the
 * checksum without framing around it.
 */
export function fletcherAwa (payload: Uint8Array): [number, number, number] {
  const trailer = new Uint8Array(TRAILER_SIZE)
  fletcherInto(payload, 0, payload.length, trailer, 0)
  return [trailer[0] as number, trailer[1] as number, trailer[2] as number]
}

/** Total bytes of a frame on the wire, so a caller can preallocate exactly. */
export function frameSize (kind: FrameKind, count: number, calibrated = false): number {
  const body = HEADER_SIZE + count * BYTES_PER_LED[kind]
  switch (kind) {
    case 'Ada': return body
    case 'Awa': return body + (calibrated ? CALIBRATION_SIZE : 0) + TRAILER_SIZE
    case 'Afx': return body + TRAILER_SIZE
  }
}

/**
 * 'Ada': header + 8-bit RGB. `rgb8` is N*3 bytes; the returned frame is
 * `HEADER_SIZE + N*3` bytes. See `encodeAwa` for the `out` contract.
 */
export function encodeAda (rgb8: Uint8Array, out?: Uint8Array): Uint8Array {
  const count = validatePayload('Ada', rgb8)
  const frame = prepareOut('Ada', out, frameSize('Ada', count))
  placePayload(frame, rgb8)
  writeHeader(frame, MAGIC_ADA_1, MAGIC_ADA_2, count)
  return frame
}

/**
 * 'Awa' / 'AwA': header + 8-bit RGB [+ calibration] + Fletcher. `rgb8` is N*3
 * bytes.
 *
 * `out`, when given, must hold at least the whole frame; pass exactly
 * `frameSize()` bytes and the very same array comes back with nothing
 * allocated, which is the point at 120 frames a second. A larger buffer is
 * accepted and a right-sized view of it is returned, so a caller writing the
 * result to a port never sends stale bytes past the frame. The payload may
 * already sit inside `out` at its final position (offset `HEADER_SIZE`, the
 * way `encodeLinear16(colors, out.subarray(6, ...))` would put it), in which
 * case it is left where it is rather than copied onto itself.
 */
export function encodeAwa (rgb8: Uint8Array, calibration?: Calibration, out?: Uint8Array): Uint8Array {
  const count = validatePayload('Awa', rgb8)
  const calibrated = calibration !== undefined
  if (calibrated) validateCalibration(calibration)
  const frame = prepareOut('Awa', out, frameSize('Awa', count, calibrated))

  // Payload first, header second: a payload that overlaps the head of `out`
  // (a caller's view at offset 0 or 3) would otherwise have its first bytes
  // overwritten by the header before they were copied - and the trailer,
  // computed afterwards, would bless the corrupted bytes. The third magic
  // byte is the calibration flag, not a constant.
  placePayload(frame, rgb8)
  writeHeader(frame, MAGIC_AWA_1, calibrated ? MAGIC_AWA_2_CALIBRATED : MAGIC_AWA_2, count)

  let end = HEADER_SIZE + rgb8.length
  if (calibrated) {
    // Wire order from whiteChannelExtension(): limit, red, green, blue. These
    // sit between the pixels and the trailer and are INSIDE the checksum.
    frame[end] = calibration.limit
    frame[end + 1] = calibration.red
    frame[end + 2] = calibration.green
    frame[end + 3] = calibration.blue
    end += CALIBRATION_SIZE
  }
  fletcherInto(frame, HEADER_SIZE, end, frame, end)
  return frame
}

/**
 * 'Afx': header + 16-bit big-endian linear per channel + Fletcher. This is our
 * extension (see the module comment): `linear16be` is N*6 bytes as produced by
 * `encodeLinear16` in lib/light.ts, and the count on the wire is N, not the
 * byte count, so a firmware that knows the kind knows the stride. Same trailer
 * as 'Awa', same `out` contract as `encodeAwa`.
 */
export function encodeAfx (linear16be: Uint8Array, out?: Uint8Array): Uint8Array {
  const count = validatePayload('Afx', linear16be)
  const frame = prepareOut('Afx', out, frameSize('Afx', count))
  placePayload(frame, linear16be)
  writeHeader(frame, MAGIC_AFX_1, MAGIC_AFX_2, count)
  const end = HEADER_SIZE + linear16be.length
  fletcherInto(frame, HEADER_SIZE, end, frame, end)
  return frame
}

/**
 * The header from prepareHeader(): magic, then N-1 big-endian, then the two
 * count bytes XORed with 0x55. The XOR byte is the header's own integrity
 * check - the Fletcher trailer deliberately does not cover it.
 */
function writeHeader (frame: Uint8Array, magic1: number, magic2: number, count: number): void {
  const encoded = count - 1
  const hi = encoded >> 8
  const lo = encoded & 0xff
  frame[0] = MAGIC_A
  frame[1] = magic1
  frame[2] = magic2
  frame[3] = hi
  frame[4] = lo
  frame[5] = hi ^ lo ^ HEADER_XOR
}

function placePayload (frame: Uint8Array, payload: Uint8Array): void {
  // Already in place: the caller encoded straight into the frame buffer.
  if (payload.buffer === frame.buffer && payload.byteOffset === frame.byteOffset + HEADER_SIZE) return
  // Any other overlap is fine too: TypedArray.prototype.set copies through a
  // clone when source and target share a buffer.
  frame.set(payload, HEADER_SIZE)
}

/** Returns N. */
function validatePayload (kind: FrameKind, payload: Uint8Array): number {
  const stride = BYTES_PER_LED[kind]
  if (payload.length === 0 || payload.length % stride !== 0) {
    throw new RangeError(`protocol: ${kind} payload must be a non-empty multiple of ${stride} bytes, got ${payload.length}`)
  }
  const count = payload.length / stride
  if (count > MAX_LEDS) throw new RangeError(`protocol: ${kind} carries at most ${MAX_LEDS} LEDs, got ${count}`)
  return count
}

function validateCalibration (calibration: Calibration): void {
  for (const key of ['limit', 'red', 'green', 'blue'] as const) {
    const v = calibration[key]
    if (!Number.isInteger(v) || v < 0 || v > 255) {
      throw new RangeError(`protocol: calibration ${key} must be an integer in 0..255, got ${v}`)
    }
  }
}

function prepareOut (kind: FrameKind, out: Uint8Array | undefined, size: number): Uint8Array {
  if (out === undefined) return new Uint8Array(size)
  if (out.length < size) throw new RangeError(`protocol: ${kind} frame needs ${size} bytes, output holds ${out.length}`)
  return out.length === size ? out : out.subarray(0, size)
}

// Parser states. Numbers rather than strings: this runs once per byte.
const MAGIC0 = 0
const MAGIC1 = 1
const MAGIC2 = 2
const HI = 3
const LO = 4
const CHK = 5
const PAYLOAD = 6
const CALIB = 7
const TRAILER = 8
type State = typeof MAGIC0 | typeof MAGIC1 | typeof MAGIC2 | typeof HI | typeof LO | typeof CHK
  | typeof PAYLOAD | typeof CALIB | typeof TRAILER

/**
 * Byte-at-a-time frame parser. Feed it whatever the port hands you - a frame
 * may arrive in any number of pieces and a chunk may hold several frames - and
 * it returns the complete frames it found.
 *
 * THE RESYNC RULE. On any mismatch the parser goes back to hunting for magic,
 * and the byte that failed is RE-EVALUATED as a possible magic start rather
 * than discarded: if it is 'A' the parser is in MAGIC1 afterwards, otherwise
 * MAGIC0. The case that matters is 'A' failing INSIDE the magic: a stream that
 * reads "AAda..." (a stray 'A', then a real frame) has its second 'A' arrive
 * in MAGIC1, and an implementation that drops the failing byte and returns to
 * MAGIC0 then sees "da..." and misses the frame - and, because every frame
 * starts with 'A', misses every frame after it in the same way. It never
 * recovers. The same rule applies to a header check byte or a trailer byte
 * that happens to be 'A'.
 *
 * Two consequences worth knowing, both inherent to a stream format with no
 * byte stuffing: garbage can only be skipped, never detected, so a run of it
 * that happens to spell a valid header is parsed as one (and then fails its
 * trailer); and a truncated frame swallows the start of the next one, whose
 * bytes fail the trailer, so a transmitter dying mid-frame costs at most the
 * frame it collided with. 'Ada' has no trailer, so for it the second point is
 * worse - a truncated 'Ada' frame is completed with the next frame's bytes and
 * DELIVERED. That, and not fashion, is why 'Awa' exists.
 */
export interface FrameParserOptions {
  /**
   * Largest LED count a header may announce; anything above is treated as a
   * count mismatch and the parser goes back to hunting. Default MAX_LEDS, so
   * the format's whole range round-trips. A receiver with a fixed strip
   * should pass its own count: six bytes of garbage that happen to spell a
   * valid 65536-LED header otherwise commit the parser to 393 KB of payload
   * - ten seconds of real frames swallowed at 120 fps - and the ESP32-S3 has
   * neither the memory nor the patience. With the option the loss is bounded
   * to one frame's worth of bytes and the firmware can carry the parser over
   * unchanged.
   */
  maxLeds?: number
}

export class FrameParser {
  readonly stats: ParserStats = { frames: 0, resyncs: 0, badChecksum: 0, countMismatch: 0 }
  readonly maxLeds: number

  private state: State = MAGIC0
  private kind: FrameKind = 'Ada'
  private calibrated = false
  private hi = 0
  private lo = 0
  private count = 0
  /** Payload bytes; `need` adds the calibration bytes, which share `scratch`. */
  private payloadLength = 0
  private need = 0
  private filled = 0
  private trailerAt = 0
  /**
   * Reused across frames and grown to the largest frame seen; the copy handed
   * out in `Frame.payload` is the one allocation per frame.
   */
  private scratch = new Uint8Array(108 * 6 + CALIBRATION_SIZE)
  private readonly expected = new Uint8Array(TRAILER_SIZE)

  constructor (options: FrameParserOptions = {}) {
    const maxLeds = options.maxLeds ?? MAX_LEDS
    if (!Number.isInteger(maxLeds) || maxLeds < 1 || maxLeds > MAX_LEDS) {
      throw new RangeError(`protocol: maxLeds must be an integer 1..${MAX_LEDS}, got ${maxLeds}`)
    }
    this.maxLeds = maxLeds
  }

  /** Back to hunting for magic; keeps the statistics. For a reopened port. */
  reset (): void {
    this.state = MAGIC0
  }

  push (chunk: Uint8Array): Frame[] {
    const frames: Frame[] = []
    let i = 0
    while (i < chunk.length) {
      // PAYLOAD and CALIB are the two states that take a run of bytes rather
      // than one; everything else consumes exactly one byte per iteration.
      if (this.state === PAYLOAD || this.state === CALIB) {
        const stop = this.state === PAYLOAD ? this.payloadLength : this.need
        const take = Math.min(stop - this.filled, chunk.length - i)
        this.scratch.set(chunk.subarray(i, i + take), this.filled)
        this.filled += take
        i += take
        if (this.filled < stop) break
        if (this.state === PAYLOAD) {
          if (this.kind === 'Ada') {
            // No trailer: the frame ends with its last pixel byte, and the
            // very next byte may be the next frame's magic.
            frames.push(this.emit())
            this.state = MAGIC0
          } else {
            this.state = this.calibrated ? CALIB : TRAILER
          }
        } else {
          this.state = TRAILER
        }
        if (this.state === TRAILER) {
          fletcherInto(this.scratch, 0, this.need, this.expected, 0)
          this.trailerAt = 0
        }
        continue
      }

      const b = chunk[i] as number
      i++
      switch (this.state) {
        case MAGIC0:
          if (b === MAGIC_A) this.state = MAGIC1
          break

        case MAGIC1:
          // A second 'A' here goes through resync(), which keeps us in MAGIC1.
          if (b === MAGIC_ADA_1) this.kind = 'Ada'
          else if (b === MAGIC_AWA_1) this.kind = 'Awa'
          else if (b === MAGIC_AFX_1) this.kind = 'Afx'
          else { this.resync(b); break }
          this.state = MAGIC2
          break

        case MAGIC2:
          // 'AwA' is the calibrated 'Awa' magic, not a stray 'A' - it must be
          // matched before the resync rule gets a look at the byte.
          if (this.kind === 'Awa' && (b === MAGIC_AWA_2 || b === MAGIC_AWA_2_CALIBRATED)) {
            this.calibrated = b === MAGIC_AWA_2_CALIBRATED
            this.state = HI
          } else if ((this.kind === 'Ada' && b === MAGIC_ADA_2) || (this.kind === 'Afx' && b === MAGIC_AFX_2)) {
            this.calibrated = false
            this.state = HI
          } else {
            this.resync(b)
          }
          break

        case HI:
          this.hi = b
          this.state = LO
          break

        case LO:
          this.lo = b
          this.state = CHK
          break

        case CHK:
          if (b !== (this.hi ^ this.lo ^ HEADER_XOR)) {
            this.stats.countMismatch++
            this.resync(b)
            break
          }
          this.count = ((this.hi << 8) | this.lo) + 1
          if (this.count > this.maxLeds) {
            // A well-formed header for a strip this receiver does not have:
            // refused like a bad one, so it costs a few bytes, not a payload.
            this.stats.countMismatch++
            this.resync(b)
            break
          }
          this.payloadLength = this.count * BYTES_PER_LED[this.kind]
          this.need = this.payloadLength + (this.calibrated ? CALIBRATION_SIZE : 0)
          if (this.scratch.length < this.need) this.scratch = new Uint8Array(this.need)
          this.filled = 0
          this.state = PAYLOAD
          break

        case TRAILER:
          // Compared byte by byte so a mismatch falls back at once and the
          // failing byte gets its chance as magic; waiting for all three would
          // only widen the window in which a following frame is swallowed.
          if (b !== this.expected[this.trailerAt]) {
            this.stats.badChecksum++
            this.resync(b)
            break
          }
          if (++this.trailerAt === TRAILER_SIZE) {
            frames.push(this.emit())
            this.state = MAGIC0
          }
          break
      }
    }
    return frames
  }

  private resync (b: number): void {
    this.stats.resyncs++
    this.state = b === MAGIC_A ? MAGIC1 : MAGIC0
  }

  private emit (): Frame {
    this.stats.frames++
    const payload = this.scratch.slice(0, this.payloadLength)
    if (!this.calibrated) return { kind: this.kind, count: this.count, payload }
    const at = this.payloadLength
    const s = this.scratch
    return {
      kind: this.kind,
      count: this.count,
      payload,
      calibration: {
        limit: s[at] as number,
        red: s[at + 1] as number,
        green: s[at + 2] as number,
        blue: s[at + 3] as number
      }
    }
  }
}
