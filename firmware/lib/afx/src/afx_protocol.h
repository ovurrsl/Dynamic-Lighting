#pragma once
#include <stddef.h>
#include <stdint.h>

/**
 * The serial frame parser.
 *
 * A port of lib/engine/protocol.ts, which is the encoder this receives from and
 * is itself a port of Hyperion's Adalight writer. Kept as a header-only library
 * with no Arduino dependency so the SAME code compiles for the host and runs
 * under `pio test -e native` - a parser that is only ever exercised on a board
 * is a parser whose resync rule nobody has ever actually tried.
 *
 * Frame layout, all four kinds:
 *
 *   'A' k0 k1   hi lo chk   payload[...]   [trailer[3]]
 *
 * with `ledCount = (hi<<8 | lo) + 1` and `chk = hi ^ lo ^ 0x55`.
 *
 *   Ada  n*3 bytes, 8-bit RGB, NO trailer
 *   Awa  n*3 bytes, 8-bit RGB, Fletcher trailer  ('AwA' = with calibration)
 *   Afx  n*6 bytes, 16-bit BE linear,  Fletcher trailer   <- the product path
 *   AxC  TLV control channel, Fletcher trailer
 */
namespace afx {

inline constexpr uint8_t kMagic = 0x41;       // 'A'
inline constexpr uint8_t kHeaderXor = 0x55;
inline constexpr size_t kHeaderSize = 6;
inline constexpr size_t kTrailerSize = 3;
inline constexpr size_t kCalibrationSize = 4;
inline constexpr uint8_t kFletcherEscape = 0x41;   // never emit 'A'
inline constexpr uint8_t kFletcherEscaped = 0xaa;

enum class Kind : uint8_t { Ada, Awa, Afx, Axc };

inline constexpr size_t bytesPerLed (Kind kind) {
  return kind == Kind::Afx ? 6 : 3;
}

struct Stats {
  uint32_t frames = 0;
  /**
   * Times the parser fell back to hunting for magic. Healthy is EXACTLY 0:
   * a non-zero count is a cable, a driver or a parser bug, never acceptable
   * noise. Same for the two below.
   */
  uint32_t resyncs = 0;
  uint32_t badChecksum = 0;
  uint32_t countMismatch = 0;
};

/**
 * The AWA trailer over `bytes[0, length)`, into `out[0..3)`.
 *
 * Hyperion's LedDeviceAdalight.cpp write(), verbatim:
 *
 *   fletcherExt = (fletcherExt + (*(hasher) ^ (position++))) % 255;
 *   fletcher1   = (fletcher1 + *(hasher++)) % 255;
 *   fletcher2   = (fletcher2 + fletcher1) % 255;
 *
 * Two details that every rewrite gets wrong, and both are specification:
 *
 * - `position` is a uint8_t and WRAPS AT 256. A 108-LED Afx frame is 648
 *   payload bytes, so it crosses the wrap twice; a counter that keeps going
 *   diverges from byte 256 on, the checksum never matches, and nothing says
 *   why.
 * - The third byte must never be 0x41, because that is the magic and a
 *   receiver would take it for a frame start mid-stream. 0xaa stands in.
 *
 * The checksum covers the PAYLOAD ONLY - never the header, which protects
 * itself with its own XOR byte.
 */
inline void fletcher (const uint8_t *bytes, size_t length, uint8_t out[kTrailerSize]) {
  uint8_t fletcher1 = 0;
  uint8_t fletcher2 = 0;
  uint8_t fletcherExt = 0;
  uint8_t position = 0;
  for (size_t i = 0; i < length; i++) {
    const uint8_t b = bytes[i];
    fletcherExt = static_cast<uint8_t>((fletcherExt + (b ^ position)) % 255);
    position++;                       // uint8_t: wraps, and must
    fletcher1 = static_cast<uint8_t>((fletcher1 + b) % 255);
    fletcher2 = static_cast<uint8_t>((fletcher2 + fletcher1) % 255);
  }
  out[0] = fletcher1;
  out[1] = fletcher2;
  out[2] = fletcherExt != kFletcherEscape ? fletcherExt : kFletcherEscaped;
}

/**
 * Streaming parser. `Capacity` is the largest payload in bytes it will accept;
 * a header announcing more is refused like a bad one.
 *
 * That refusal is not tidiness. Six bytes of garbage that happen to spell a
 * valid 65536-LED header would otherwise commit the parser to 393 KB of
 * payload - ten seconds of real frames swallowed at 120 fps - and this chip has
 * neither the memory nor the patience.
 */
template <size_t Capacity>
class FrameParser {
 public:
  struct Frame {
    Kind kind;
    uint16_t count;
    bool calibrated;
    const uint8_t *payload;
    size_t length;
  };

