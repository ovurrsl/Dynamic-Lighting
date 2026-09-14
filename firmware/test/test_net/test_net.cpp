#include <unity.h>
#include <string.h>
#include "afx_net.h"

using afx::Applied;
using afx::NetTlv;
using afx::NetworkConfig;
using afx::deserialiseNet;
using afx::kNetBlobSize;
using afx::netConfigured;
using afx::serialiseNet;

static Applied apply (NetworkConfig &net, NetTlv type, const char *value) {
  return afx::applyNetTlv(net, static_cast<uint8_t>(type),
                          reinterpret_cast<const uint8_t *>(value),
                          static_cast<uint8_t>(strlen(value)));
}

void test_the_radio_is_off_until_someone_asks_for_it (void) {
  // The default matters more here than anywhere else in the config: WiFi
  // interrupt work on the LED's core is the usual cause of RMT corruption, so a
  // board nobody asked to put on a network must stay off it.
  NetworkConfig net;
  TEST_ASSERT_FALSE(net.enabled);
  TEST_ASSERT_FALSE(netConfigured(net));

  TEST_ASSERT_TRUE(apply(net, NetTlv::Ssid, "studio") == Applied::Changed);
  TEST_ASSERT_FALSE(netConfigured(net));           // named, still not enabled

  const uint8_t on[1] = {1};
  TEST_ASSERT_TRUE(afx::applyNetTlv(net, static_cast<uint8_t>(NetTlv::Enabled), on, 1) == Applied::Changed);
  TEST_ASSERT_TRUE(netConfigured(net));
}

void test_a_passphrase_too_short_to_associate_is_refused (void) {
  // WPA2-PSK as ASCII is 8..63. Accepting "abc" would give a board that boots,
  // tries forever, and says nothing about why it never joins.
  NetworkConfig net;
  TEST_ASSERT_TRUE(apply(net, NetTlv::Passphrase, "abc") == Applied::Invalid);
  TEST_ASSERT_EQUAL_STRING("", net.passphrase);
  TEST_ASSERT_TRUE(apply(net, NetTlv::Passphrase, "hunter22") == Applied::Changed);
  TEST_ASSERT_EQUAL_STRING("hunter22", net.passphrase);
}

void test_an_empty_value_clears_the_field (void) {
  // The only way to take a board off a network it should no longer join.
  NetworkConfig net;
  apply(net, NetTlv::Ssid, "studio");
  apply(net, NetTlv::Passphrase, "hunter22");
  TEST_ASSERT_TRUE(apply(net, NetTlv::Passphrase, "") == Applied::Changed);
  TEST_ASSERT_EQUAL_STRING("", net.passphrase);     // an open network
  TEST_ASSERT_TRUE(apply(net, NetTlv::Ssid, "") == Applied::Changed);
  TEST_ASSERT_FALSE(netConfigured(net));
}

void test_an_over_long_ssid_is_refused_rather_than_truncated (void) {
  NetworkConfig net;
  apply(net, NetTlv::Ssid, "studio");
  char tooLong[40];
  memset(tooLong, 'x', sizeof(tooLong));
  const Applied applied = afx::applyNetTlv(net, static_cast<uint8_t>(NetTlv::Ssid),
                                           reinterpret_cast<const uint8_t *>(tooLong), 33);
  TEST_ASSERT_TRUE(applied == Applied::Invalid);
  TEST_ASSERT_EQUAL_STRING("studio", net.ssid);     // untouched

  // Exactly 32 is legal and must still terminate.
  const Applied edge = afx::applyNetTlv(net, static_cast<uint8_t>(NetTlv::Ssid),
                                        reinterpret_cast<const uint8_t *>(tooLong), 32);
  TEST_ASSERT_TRUE(edge == Applied::Changed);
  TEST_ASSERT_EQUAL_size_t(32, strlen(net.ssid));
}

void test_an_embedded_nul_is_refused (void) {
  // It would truncate silently and leave the board joining a network nobody
  // named - the value the host sent and the value stored would differ.
  NetworkConfig net;
  const uint8_t sneaky[6] = {'a', 'b', 0, 'c', 'd', 'e'};
  TEST_ASSERT_TRUE(afx::applyNetTlv(net, static_cast<uint8_t>(NetTlv::Ssid), sneaky, 6) == Applied::Invalid);
  TEST_ASSERT_EQUAL_STRING("", net.ssid);
}

