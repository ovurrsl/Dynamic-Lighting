#include <unity.h>
#include "afx_patterns.h"

using afx::Bench;
using afx::BenchTiming;
using afx::Pattern;

static const BenchTiming kT;
static const uint16_t kN = 108;

void test_the_sequence_runs_in_order_and_then_stops (void) {
  Bench bench;
  TEST_ASSERT_TRUE(bench.at(0, kN) == Pattern::Walk);
  TEST_ASSERT_TRUE(bench.at(kN * kT.walkStepMs - 1, kN) == Pattern::Walk);
  TEST_ASSERT_TRUE(bench.at(kN * kT.walkStepMs, kN) == Pattern::Channels);
  TEST_ASSERT_TRUE(bench.at(bench.durationMs(kN) - 1, kN) == Pattern::Flash);
  TEST_ASSERT_TRUE(bench.at(bench.durationMs(kN), kN) == Pattern::None);
  TEST_ASSERT_TRUE(bench.at(bench.durationMs(kN) + 100000, kN) == Pattern::None);
}

void test_the_walk_lights_exactly_one_led_and_reaches_every_one (void) {
  // This is what proves the index order and the physical corner positions; if
  // it skipped or doubled, the whole point would be lost.
  Bench bench;
  bool seen[kN] = {};
  for (uint32_t t = 0; t < kN * kT.walkStepMs; t += 10) {
    unsigned lit = 0;
    for (uint16_t i = 0; i < kN; i++) {
      uint8_t r = 0, g = 0, b = 0;
      bench.pixel(t, i, kN, r, g, b);
      if (r || g || b) { lit++; seen[i] = true; TEST_ASSERT_EQUAL_UINT8(255, r); }
    }
    TEST_ASSERT_EQUAL_UINT32(1, lit);
  }
  for (uint16_t i = 0; i < kN; i++) TEST_ASSERT_TRUE_MESSAGE(seen[i], "bir LED hiç yanmadı");
}

void test_the_channels_light_one_at_a_time_in_r_g_b_order (void) {
  Bench bench;
  const uint32_t base = kN * kT.walkStepMs;
  uint8_t r = 0, g = 0, b = 0;
  bench.pixel(base + 10, 0, kN, r, g, b);
  TEST_ASSERT_EQUAL_UINT8(255, r); TEST_ASSERT_EQUAL_UINT8(0, g); TEST_ASSERT_EQUAL_UINT8(0, b);
  bench.pixel(base + kT.channelMs + 10, 0, kN, r, g, b);
  TEST_ASSERT_EQUAL_UINT8(0, r); TEST_ASSERT_EQUAL_UINT8(255, g); TEST_ASSERT_EQUAL_UINT8(0, b);
  bench.pixel(base + kT.channelMs * 2 + 10, 0, kN, r, g, b);
  TEST_ASSERT_EQUAL_UINT8(0, r); TEST_ASSERT_EQUAL_UINT8(0, g); TEST_ASSERT_EQUAL_UINT8(255, b);
}

void test_the_ramp_is_monotone_grey_and_reaches_both_ends (void) {
  // A crushed bottom end or a non-monotone curve is exactly what this looks
  // for, so the test has to be strict about both.
  Bench bench;
  const uint32_t t = kN * kT.walkStepMs + kT.channelMs * 3 + 10;
  int previous = -1;
  uint8_t first = 255, last = 0;
  for (uint16_t i = 0; i < kN; i++) {
    uint8_t r = 0, g = 0, b = 0;
    bench.pixel(t, i, kN, r, g, b);
    TEST_ASSERT_EQUAL_UINT8(r, g);            // grey, so a colour cast shows
    TEST_ASSERT_EQUAL_UINT8(r, b);
    TEST_ASSERT_TRUE_MESSAGE(static_cast<int>(r) >= previous, "rampa geri düştü");
    previous = r;
    if (i == 0) first = r;
    last = r;
  }
  TEST_ASSERT_EQUAL_UINT8(0, first);          // starts at true black
  TEST_ASSERT_EQUAL_UINT8(255, last);         // and reaches full
}

void test_the_ramp_really_has_twenty_one_steps (void) {
  Bench bench;
  const uint32_t t = kN * kT.walkStepMs + kT.channelMs * 3 + 10;
  bool seen[256] = {};
  unsigned distinct = 0;
  for (uint16_t i = 0; i < kN; i++) {
    uint8_t r = 0, g = 0, b = 0;
    bench.pixel(t, i, kN, r, g, b);
    if (!seen[r]) { seen[r] = true; distinct++; }
  }
  TEST_ASSERT_EQUAL_UINT32(21, distinct);
}

void test_white_is_full_on_every_led (void) {
  // The power limiter must visibly engage here; at 108 LEDs this is ~6.5 A.
  Bench bench;
  const uint32_t t = kN * kT.walkStepMs + kT.channelMs * 3 + kT.rampMs + 10;
  for (uint16_t i = 0; i < kN; i += 17) {
    uint8_t r = 0, g = 0, b = 0;
    bench.pixel(t, i, kN, r, g, b);
    TEST_ASSERT_EQUAL_UINT8(255, r); TEST_ASSERT_EQUAL_UINT8(255, g); TEST_ASSERT_EQUAL_UINT8(255, b);
  }
}

void test_the_flash_alternates_at_one_hertz (void) {
  Bench bench;
  const uint32_t base = kN * kT.walkStepMs + kT.channelMs * 3 + kT.rampMs + kT.whiteMs;
  uint8_t r = 0, g = 0, b = 0;
  bench.pixel(base + 10, 0, kN, r, g, b);
  TEST_ASSERT_EQUAL_UINT8(255, r);                                  // on
  bench.pixel(base + kT.flashPeriodMs / 2 + 10, 0, kN, r, g, b);
  TEST_ASSERT_EQUAL_UINT8(0, r);                                    // off
  bench.pixel(base + kT.flashPeriodMs + 10, 0, kN, r, g, b);
  TEST_ASSERT_EQUAL_UINT8(255, r);                                  // on again
}

void test_an_empty_strip_does_not_divide_by_zero (void) {
  Bench bench;
  uint8_t r = 1, g = 1, b = 1;
  bench.pixel(0, 0, 0, r, g, b);
  TEST_ASSERT_EQUAL_UINT8(0, r); TEST_ASSERT_EQUAL_UINT8(0, g); TEST_ASSERT_EQUAL_UINT8(0, b);
  bench.pixel(500, 0, 1, r, g, b);      // and a one-LED strip still walks
  TEST_ASSERT_EQUAL_UINT8(255, r);
}

int main (int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_the_sequence_runs_in_order_and_then_stops);
  RUN_TEST(test_the_walk_lights_exactly_one_led_and_reaches_every_one);
  RUN_TEST(test_the_channels_light_one_at_a_time_in_r_g_b_order);
  RUN_TEST(test_the_ramp_is_monotone_grey_and_reaches_both_ends);
  RUN_TEST(test_the_ramp_really_has_twenty_one_steps);
  RUN_TEST(test_white_is_full_on_every_led);
  RUN_TEST(test_the_flash_alternates_at_one_hertz);
  RUN_TEST(test_an_empty_strip_does_not_divide_by_zero);
  UNITY_END();
  return 0;
}
