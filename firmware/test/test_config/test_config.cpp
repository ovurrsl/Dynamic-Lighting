#include <unity.h>
#include <string.h>
#include "afx_config.h"

using afx::Applied;
using afx::DeviceConfig;
using afx::Tlv;
using afx::deserialiseConfig;
using afx::kConfigBlobSize;
using afx::serialiseConfig;

static Applied apply (DeviceConfig &config, Tlv type, const uint8_t *value, uint8_t length) {
  return afx::applyTlv(config, static_cast<uint8_t>(type), value, length);
}

void test_the_led_count_is_configuration_not_a_define (void) {
  // The whole point: a board that only fits one monitor is not a product.
  DeviceConfig config;
  TEST_ASSERT_EQUAL_UINT16(108, config.ledCount);
  const uint8_t sixty[2] = {0x00, 0x3c};
  TEST_ASSERT_TRUE(apply(config, Tlv::LedCount, sixty, 2) == Applied::Changed);
  TEST_ASSERT_EQUAL_UINT16(60, config.ledCount);
}

void test_an_out_of_range_value_is_REFUSED_not_clamped (void) {
  // Clamping 5000 to 512 would leave the host and the board disagreeing about
  // the strip with nothing saying so.
  DeviceConfig config;
  const uint8_t huge[2] = {0x13, 0x88};                 // 5000
  TEST_ASSERT_TRUE(apply(config, Tlv::LedCount, huge, 2) == Applied::Invalid);
  TEST_ASSERT_EQUAL_UINT16(108, config.ledCount);       // untouched

  const uint8_t zero[2] = {0x00, 0x00};
  TEST_ASSERT_TRUE(apply(config, Tlv::LedCount, zero, 2) == Applied::Invalid);
  TEST_ASSERT_EQUAL_UINT16(108, config.ledCount);

  const uint8_t tiny[2] = {0x00, 0x0a};                 // 10 mA
  TEST_ASSERT_TRUE(apply(config, Tlv::BudgetMa, tiny, 2) == Applied::Invalid);
  TEST_ASSERT_EQUAL_UINT16(1500, config.budgetMa);
}

void test_a_wrong_length_is_refused (void) {
  DeviceConfig config;
  const uint8_t one[1] = {0x3c};
  TEST_ASSERT_TRUE(apply(config, Tlv::LedCount, one, 1) == Applied::Invalid);
  const uint8_t three[3] = {0, 0, 60};
  TEST_ASSERT_TRUE(apply(config, Tlv::LedCount, three, 3) == Applied::Invalid);
  TEST_ASSERT_EQUAL_UINT16(108, config.ledCount);
}

void test_an_unknown_type_is_skipped_so_a_newer_host_still_works (void) {
  DeviceConfig config;
  const uint8_t value[2] = {0x00, 0x01};
  TEST_ASSERT_TRUE(afx::applyTlv(config, 0x7f, value, 2) == Applied::Unknown);
  TEST_ASSERT_EQUAL_UINT16(108, config.ledCount);       // and nothing else moved
}

void test_actions_are_not_field_changes (void) {
  DeviceConfig config;
  TEST_ASSERT_TRUE(apply(config, Tlv::Version, nullptr, 0) == Applied::Action);
  TEST_ASSERT_TRUE(apply(config, Tlv::RunBench, nullptr, 0) == Applied::Action);
  TEST_ASSERT_TRUE(apply(config, Tlv::Save, nullptr, 0) == Applied::Action);
}

void test_a_body_with_several_tlvs_applies_all_of_them (void) {
  DeviceConfig config;
  const uint8_t body[] = {
    0x03, 0x02, 0x00, 0x3c,        // ledCount = 60
    0x04, 0x02, 0x0b, 0xb8,        // budgetMa = 3000
    0x05, 0x01, 0x80,              // idleBrightness = 128
    0x06, 0x01, 0x00               // benchOnBoot = false
  };
  unsigned changed = 0;
  afx::walkTlv(config, body, sizeof(body), [&](uint8_t, const uint8_t *, uint8_t, Applied applied) {
    if (applied == Applied::Changed) changed++;
  });
  TEST_ASSERT_EQUAL_UINT32(4, changed);
  TEST_ASSERT_EQUAL_UINT16(60, config.ledCount);
  TEST_ASSERT_EQUAL_UINT16(3000, config.budgetMa);
  TEST_ASSERT_EQUAL_UINT8(128, config.idleBrightness);
  TEST_ASSERT_FALSE(config.benchOnBoot);
}

void test_a_truncated_tlv_stops_the_walk_instead_of_reading_past_the_end (void) {
  // The frame checksum makes this unlikely; "unlikely" is not a bounds check.
  DeviceConfig config;
  const uint8_t body[] = {
    0x03, 0x02, 0x00, 0x3c,        // good: ledCount = 60
    0x04, 0x08, 0x0b               // claims 8 bytes, only 1 follows
  };
  unsigned seen = 0;
  afx::walkTlv(config, body, sizeof(body), [&](uint8_t, const uint8_t *, uint8_t, Applied) { seen++; });
  TEST_ASSERT_EQUAL_UINT32(1, seen);
  TEST_ASSERT_EQUAL_UINT16(60, config.ledCount);
  TEST_ASSERT_EQUAL_UINT16(1500, config.budgetMa);      // the truncated one did not land
}

