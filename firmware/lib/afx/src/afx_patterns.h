#pragma once
#include <stdint.h>

#include "afx_idle.h"

/**
 * The bench run, on the board.
 *
 * The plan calls this the cheapest risk reduction available and the first thing
 * to do, and it is: firmware, wiring, level shifter, supply, the power limiter
 * and the index order are all verified by these patterns, before any host
 * exists. Putting it in the firmware rather than in a host script means it
 * needs nothing but a USB cable - flash the board, plug it in, watch the strip.
 *
 * What each pattern proves, which is why these five and not others:
 *
 *   Walk       one LED at a time, 0 -> n-1. The index order and the PHYSICAL
 *              corner indices. If the light jumps a corner in the wrong place,
 *              the layout's edge counts are wrong and nothing downstream can
 *              fix it.
 *   Channels   solid red, then green, then blue. The channel order. A strip
 *              that lights green when told red is wired GRB, and this is the
 *              only way to find out without guessing.
 *   Ramp       21 grey steps along the strip. A crushed bottom end, a
 *              non-monotone curve, or dither that is not working all show here
 *              and nowhere else.
 *   White      full white. The power limiter engaging, visibly.
 *   Flash      the whole strip at 1 Hz. The pattern a 240 fps phone camera
 *              needs for the end-to-end latency measurement.
 *
 * Pure and header-only like the rest, so the sequencing is tested on the host.
 */
namespace afx {

enum class Pattern : uint8_t { None = 0, Walk = 1, Channels = 2, Ramp = 3, White = 4, Flash = 5 };

struct BenchTiming {
  /** One LED per step in the walk. Slow enough to follow by eye. */
  uint32_t walkStepMs = 120;
  /** Each of red, green, blue. */
  uint32_t channelMs = 1200;
  uint32_t rampMs = 4000;
  uint32_t whiteMs = 2000;
  uint32_t flashPeriodMs = 1000;
  uint32_t flashMs = 4000;
};

/**
 * Runs the five patterns in order, then reports that it is done.
 *
 * Time is passed in rather than read, so the whole sequence is exercised in a
 * test without waiting fifteen seconds for it.
 */
class Bench {
 public:
  explicit Bench (const BenchTiming &timing = BenchTiming()) : timing_(timing) {}

  /** Total length of one pass. */
  uint32_t durationMs (uint16_t count) const {
    return count * timing_.walkStepMs + timing_.channelMs * 3 + timing_.rampMs +
           timing_.whiteMs + timing_.flashMs;
  }

  /** Which pattern is showing `elapsedMs` into the sequence. */
  Pattern at (uint32_t elapsedMs, uint16_t count) const {
    uint32_t mark = count * timing_.walkStepMs;
    if (elapsedMs < mark) return Pattern::Walk;
    mark += timing_.channelMs * 3;
    if (elapsedMs < mark) return Pattern::Channels;
    mark += timing_.rampMs;
    if (elapsedMs < mark) return Pattern::Ramp;
    mark += timing_.whiteMs;
    if (elapsedMs < mark) return Pattern::White;
    mark += timing_.flashMs;
    if (elapsedMs < mark) return Pattern::Flash;
    return Pattern::None;
  }

  /**
   * One LED of the sequence, 8-bit. Values are DUTY, not perceptual: the strip
   * is being measured here, not made to look nice, and a curve applied for the
   * eye would hide exactly the crushed bottom end the ramp is looking for.
   */
  void pixel (uint32_t elapsedMs, uint16_t index, uint16_t count,
              uint8_t &red, uint8_t &green, uint8_t &blue) const {
    red = green = blue = 0;
    if (count == 0) return;
    switch (at(elapsedMs, count)) {
      case Pattern::Walk: {
        const uint32_t lit = (elapsedMs / timing_.walkStepMs) % count;
        if (index == lit) red = green = blue = 255;
        break;
      }
      case Pattern::Channels: {
        const uint32_t into = elapsedMs - count * timing_.walkStepMs;
        const uint32_t which = into / timing_.channelMs;        // 0, 1, 2
        if (which == 0) red = 255;
        else if (which == 1) green = 255;
        else blue = 255;
        break;
      }
      case Pattern::Ramp: {
        // 21 steps, 0..255 inclusive at both ends, spread along the strip.
        const uint32_t step = count <= 1 ? 0 : (static_cast<uint32_t>(index) * 21) / count;
        const uint8_t level = static_cast<uint8_t>(step * 255 / 20);
        red = green = blue = level;
        break;
      }
      case Pattern::White:
        red = green = blue = 255;
        break;
      case Pattern::Flash: {
        const uint32_t into = elapsedMs - (count * timing_.walkStepMs + timing_.channelMs * 3 +
                                           timing_.rampMs + timing_.whiteMs);
        const bool on = (into % timing_.flashPeriodMs) < timing_.flashPeriodMs / 2;
        if (on) red = green = blue = 255;
        break;
      }
      case Pattern::None:
        break;
    }
  }

 private:
  BenchTiming timing_;
};

}  // namespace afx
