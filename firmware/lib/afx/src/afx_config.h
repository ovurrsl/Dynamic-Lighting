#pragma once
#include <stddef.h>
#include <stdint.h>

/**
 * What this particular board is driving, and how to change it over the wire.
 *
 * The plan calls this the key to sellability, and it is: `#define TOP_LEDS 35`
 * nails the firmware to one monitor. A hard-coded LED count and power budget
 * are the same defect in a smaller form - the bench run would walk 108 LEDs on
 * a 60-LED strip, and a 1500 mA budget is wrong for anyone with a different
 * supply.
 *
 * The layout itself is NOT here and never will be: edge counts, band depths,
 * direction and offset all live in the host. The firmware does not need to know
 * what "the top edge" is, and the moment it does it stops fitting the next
 * customer's monitor.
 *
 * Everything in this header is pure, so the TLV parsing and the NVS
 * serialisation are tested on the host - and the stored blob was written by
 * some earlier version of this firmware, which is a trust boundary like any
 * other.
 */
namespace afx {

struct DeviceConfig {
  /** LEDs on this strip. The wire's frames may still say otherwise per frame. */
  uint16_t ledCount = 108;
  /** Milliamps the supply can give the strip. */
  uint16_t budgetMa = 1500;
  /** Brightness of the idle animation, 0-255. */
  uint8_t idleBrightness = 40;
  /** Run the bench patterns at boot. Off for a customer who is past that. */
  bool benchOnBoot = true;
};

/** Compile-time ceiling; the runtime count is configuration. */
inline constexpr uint16_t kConfigMaxLeds = 512;
inline constexpr uint16_t kMinBudgetMa = 100;
inline constexpr uint16_t kMaxBudgetMa = 20000;

/** TLV types on the AxC control channel. */
enum class Tlv : uint8_t {
  Version = 0x01,
  RunBench = 0x02,
  LedCount = 0x03,
  BudgetMa = 0x04,
  IdleBrightness = 0x05,
  BenchOnBoot = 0x06,
  QueryConfig = 0x07,
  Save = 0x08,
  ResetDefaults = 0x09
};

enum class Applied : uint8_t {
  /** The field changed. */
  Changed,
  /** Understood, but it asks for something other than a field change. */
  Action,
  /** A type this firmware does not know: skipped, not refused (see below). */
  Unknown,
  /** Understood and REFUSED: the value is out of range or the wrong length. */
  Invalid
};

/**
 * Applies one TLV to `config`.
 *
 * An unknown type is skipped rather than refused, so a newer host stays usable
 * with an older board - it sends a field this firmware has never heard of and
 * the rest of the message still lands. A KNOWN type with a bad value is a
 * different thing entirely and is refused: silently clamping a 5000-LED count
 * to 512 would leave the host and the board disagreeing about the strip, with
 * nothing saying so.
 */
inline Applied applyTlv (DeviceConfig &config, uint8_t type, const uint8_t *value, uint8_t length) {
  const auto u16 = [value]() -> uint16_t {
    return static_cast<uint16_t>(value[0] << 8 | value[1]);      // big-endian, as on the wire
  };
  switch (static_cast<Tlv>(type)) {
    case Tlv::LedCount: {
      if (length != 2) return Applied::Invalid;
      const uint16_t count = u16();
      if (count < 1 || count > kConfigMaxLeds) return Applied::Invalid;
      config.ledCount = count;
      return Applied::Changed;
    }
    case Tlv::BudgetMa: {
      if (length != 2) return Applied::Invalid;
      const uint16_t budget = u16();
      if (budget < kMinBudgetMa || budget > kMaxBudgetMa) return Applied::Invalid;
      config.budgetMa = budget;
      return Applied::Changed;
    }
    case Tlv::IdleBrightness:
      if (length != 1) return Applied::Invalid;
      config.idleBrightness = value[0];
      return Applied::Changed;
    case Tlv::BenchOnBoot:
      if (length != 1) return Applied::Invalid;
      config.benchOnBoot = value[0] != 0;
      return Applied::Changed;
    case Tlv::Version:
    case Tlv::RunBench:
    case Tlv::QueryConfig:
    case Tlv::Save:
    case Tlv::ResetDefaults:
      return Applied::Action;
  }
  return Applied::Unknown;
}

/**
 * Walks a TLV body, calling `visit(type, value, length, applied)` for each.
 *
 * A truncated trailer - a length that runs past the end - stops the walk rather
 * than reading beyond the buffer. The frame's checksum makes that unlikely, but
 * "unlikely" is not a bounds check.
 */
template <typename Visit>
inline void walkTlv (DeviceConfig &config, const uint8_t *body, size_t length, Visit visit) {
  size_t at = 0;
  while (at + 2 <= length) {
    const uint8_t type = body[at];
    const uint8_t size = body[at + 1];
    if (at + 2 + size > length) return;
    visit(type, body + at + 2, size, applyTlv(config, type, body + at + 2, size));
    at += 2 + size;
  }
}

// ---------------------------------------------------------------------------
// Persistence.
// ---------------------------------------------------------------------------

/** Blob layout version. Bump when a field is added, removed or resized. */
inline constexpr uint8_t kConfigBlobVersion = 1;
inline constexpr size_t kConfigBlobSize = 8;

/**
 * Serialises to a fixed blob for NVS: version, fields, and a checksum.
 *
 * The checksum is not paranoia about flash. It is that a blob can be read back
 * from a board flashed with a DIFFERENT build - the key is the same and the
 * bytes are not - and a config half-understood is worse than no config, because
 * it lights a strip with a length nobody agreed on.
 */
inline void serialiseConfig (const DeviceConfig &config, uint8_t out[kConfigBlobSize]) {
  out[0] = kConfigBlobVersion;
  out[1] = static_cast<uint8_t>(config.ledCount >> 8);
  out[2] = static_cast<uint8_t>(config.ledCount & 0xff);
  out[3] = static_cast<uint8_t>(config.budgetMa >> 8);
  out[4] = static_cast<uint8_t>(config.budgetMa & 0xff);
  out[5] = config.idleBrightness;
  out[6] = config.benchOnBoot ? 1 : 0;
  uint8_t sum = 0;
  for (size_t i = 0; i < kConfigBlobSize - 1; i++) sum = static_cast<uint8_t>(sum + out[i]);
  out[7] = static_cast<uint8_t>(sum ^ 0x5a);
}

/**
 * Reads a blob back. Returns false and leaves `config` untouched if it is the
 * wrong size, the wrong version, fails its checksum, or carries a value this
 * firmware would refuse over the wire - the stored value gets exactly the same
 * validation as a live one, because it is the same trust boundary.
 */
inline bool deserialiseConfig (const uint8_t *blob, size_t length, DeviceConfig &config) {
  if (blob == nullptr || length != kConfigBlobSize) return false;
  if (blob[0] != kConfigBlobVersion) return false;
  uint8_t sum = 0;
  for (size_t i = 0; i < kConfigBlobSize - 1; i++) sum = static_cast<uint8_t>(sum + blob[i]);
  if (blob[7] != static_cast<uint8_t>(sum ^ 0x5a)) return false;

  const uint16_t ledCount = static_cast<uint16_t>(blob[1] << 8 | blob[2]);
  const uint16_t budgetMa = static_cast<uint16_t>(blob[3] << 8 | blob[4]);
  if (ledCount < 1 || ledCount > kConfigMaxLeds) return false;
  if (budgetMa < kMinBudgetMa || budgetMa > kMaxBudgetMa) return false;

  config.ledCount = ledCount;
  config.budgetMa = budgetMa;
  config.idleBrightness = blob[5];
  config.benchOnBoot = blob[6] != 0;
  return true;
}

}  // namespace afx