void test_one_bad_tlv_does_not_stop_the_good_ones_around_it (void) {
  DeviceConfig config;
  const uint8_t body[] = {
    0x03, 0x02, 0x13, 0x88,        // ledCount = 5000, refused
    0x04, 0x02, 0x0b, 0xb8         // budgetMa = 3000, fine
  };
  unsigned invalid = 0, changed = 0;
  afx::walkTlv(config, body, sizeof(body), [&](uint8_t, const uint8_t *, uint8_t, Applied applied) {
    if (applied == Applied::Invalid) invalid++;
    if (applied == Applied::Changed) changed++;
  });
  TEST_ASSERT_EQUAL_UINT32(1, invalid);
  TEST_ASSERT_EQUAL_UINT32(1, changed);
  TEST_ASSERT_EQUAL_UINT16(108, config.ledCount);
  TEST_ASSERT_EQUAL_UINT16(3000, config.budgetMa);
}

// ---------------------------------------------------------------------------
// Persistence.
// ---------------------------------------------------------------------------

void test_a_config_round_trips_through_the_blob (void) {
  DeviceConfig written;
  written.ledCount = 240;
  written.budgetMa = 5000;
  written.idleBrightness = 90;
  written.benchOnBoot = false;
  uint8_t blob[kConfigBlobSize];
  serialiseConfig(written, blob);

  DeviceConfig read;
  TEST_ASSERT_TRUE(deserialiseConfig(blob, sizeof(blob), read));
  TEST_ASSERT_EQUAL_UINT16(240, read.ledCount);
  TEST_ASSERT_EQUAL_UINT16(5000, read.budgetMa);
  TEST_ASSERT_EQUAL_UINT8(90, read.idleBrightness);
  TEST_ASSERT_FALSE(read.benchOnBoot);
}

void test_a_blob_from_another_build_is_refused_and_changes_nothing (void) {
  DeviceConfig written;
  written.ledCount = 240;
  uint8_t blob[kConfigBlobSize];
  serialiseConfig(written, blob);

  // Wrong version.
  uint8_t older[kConfigBlobSize];
  memcpy(older, blob, sizeof(blob));
  older[0] = 0;
  DeviceConfig config;
  TEST_ASSERT_FALSE(deserialiseConfig(older, sizeof(older), config));
  TEST_ASSERT_EQUAL_UINT16(108, config.ledCount);

  // Corrupted body: the checksum catches it.
  uint8_t bent[kConfigBlobSize];
  memcpy(bent, blob, sizeof(blob));
  bent[2] ^= 0xff;
  TEST_ASSERT_FALSE(deserialiseConfig(bent, sizeof(bent), config));
  TEST_ASSERT_EQUAL_UINT16(108, config.ledCount);

  // Wrong size, and nothing at all.
  TEST_ASSERT_FALSE(deserialiseConfig(blob, sizeof(blob) - 1, config));
  TEST_ASSERT_FALSE(deserialiseConfig(nullptr, kConfigBlobSize, config));
}

void test_a_stored_value_gets_the_same_validation_as_a_live_one (void) {
  // A blob whose checksum is right but whose LED count this firmware would
  // refuse over the wire must be refused here too - same trust boundary.
  uint8_t blob[kConfigBlobSize];
  DeviceConfig ok;
  serialiseConfig(ok, blob);
  blob[1] = 0x13; blob[2] = 0x88;                       // 5000 LEDs
  uint8_t sum = 0;
  for (size_t i = 0; i < kConfigBlobSize - 1; i++) sum = static_cast<uint8_t>(sum + blob[i]);
  blob[7] = static_cast<uint8_t>(sum ^ 0x5a);           // and a VALID checksum

  DeviceConfig config;
  TEST_ASSERT_FALSE(deserialiseConfig(blob, sizeof(blob), config));
  TEST_ASSERT_EQUAL_UINT16(108, config.ledCount);
}

int main (int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_the_led_count_is_configuration_not_a_define);
  RUN_TEST(test_an_out_of_range_value_is_REFUSED_not_clamped);
  RUN_TEST(test_a_wrong_length_is_refused);
  RUN_TEST(test_an_unknown_type_is_skipped_so_a_newer_host_still_works);
  RUN_TEST(test_actions_are_not_field_changes);
  RUN_TEST(test_a_body_with_several_tlvs_applies_all_of_them);
  RUN_TEST(test_a_truncated_tlv_stops_the_walk_instead_of_reading_past_the_end);
  RUN_TEST(test_one_bad_tlv_does_not_stop_the_good_ones_around_it);
  RUN_TEST(test_a_config_round_trips_through_the_blob);
  RUN_TEST(test_a_blob_from_another_build_is_refused_and_changes_nothing);
  RUN_TEST(test_a_stored_value_gets_the_same_validation_as_a_live_one);
  UNITY_END();
  return 0;
}
