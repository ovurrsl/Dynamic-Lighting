#pragma once
#include <stddef.h>
#include <stdint.h>

#include "afx_config.h"

/**
 * The network side of the device configuration.
 *
 * Separate from `DeviceConfig` and stored under its own NVS key, for two
 * reasons that are not tidiness. The credentials are variable-length strings
 * while the device blob is a fixed eight bytes, and mixing them would have made
 * every LED-count change rewrite the passphrase. And a board that is only ever
 * driven over USB should not carry a stored passphrase at all - keeping them
 * apart lets the network blob simply not exist.
 *
 * WHY THE FIRMWARE NEEDS A NETWORK AT ALL, since a serial port already works:
 * on iOS there is no Web Serial, no WebUSB, no WebHID and no Web Bluetooth -
 * all four are Chromium-only and Apple requires WebKit. An iPhone can capture
 * its screen (measured), so the missing half is reaching a strip, and the only
 * transport a browser has left there is the network. Hyperion's answer for
 * network devices is UDP (DDP, E1.31, ArtNet) and a browser cannot open a UDP
 * socket at all; a WebSocket it can. So the firmware grows a WebSocket server
 * and carries THE SAME BYTES the serial port carries - same parser, same
 * tests, no second protocol.
 *
 * Everything here is pure, so the TLV handling and the stored blob - written by
 * some earlier build, which is a trust boundary like any other - are tested on
 * the host.
 */
namespace afx {

/** 802.11 says 32 octets; the extra byte is the terminator. */
inline constexpr size_t kMaxSsid = 32;
/** WPA2-PSK as ASCII: 8..63. Shorter cannot associate, so it is refused. */
inline constexpr size_t kMaxPassphrase = 63;
inline constexpr size_t kMinPassphrase = 8;

struct NetworkConfig {
  char ssid[kMaxSsid + 1] = {};
  char passphrase[kMaxPassphrase + 1] = {};
  /**
   * Whether to bring the radio up at all.
   *
   * Default off, and that is the important half of this file. WiFi is not free
   * on this board: the usual cause of RMT corruption on an ESP32 is WiFi
   * interrupt work landing on the LED's core, which is why the USB-only build
   * unlinks the stack entirely. A board driven over USB should stay that way
   * unless someone asked for otherwise.
   */
  bool enabled = false;
};

/** TLV types for the network, continuing the AxC table in afx_config.h. */
enum class NetTlv : uint8_t {
  Ssid = 0x0a,
  Passphrase = 0x0b,
  Enabled = 0x0c,
  /** Asks the board to report its network state (never the passphrase). */
  QueryNet = 0x0d
};

/** True when there is enough here to try to associate. */
inline bool netConfigured (const NetworkConfig &net) {
  return net.enabled && net.ssid[0] != '\0';
}

/** A passphrase is either absent (an open network) or a real WPA2 one. */
inline bool validPassphrase (size_t length) {
  return length == 0 || (length >= kMinPassphrase && length <= kMaxPassphrase);
}

namespace detail {

inline void copyField (char *out, size_t capacity, const uint8_t *value, size_t length) {
  size_t i = 0;
  for (; i < length && i < capacity; i++) out[i] = static_cast<char>(value[i]);
  out[i] = '\0';
}

inline size_t fieldLength (const char *field, size_t capacity) {
  size_t i = 0;
  while (i < capacity && field[i] != '\0') i++;
  return i;
}

}  // namespace detail

/**
 * Applies one network TLV.
 *
 * A length of zero CLEARS the field rather than being refused - that is how a
 * board is taken off a network it should no longer join, and there is no other
 * way to say it. An embedded NUL is refused: it would truncate the value
 * silently and leave the board trying to join a network nobody named.
 */
inline Applied applyNetTlv (NetworkConfig &net, uint8_t type, const uint8_t *value, uint8_t length) {
  const auto hasNul = [value, length]() {
    for (uint8_t i = 0; i < length; i++) {
      if (value[i] == 0) return true;
    }
    return false;
  };
  switch (static_cast<NetTlv>(type)) {
    case NetTlv::Ssid:
      if (length > kMaxSsid || hasNul()) return Applied::Invalid;
      detail::copyField(net.ssid, kMaxSsid, value, length);
      return Applied::Changed;
    case NetTlv::Passphrase:
      if (!validPassphrase(length) || hasNul()) return Applied::Invalid;
      detail::copyField(net.passphrase, kMaxPassphrase, value, length);
      return Applied::Changed;
    case NetTlv::Enabled:
      if (length != 1) return Applied::Invalid;
      net.enabled = value[0] != 0;
      return Applied::Changed;
    case NetTlv::QueryNet:
      return Applied::Action;
  }
  return Applied::Unknown;
}

// ---------------------------------------------------------------------------
// Persistence.
// ---------------------------------------------------------------------------

inline constexpr uint8_t kNetBlobVersion = 1;
/** version, enabled, ssidLen, ssid, pskLen, passphrase, checksum. */
inline constexpr size_t kNetBlobSize = 1 + 1 + 1 + kMaxSsid + 1 + kMaxPassphrase + 1;

inline void serialiseNet (const NetworkConfig &net, uint8_t out[kNetBlobSize]) {
  for (size_t i = 0; i < kNetBlobSize; i++) out[i] = 0;
  const size_t ssidLen = detail::fieldLength(net.ssid, kMaxSsid);
  const size_t pskLen = detail::fieldLength(net.passphrase, kMaxPassphrase);
  out[0] = kNetBlobVersion;
  out[1] = net.enabled ? 1 : 0;
  out[2] = static_cast<uint8_t>(ssidLen);
  for (size_t i = 0; i < ssidLen; i++) out[3 + i] = static_cast<uint8_t>(net.ssid[i]);
  out[3 + kMaxSsid] = static_cast<uint8_t>(pskLen);
  for (size_t i = 0; i < pskLen; i++) out[4 + kMaxSsid + i] = static_cast<uint8_t>(net.passphrase[i]);
  uint8_t sum = 0;
  for (size_t i = 0; i < kNetBlobSize - 1; i++) sum = static_cast<uint8_t>(sum + out[i]);
  out[kNetBlobSize - 1] = static_cast<uint8_t>(sum ^ 0x5a);
}

/**
 * Reads the blob back, leaving `net` untouched on anything it does not fully
 * understand - the same rule the device blob follows, and for the same reason:
 * half a configuration is worse than none, because here it would put the radio
 * on air with a name nobody agreed on.
 */
inline bool deserialiseNet (const uint8_t *blob, size_t length, NetworkConfig &net) {
  if (blob == nullptr || length != kNetBlobSize) return false;
  if (blob[0] != kNetBlobVersion) return false;
  uint8_t sum = 0;
  for (size_t i = 0; i < kNetBlobSize - 1; i++) sum = static_cast<uint8_t>(sum + blob[i]);
  if (blob[kNetBlobSize - 1] != static_cast<uint8_t>(sum ^ 0x5a)) return false;

  const size_t ssidLen = blob[2];
  const size_t pskLen = blob[3 + kMaxSsid];
  if (ssidLen > kMaxSsid || !validPassphrase(pskLen)) return false;

  NetworkConfig read;
  read.enabled = blob[1] != 0;
  detail::copyField(read.ssid, kMaxSsid, blob + 3, ssidLen);
  detail::copyField(read.passphrase, kMaxPassphrase, blob + 4 + kMaxSsid, pskLen);
  net = read;
  return true;
}

}  // namespace afx
