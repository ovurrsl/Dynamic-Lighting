#pragma once
#include <math.h>
#include <stddef.h>
#include <stdint.h>

/**
 * The three things that happen between a frame arriving and the strip latching:
 * interpolation, dithering and the power limit. Header-only and free of any
 * Arduino dependency, so `pio test -e native` exercises them on the host.
 *
 * Order matters and is not arbitrary:
 *
 *   keyframe -> interpolate (16-bit) -> dither (-> 8-bit duty) -> power limit
 *
 * The limiter comes LAST and works on duty-domain bytes, because a WS2812B's
 * current is proportional to PWM duty, not to any perceptual value. And it
 * comes after the dither because it squeezes the bottom end, which is exactly
 * what the dither exists to protect.
 */
namespace afx {

// ---------------------------------------------------------------------------
// Interpolation.
// ---------------------------------------------------------------------------

/**
 * Glides from the frame being shown to the one that just arrived.
 *
 * This is the decision that takes the host off the hook: the board makes its
 * own 120 Hz from 60 Hz keyframes, so a missed host deadline is a slower glide
 * rather than a stutter, Windows scheduler jitter stops mattering, and the
 * 120 Hz claim becomes a hardware guarantee measurable with a logic analyser.
 *
 * It interpolates, never extrapolates: extrapolation overshoots on scene cuts,
 * and a cut is exactly when the eye is looking.
 */
class Interpolator {
 public:
  /** Microseconds of glide, clamped: never shorter than one output period. */
  static constexpr uint32_t kMinUs = 4000;
  /** A host at 10 Hz glides for 100 ms, which looks like smoothing, not lag. */
  static constexpr uint32_t kMaxUs = 50000;

  void reset () { haveArrival_ = false; emaUs_ = 0; }

  /**
   * A keyframe arrived at `nowUs`. Returns the glide it will use, which is the
   * exponential moving average of the arrival interval - so the board tracks
   * whatever rate the host is actually managing rather than the rate it claims.
   */
  uint32_t arrived (uint32_t nowUs) {
    if (haveArrival_) {
      const uint32_t delta = nowUs - lastArrivalUs_;
      // 1/4 weight: four frames to settle, which at 60 Hz is 67 ms.
      emaUs_ = emaUs_ == 0 ? delta : emaUs_ + (static_cast<int32_t>(delta) - static_cast<int32_t>(emaUs_)) / 4;
    }
    lastArrivalUs_ = nowUs;
    haveArrival_ = true;
    startUs_ = nowUs;
    durationUs_ = emaUs_ < kMinUs ? kMinUs : (emaUs_ > kMaxUs ? kMaxUs : emaUs_);
    return durationUs_;
  }

  /** 0..65536 position along the glide at `nowUs`; saturates at the target. */
  uint32_t progress (uint32_t nowUs) const {
    if (!haveArrival_ || durationUs_ == 0) return 65536;
    const uint32_t elapsed = nowUs - startUs_;
    if (elapsed >= durationUs_) return 65536;
    return static_cast<uint32_t>((static_cast<uint64_t>(elapsed) << 16) / durationUs_);
  }

 private:
  bool haveArrival_ = false;
  uint32_t lastArrivalUs_ = 0;
  uint32_t startUs_ = 0;
  uint32_t emaUs_ = 0;
  uint32_t durationUs_ = kMinUs;
};

/**
 * One channel, 16-bit, `t` in 0..65536. Held at the target once t saturates.
 *
 * The product is 64-bit on purpose: a full-range span (65535) times a `t`
 * past the halfway point (32768 and up) is over 2^31, and in 32 bits that
 * wrapped negative - so a black-to-white glide turned into garbage colours for
 * its second half, on every frame that crossed the middle.
 */
inline uint16_t glide (uint16_t from, uint16_t to, uint32_t t) {
  const int64_t span = static_cast<int64_t>(to) - static_cast<int64_t>(from);
  return static_cast<uint16_t>(static_cast<int64_t>(from) + ((span * static_cast<int64_t>(t)) >> 16));
}

// ---------------------------------------------------------------------------
// Dither.
// ---------------------------------------------------------------------------

/**
 * Sigma-delta, per channel. The time average of the output is exactly
 * `value16 / 256`, so at 120 Hz the bottom end carries roughly 14 effective
 * bits - the difference between a smooth fade to black and visible stair steps,
 * and the biggest single quality gap between a good ambilight and a cheap one.
 *
 * Every accumulator is seeded differently, and that is not a detail: 108 LEDs
 * dithering in phase produce a visible pulse across the whole strip instead of
 * invisible noise.
 */
template <size_t Channels>
class Dither {
 public:
  Dither () { reseed(); }

  /**
   * Each channel starts at a different point in its cycle. Without this the
   * whole strip crosses its threshold on the same frame and the noise that
   * should be invisible becomes one visible pulse.
   */
  void reseed () {
    for (size_t i = 0; i < Channels; i++) {
      carry_[i] = static_cast<uint8_t>((i * 2654435761u) >> 24);
    }
  }

