#include <unity.h>
#include "afx_render.h"

using afx::Dither;
using afx::Interpolator;
using afx::PowerLimiter;
using afx::PowerModel;
using afx::glide;

// ---------------------------------------------------------------------------
// Dither.
// ---------------------------------------------------------------------------

void test_dither_time_average_reaches_the_value_between_two_bytes (void) {
  // The whole point: a level that is not representable in 8 bits still comes
  // out right on average, which is what makes a fade to black smooth.
  Dither<1> d;
  const uint16_t value = 0x0180;              // 1.5 in the 0..255 duty domain
  uint32_t sum = 0;
  const unsigned frames = 2000;
  for (unsigned i = 0; i < frames; i++) sum += d.step(0, value);
  const float average = static_cast<float>(sum) / frames;
  TEST_ASSERT_FLOAT_WITHIN(0.01f, 1.5f, average);
}

void test_dither_only_ever_emits_the_two_neighbouring_bytes (void) {
  Dither<1> d;
  for (unsigned i = 0; i < 500; i++) {
    const uint8_t out = d.step(0, 0x0180);
    TEST_ASSERT_TRUE(out == 1 || out == 2);   // never a third value: no noise
  }
}

void test_an_exact_byte_never_dithers (void) {
  // 0x2A00 is exactly 42: a steady level must be steady, not flickering.
  Dither<1> d;
  for (unsigned i = 0; i < 100; i++) TEST_ASSERT_EQUAL_UINT8(42, d.step(0, 0x2A00));
}

void test_black_and_full_are_exact (void) {
  Dither<2> d;
  for (unsigned i = 0; i < 50; i++) {
    TEST_ASSERT_EQUAL_UINT8(0, d.step(0, 0));
    TEST_ASSERT_EQUAL_UINT8(255, d.step(1, 0xFF00));
  }
}

void test_channels_do_not_dither_in_phase (void) {
  // 108 LEDs crossing together would be a visible pulse across the strip.
  Dither<324> d;
  unsigned high = 0;
  for (size_t c = 0; c < 324; c++) if (d.step(c, 0x0180) == 2) high++;
  TEST_ASSERT_TRUE(high > 20);        // not all-low
  TEST_ASSERT_TRUE(high < 304);       // not all-high
}

// ---------------------------------------------------------------------------
// Interpolation.
// ---------------------------------------------------------------------------

void test_glide_endpoints_are_exact (void) {
  TEST_ASSERT_EQUAL_UINT16(1000, glide(1000, 5000, 0));
  TEST_ASSERT_EQUAL_UINT16(5000, glide(1000, 5000, 65536));
  TEST_ASSERT_EQUAL_UINT16(3000, glide(1000, 5000, 32768));
}

void test_glide_runs_downhill_too (void) {
  TEST_ASSERT_EQUAL_UINT16(5000, glide(5000, 1000, 0));
  TEST_ASSERT_EQUAL_UINT16(1000, glide(5000, 1000, 65536));
}

void test_interpolator_tracks_the_rate_the_host_actually_manages (void) {
  Interpolator interp;
  uint32_t t = 0;
  interp.arrived(t);
  uint32_t duration = 0;
  for (unsigned i = 0; i < 40; i++) { t += 16667; duration = interp.arrived(t); }   // 60 Hz
  TEST_ASSERT_UINT32_WITHIN(1500, 16667, duration);
}

void test_a_slow_host_glides_but_not_forever (void) {
  Interpolator interp;
  uint32_t t = 0;
  interp.arrived(t);
  uint32_t duration = 0;
  for (unsigned i = 0; i < 60; i++) { t += 500000; duration = interp.arrived(t); }  // 2 Hz
  TEST_ASSERT_EQUAL_UINT32(Interpolator::kMaxUs, duration);
}

void test_a_fast_host_never_glides_shorter_than_one_output_period (void) {
  Interpolator interp;
  uint32_t t = 0;
  interp.arrived(t);
  uint32_t duration = 0;
  for (unsigned i = 0; i < 40; i++) { t += 1000; duration = interp.arrived(t); }    // 1 kHz
  TEST_ASSERT_EQUAL_UINT32(Interpolator::kMinUs, duration);
}

void test_progress_saturates_and_holds (void) {
  Interpolator interp;
  uint32_t t = 1000;
  interp.arrived(t);
  for (unsigned i = 0; i < 30; i++) { t += 16667; interp.arrived(t); }
  const uint32_t base = t;
  TEST_ASSERT_EQUAL_UINT32(0, interp.progress(base));
  TEST_ASSERT_TRUE(interp.progress(base + 8000) > 0);
  // Past the glide it holds the target rather than running on.
  TEST_ASSERT_EQUAL_UINT32(65536, interp.progress(base + 1000000));
}

