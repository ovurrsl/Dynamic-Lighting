#pragma once
#include <stdint.h>

/**
 * What the strip does when no host is talking to it, and how it crosses
 * between that and a live picture.
 *
 * Pure and header-only like the rest, so the transitions are tested rather
 * than eyeballed on a desk.
 *
 * The behaviour is a product decision, not a default: a device that goes black
 * the moment the software stops looks broken, and "the board is alive, your
 * software is not" is worth real money in support. But a strip that rainbows
 * forever is an annoyance, so it fades out after a while.
 */
namespace afx {

/** Full-saturation hue over 1536 steps (6 sectors x 256). From the original sketch. */
inline void hueToRgb (uint16_t hue1536, uint8_t &red, uint8_t &green, uint8_t &blue) {
  const uint8_t sector = static_cast<uint8_t>(hue1536 / 256);
  const uint8_t position = static_cast<uint8_t>(hue1536 % 256);
  switch (sector) {
    case 0:  red = 255;                                green = position;                            blue = 0;        break;
    case 1:  red = static_cast<uint8_t>(255 - position); green = 255;                               blue = 0;        break;
    case 2:  red = 0;                                  green = 255;                                 blue = position; break;
    case 3:  red = 0;                                  green = static_cast<uint8_t>(255 - position); blue = 255;      break;
    case 4:  red = position;                           green = 0;                                   blue = 255;      break;
    default: red = 255;                                green = 0;      blue = static_cast<uint8_t>(255 - position);  break;
  }
}

struct IdlePolicy {
  /** No valid frame for this long and the host counts as gone. */
  uint32_t hostTimeoutMs = 1500;
  /** Fade down to the idle animation over this long - never a hard cut. */
  uint32_t toIdleMs = 1000;
  /** And back up over this, so plugging in is not a flash. */
  uint32_t toHostMs = 200;
  /** Rainbow for this long after the host goes, then fade to black. */
  uint32_t rainbowMs = 30000;
  uint32_t rainbowFadeMs = 2000;
  uint8_t idleBrightness = 40;
};

/**
 * Tracks whether a host is present and how far through a crossfade we are.
 *
 * Replaces the old sketch's `tud_mounted()` / `autonomousMode` pair, which
 * asked the USB stack a question it could not answer: a cable can be plugged
 * in with nothing sending. The only thing that means "a host is driving this
 * strip" is a valid frame arriving.
 */
class IdleState {
 public:
  explicit IdleState (const IdlePolicy &policy = IdlePolicy()) : policy_(policy) {}

  /**
   * A new policy, keeping the state: whether a host is present and how far a
   * crossfade has got. Replacing the whole object for a brightness change made
   * the strip forget the host for a frame and restart its fade.
   */
  void setPolicy (const IdlePolicy &policy) { policy_ = policy; }

  void frameArrived (uint32_t nowMs) {
    lastFrameMs_ = nowMs;
    haveFrame_ = true;
  }

  bool hostActive (uint32_t nowMs) const {
    return haveFrame_ && (nowMs - lastFrameMs_) < policy_.hostTimeoutMs;
  }

  /**
   * 0..256 weight of the HOST picture; the remainder is the idle animation.
   * Crossfaded both ways, because a hard cut in either direction reads as a
   * fault.
   */
  uint16_t hostMix (uint32_t nowMs) {
    const bool active = hostActive(nowMs);
    if (active != wasActive_) {
      wasActive_ = active;
      transitionStartMs_ = nowMs;
      transitionFrom_ = mix_;
    }
    const uint32_t span = active ? policy_.toHostMs : policy_.toIdleMs;
    const uint16_t target = active ? 256 : 0;
    if (span == 0) { mix_ = target; return mix_; }
    const uint32_t elapsed = nowMs - transitionStartMs_;
    if (elapsed >= span) { mix_ = target; return mix_; }
    const int32_t from = static_cast<int32_t>(transitionFrom_);
    const int32_t to = static_cast<int32_t>(target);
    mix_ = static_cast<uint16_t>(from + (to - from) * static_cast<int32_t>(elapsed) / static_cast<int32_t>(span));
    return mix_;
  }

  /**
   * Brightness of the idle animation, 0..255: full for a while, then faded to
   * black. Measured from when the host went away, so it restarts each time.
   */
  uint8_t idleBrightness (uint32_t nowMs) const {
    if (!haveFrame_) return policy_.idleBrightness;   // never seen a host: stay lit
    const uint32_t since = nowMs - lastFrameMs_;
    if (since <= policy_.hostTimeoutMs) return policy_.idleBrightness;
    const uint32_t idleFor = since - policy_.hostTimeoutMs;
    if (idleFor < policy_.rainbowMs) return policy_.idleBrightness;
    const uint32_t fading = idleFor - policy_.rainbowMs;
    if (fading >= policy_.rainbowFadeMs) return 0;
    const uint32_t left = policy_.rainbowFadeMs - fading;
    return static_cast<uint8_t>(static_cast<uint32_t>(policy_.idleBrightness) * left / policy_.rainbowFadeMs);
  }

  /** One LED of the idle rainbow, already scaled by `idleBrightness`. */
  void idlePixel (uint16_t index, uint16_t count, uint32_t nowMs,
                  uint8_t &red, uint8_t &green, uint8_t &blue) const {
    const uint16_t base = static_cast<uint16_t>((nowMs / 24UL) % 1536UL);
    const uint16_t hue = static_cast<uint16_t>((base + (static_cast<uint32_t>(index) * 1536UL) / (count == 0 ? 1 : count)) % 1536UL);
    hueToRgb(hue, red, green, blue);
    const uint8_t level = idleBrightness(nowMs);
    red = static_cast<uint8_t>(static_cast<uint16_t>(red) * level / 255);
    green = static_cast<uint8_t>(static_cast<uint16_t>(green) * level / 255);
    blue = static_cast<uint8_t>(static_cast<uint16_t>(blue) * level / 255);
  }

 private:
  IdlePolicy policy_;
  bool haveFrame_ = false;
  bool wasActive_ = false;
  uint32_t lastFrameMs_ = 0;
  uint32_t transitionStartMs_ = 0;
  uint16_t transitionFrom_ = 0;
  uint16_t mix_ = 0;
};

}  // namespace afx