  /**
   * One channel. `value16` is 0..65535; the returned byte is the duty to show
   * this frame, and the remainder is carried so the TIME AVERAGE of the output
   * is exactly `value16 / 256` - 0xFF00 is a steady 255.
   *
   * Above 0xFF00 the average would exceed a byte, and there the output is
   * HELD at full duty: the sum of the carry and the value overflows sixteen
   * bits, and letting the top byte wrap sent 0 or 1 for a channel the host had
   * set to full white. A white screen blinked black, once every few frames,
   * for exactly the LEDs that were brightest.
   */
  uint8_t step (size_t channel, uint16_t value16) {
    const uint32_t sum = static_cast<uint32_t>(carry_[channel]) + value16;
    if (sum >= 0x10000u) {
      carry_[channel] = 0xff;
      return 0xff;
    }
    carry_[channel] = static_cast<uint8_t>(sum & 0xff);
    return static_cast<uint8_t>(sum >> 8);
  }

 private:
  uint8_t carry_[Channels] = {};
};

// ---------------------------------------------------------------------------
// Power limit.
// ---------------------------------------------------------------------------

struct PowerModel {
  /** Every WS2812B controller draws this even showing black. */
  float idleMaPerLed = 1.0f;
  /** One LED, all three channels at full duty. */
  float fullWhiteMa = 60.0f;
  float budgetMa = 1500.0f;
  /** Do nothing until the budget is exceeded by this much. */
  float deadBand = 0.02f;
  /** Seconds for the scale to climb back; attack is instant. */
  float releaseTau = 0.25f;
};

/**
 * Keeps the strip inside its supply.
 *
 * Three corrections over the sketch this replaces, and each fixes something
 * visible:
 *
 * - **Attack instantly, release slowly.** Dropping the scale is a safety
 *   action and happens at once; raising it is what pumps, so it is the slow
 *   direction. This is the whole cure for the pumping.
 * - **Dead band and quantisation.** Below a 2% overshoot nothing happens, and
 *   the scale moves in 1/256 steps, so a scene that hovers at the budget does
 *   not shimmer.
 * - **A current model with a floor.** The old formula said 0 mA at black.
 *   108 controllers idle at about 100 mA, which is 7% of a 1500 mA budget -
 *   enough to blow the budget it claims to be protecting.
 */
class PowerLimiter {
 public:
  explicit PowerLimiter (const PowerModel &model = PowerModel()) : model_(model) {}

  void reset () { scale_ = 1.0f; }
  /** The filter's continuous state; `quantised()` is what the pixels get. */
  float scale () const { return scale_; }
  /**
   * A new budget, keeping the filter's state.
   *
   * The configuration used to be applied by constructing a new limiter over
   * the old one, from the control task, while the output task was reading it:
   * a torn object mid-frame, and a scale snapped back to 1.0 - a bright scene
   * under a tight budget jumped to full for the frames it took to attack again.
   */
  void setModel (const PowerModel &model) { model_ = model; }

  /** `dutySum` is the sum of all channel bytes; `leds` the strip length. */
  float update (uint32_t dutySum, uint16_t leds, float dtSeconds) {
    const float estimateMa = leds * model_.idleMaPerLed +
                             model_.fullWhiteMa * static_cast<float>(dutySum) / 765.0f;
    float target = 1.0f;
    if (estimateMa > model_.budgetMa * (1.0f + model_.deadBand)) {
      // The floor does not scale with brightness, so only the variable part
      // can be traded away.
      const float floorMa = leds * model_.idleMaPerLed;
      const float variable = estimateMa - floorMa;
      target = variable > 0.0f ? (model_.budgetMa - floorMa) / variable : 0.0f;
      if (target < 0.0f) target = 0.0f;
      if (target > 1.0f) target = 1.0f;
    }
    if (target < scale_) {
      scale_ = target;                                   // instant, for safety
    } else if (dtSeconds > 0.0f) {
      scale_ += (target - scale_) * (1.0f - expf(-dtSeconds / model_.releaseTau));
    }
    if (scale_ > 1.0f) scale_ = 1.0f;
    if (scale_ < 0.0f) scale_ = 0.0f;
    return quantised();
  }

  /**
   * What actually multiplies the pixels: 1/256 steps, so a scene sitting on
   * the budget does not shimmer.
   *
   * Quantised HERE and not in the filter state, which is the difference
   * between working and looking like it works. Rounding `scale_` itself stalls
   * the release: as it approaches 1 the per-frame increment falls below half a
   * step, rounds back to where it started, and the strip stays permanently dim
   * after one bright scene. Measured at 0.94 and stuck.
   */
  float quantised () const {
    return static_cast<float>(static_cast<int>(scale_ * 256.0f + 0.5f)) / 256.0f;
  }

 private:
  PowerModel model_;
  float scale_ = 1.0f;
};

}  // namespace afx