void test_an_unknown_type_is_skipped_here_too (void) {
  NetworkConfig net;
  const uint8_t value[1] = {1};
  TEST_ASSERT_TRUE(afx::applyNetTlv(net, 0x7f, value, 1) == Applied::Unknown);
}

void test_a_query_is_an_action_not_a_field_change (void) {
  NetworkConfig net;
  TEST_ASSERT_TRUE(afx::applyNetTlv(net, static_cast<uint8_t>(NetTlv::QueryNet), nullptr, 0) == Applied::Action);
}

void test_the_network_round_trips_through_its_blob (void) {
  NetworkConfig net;
  apply(net, NetTlv::Ssid, "studio 5GHz");
  apply(net, NetTlv::Passphrase, "correct horse battery");
  net.enabled = true;

  uint8_t blob[kNetBlobSize];
  serialiseNet(net, blob);

  NetworkConfig read;
  TEST_ASSERT_TRUE(deserialiseNet(blob, sizeof(blob), read));
  TEST_ASSERT_EQUAL_STRING("studio 5GHz", read.ssid);
  TEST_ASSERT_EQUAL_STRING("correct horse battery", read.passphrase);
  TEST_ASSERT_TRUE(read.enabled);
}

void test_a_corrupt_or_foreign_blob_leaves_the_radio_alone (void) {
  NetworkConfig net;
  apply(net, NetTlv::Ssid, "studio");
  net.enabled = true;
  uint8_t blob[kNetBlobSize];
  serialiseNet(net, blob);

  NetworkConfig read;
  blob[kNetBlobSize - 1] ^= 0xff;                       // a flipped checksum
  TEST_ASSERT_FALSE(deserialiseNet(blob, sizeof(blob), read));
  TEST_ASSERT_EQUAL_STRING("", read.ssid);
  TEST_ASSERT_FALSE(read.enabled);

  serialiseNet(net, blob);
  blob[0] = 99;                                         // another build's layout
  TEST_ASSERT_FALSE(deserialiseNet(blob, sizeof(blob), read));
  TEST_ASSERT_FALSE(deserialiseNet(blob, sizeof(blob) - 1, read));
  TEST_ASSERT_FALSE(deserialiseNet(nullptr, sizeof(blob), read));
}

void test_a_stored_passphrase_gets_the_same_validation_as_a_live_one (void) {
  // The blob was written by some earlier build: the same trust boundary.
  NetworkConfig net;
  net.enabled = true;
  uint8_t blob[kNetBlobSize];
  serialiseNet(net, blob);
  blob[3 + afx::kMaxSsid] = 3;                          // a 3-character passphrase
  uint8_t sum = 0;
  for (size_t i = 0; i < kNetBlobSize - 1; i++) sum = static_cast<uint8_t>(sum + blob[i]);
  blob[kNetBlobSize - 1] = static_cast<uint8_t>(sum ^ 0x5a);   // checksum made valid

  NetworkConfig read;
  TEST_ASSERT_FALSE(deserialiseNet(blob, sizeof(blob), read));
}

int main (int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_the_radio_is_off_until_someone_asks_for_it);
  RUN_TEST(test_a_passphrase_too_short_to_associate_is_refused);
  RUN_TEST(test_an_empty_value_clears_the_field);
  RUN_TEST(test_an_over_long_ssid_is_refused_rather_than_truncated);
  RUN_TEST(test_an_embedded_nul_is_refused);
  RUN_TEST(test_an_unknown_type_is_skipped_here_too);
  RUN_TEST(test_a_query_is_an_action_not_a_field_change);
  RUN_TEST(test_the_network_round_trips_through_its_blob);
  RUN_TEST(test_a_corrupt_or_foreign_blob_leaves_the_radio_alone);
  RUN_TEST(test_a_stored_passphrase_gets_the_same_validation_as_a_live_one);
  UNITY_END();
  return 0;
}