  Stats stats;

  /** Back to hunting for magic; keeps the statistics. For a reopened port. */
  void reset () { state_ = State::Magic0; }

  /**
   * Feeds one byte. Returns true when a complete frame is ready, and `frame`
   * then points into the parser's own buffer - valid until the next push().
   */
  bool push (uint8_t b, Frame &frame) {
    switch (state_) {
      case State::Magic0:
        if (b == kMagic) state_ = State::Magic1;
        return false;

      case State::Magic1:
        // A second 'A' here goes through resync(), which keeps us in Magic1.
        if (b == 'd') kind_ = Kind::Ada;
        else if (b == 'w') kind_ = Kind::Awa;
        else if (b == 'f') kind_ = Kind::Afx;
        else if (b == 'x') kind_ = Kind::Axc;
        else { resync(b); return false; }
        state_ = State::Magic2;
        return false;

      case State::Magic2:
        // 'AwA' is the calibrated Awa magic, not a stray 'A': it has to be
        // matched before the resync rule gets a look at the byte.
        if (kind_ == Kind::Awa && (b == 'a' || b == 'A')) {
          calibrated_ = b == 'A';
          state_ = State::Hi;
        } else if ((kind_ == Kind::Ada && b == 'a') ||
                   (kind_ == Kind::Afx && b == 'x') ||
                   (kind_ == Kind::Axc && b == 'C')) {
          calibrated_ = false;
          state_ = State::Hi;
        } else {
          resync(b);
        }
        return false;

      case State::Hi: hi_ = b; state_ = State::Lo; return false;
      case State::Lo: lo_ = b; state_ = State::Chk; return false;

      case State::Chk: {
        if (b != static_cast<uint8_t>(hi_ ^ lo_ ^ kHeaderXor)) {
          stats.countMismatch++;
          resync(b);
          return false;
        }
        const uint32_t count = (static_cast<uint32_t>(hi_) << 8 | lo_) + 1;
        const uint32_t payload = count * bytesPerLed(kind_);
        need_ = payload + (calibrated_ ? kCalibrationSize : 0);
        if (need_ > Capacity) {
          stats.countMismatch++;
          resync(b);
          return false;
        }
        count_ = static_cast<uint16_t>(count);
        payloadLength_ = payload;
        filled_ = 0;
        state_ = State::Payload;
        return false;
      }

      case State::Payload:
        buffer_[filled_++] = b;
        if (filled_ < need_) return false;
        if (kind_ == Kind::Ada) {
          // No trailer: the frame ends with its last pixel byte, and the very
          // next byte may be the next frame's magic.
          state_ = State::Magic0;
          return emit(frame);
        }
        fletcher(buffer_, need_, expected_);
        trailerAt_ = 0;
        state_ = State::Trailer;
        return false;

      case State::Trailer:
        // Byte by byte, so a mismatch falls back at once and the failing byte
        // gets its chance as magic. Waiting for all three would only widen the
        // window in which a following frame is swallowed.
        if (b != expected_[trailerAt_]) {
          stats.badChecksum++;
          resync(b);
          return false;
        }
        if (++trailerAt_ == kTrailerSize) {
          state_ = State::Magic0;
          return emit(frame);
        }
        return false;
    }
    return false;
  }

 private:
  enum class State : uint8_t { Magic0, Magic1, Magic2, Hi, Lo, Chk, Payload, Trailer };

  /**
   * THE rule every implementation gets wrong: on a mismatch the current byte is
   * RE-EVALUATED as a new magic start, never dropped. If it is 'A' we stay in
   * Magic1 rather than falling to Magic0, because otherwise a stream carrying
   * "AAda..." desynchronises permanently.
   */
  void resync (uint8_t b) {
    stats.resyncs++;
    state_ = b == kMagic ? State::Magic1 : State::Magic0;
  }

  bool emit (Frame &frame) {
    stats.frames++;
    frame.kind = kind_;
    frame.count = count_;
    frame.calibrated = calibrated_;
    frame.payload = buffer_;
    frame.length = payloadLength_;
    return true;
  }

  State state_ = State::Magic0;
  Kind kind_ = Kind::Ada;
  bool calibrated_ = false;
  uint8_t hi_ = 0, lo_ = 0;
  uint16_t count_ = 0;
  uint32_t payloadLength_ = 0, need_ = 0, filled_ = 0;
  size_t trailerAt_ = 0;
  uint8_t buffer_[Capacity];
  uint8_t expected_[kTrailerSize] = {0, 0, 0};
};

}  // namespace afx