// ---------------------------------------------------------------------------
// Power limit.
// ---------------------------------------------------------------------------

void test_a_dim_scene_is_not_limited (void) {
  PowerLimiter limiter;
  TEST_ASSERT_EQUAL_FLOAT(1.0f, limiter.update(108u * 3u * 20u, 108, 0.008f));
}

void test_full_white_is_limited (void) {
  // 108 LEDs at full white draw about 6.5 A against a 1500 mA budget.
  PowerLimiter limiter;
  const float scale = limiter.update(108u * 3u * 255u, 108, 0.008f);
  TEST_ASSERT_TRUE(scale < 0.3f);
  TEST_ASSERT_TRUE(scale > 0.0f);
}

void test_black_is_not_free_and_the_model_says_so (void) {
  // The old formula said 0 mA at black. With a budget under the idle floor the
  // limiter must still clamp, which only a model with a floor can notice.
  PowerModel tight;
  tight.budgetMa = 50.0f;                    // below 108 * 1 mA idle
  PowerLimiter limiter(tight);
  const float scale = limiter.update(0, 108, 0.008f);
  TEST_ASSERT_EQUAL_FLOAT(0.0f, scale);
}

void test_it_attacks_instantly_and_releases_slowly (void) {
  PowerLimiter limiter;
  const float attacked = limiter.update(108u * 3u * 255u, 108, 0.008f);
  TEST_ASSERT_TRUE(attacked < 0.3f);          // one frame, all the way down

  // Now the scene goes dark. The scale must climb back gradually - an instant
  // return is exactly the pumping this replaces.
  const float afterOneFrame = limiter.update(0, 108, 0.008f);
  TEST_ASSERT_TRUE(afterOneFrame > attacked);
  TEST_ASSERT_TRUE(afterOneFrame < 0.6f);

  // And it must actually ARRIVE. Quantising the filter state instead of its
  // output stalls here at about 0.94 - the increment falls below half a step
  // and rounds back - leaving the strip permanently dim after one bright
  // scene. That is why the rounding lives in quantised(), not in update().
  float scale = afterOneFrame;
  for (unsigned i = 0; i < 200; i++) scale = limiter.update(0, 108, 0.008f);
  TEST_ASSERT_EQUAL_FLOAT(1.0f, scale);       // 1.6 s later, fully back
}

void test_the_dead_band_keeps_a_scene_on_the_budget_from_shimmering (void) {
  // Just over budget but inside the dead band: no action at all.
  PowerModel model;
  PowerLimiter limiter(model);
  const float floorMa = 108.0f * model.idleMaPerLed;
  const float wantMa = model.budgetMa * 1.01f;            // 1% over
  const uint32_t duty = static_cast<uint32_t>((wantMa - floorMa) * 765.0f / model.fullWhiteMa);
  TEST_ASSERT_EQUAL_FLOAT(1.0f, limiter.update(duty, 108, 0.008f));
}

void test_the_scale_is_quantised (void) {
  PowerLimiter limiter;
  const float scale = limiter.update(108u * 3u * 200u, 108, 0.008f);
  const float steps = scale * 256.0f;
  TEST_ASSERT_FLOAT_WITHIN(0.001f, steps, static_cast<float>(static_cast<int>(steps + 0.5f)));
}

int main (int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_dither_time_average_reaches_the_value_between_two_bytes);
  RUN_TEST(test_dither_only_ever_emits_the_two_neighbouring_bytes);
  RUN_TEST(test_an_exact_byte_never_dithers);
  RUN_TEST(test_black_and_full_are_exact);
  RUN_TEST(test_channels_do_not_dither_in_phase);
  RUN_TEST(test_glide_endpoints_are_exact);
  RUN_TEST(test_glide_runs_downhill_too);
  RUN_TEST(test_interpolator_tracks_the_rate_the_host_actually_manages);
  RUN_TEST(test_a_slow_host_glides_but_not_forever);
  RUN_TEST(test_a_fast_host_never_glides_shorter_than_one_output_period);
  RUN_TEST(test_progress_saturates_and_holds);
  RUN_TEST(test_a_dim_scene_is_not_limited);
  RUN_TEST(test_full_white_is_limited);
  RUN_TEST(test_black_is_not_free_and_the_model_says_so);
  RUN_TEST(test_it_attacks_instantly_and_releases_slowly);
  RUN_TEST(test_the_dead_band_keeps_a_scene_on_the_budget_from_shimmering);
  RUN_TEST(test_the_scale_is_quantised);
  UNITY_END();
  return 0;
}
