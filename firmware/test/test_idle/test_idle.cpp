#include <unity.h>
#include "afx_idle.h"

using afx::IdlePolicy;
using afx::IdleState;
using afx::hueToRgb;

void test_hue_covers_the_wheel_without_a_gap (void) {
  uint8_t r = 0, g = 0, b = 0;
  hueToRgb(0, r, g, b);
  TEST_ASSERT_EQUAL_UINT8(255, r); TEST_ASSERT_EQUAL_UINT8(0, g); TEST_ASSERT_EQUAL_UINT8(0, b);
  hueToRgb(512, r, g, b);
  TEST_ASSERT_EQUAL_UINT8(0, r); TEST_ASSERT_EQUAL_UINT8(255, g); TEST_ASSERT_EQUAL_UINT8(0, b);
  hueToRgb(1024, r, g, b);
  TEST_ASSERT_EQUAL_UINT8(0, r); TEST_ASSERT_EQUAL_UINT8(0, g); TEST_ASSERT_EQUAL_UINT8(255, b);
  // Every hue keeps one channel at full: the wheel never dips in brightness.
  for (uint16_t h = 0; h < 1536; h++) {
    hueToRgb(h, r, g, b);
    TEST_ASSERT_TRUE(r == 255 || g == 255 || b == 255);
  }
}

void test_a_cable_with_nothing_sending_is_not_a_host (void) {
  // The old sketch asked the USB stack, which cannot know this.
  IdleState idle;
  TEST_ASSERT_FALSE(idle.hostActive(0));
  TEST_ASSERT_FALSE(idle.hostActive(100000));
}

void test_a_host_that_stops_is_noticed_after_the_timeout (void) {
  IdleState idle;
  idle.frameArrived(1000);
  TEST_ASSERT_TRUE(idle.hostActive(1000));
  TEST_ASSERT_TRUE(idle.hostActive(2400));
  TEST_ASSERT_FALSE(idle.hostActive(2600));
}

void test_the_crossfade_runs_both_ways_and_never_cuts (void) {
  // Sampled the way the real loop samples it - every output period - because
  // hostMix() notices the edge when it is called, and calling it once after a
  // half-second jump would start the fade at that instant instead.
  IdleState idle;
  idle.frameArrived(0);

  uint16_t mix = 0;
  for (uint32_t t = 0; t <= 300; t += 8) mix = idle.hostMix(t);
  TEST_ASSERT_EQUAL_UINT16(256, mix);              // 200 ms in, all host

  // The host keeps talking, then stops at t = 1000.
  for (uint32_t t = 300; t <= 1000; t += 8) { idle.frameArrived(t); mix = idle.hostMix(t); }
  TEST_ASSERT_EQUAL_UINT16(256, mix);

  // Silence. Nothing happens until the timeout, and then it FADES.
  for (uint32_t t = 1000; t <= 2400; t += 8) mix = idle.hostMix(t);
  TEST_ASSERT_EQUAL_UINT16(256, mix);              // inside the 1500 ms grace

  uint16_t midFade = 256;
  for (uint32_t t = 2400; t <= 3000; t += 8) midFade = idle.hostMix(t);
  TEST_ASSERT_TRUE(midFade > 0);
  TEST_ASSERT_TRUE(midFade < 256);                 // mid-crossfade, not a cut

  for (uint32_t t = 3000; t <= 4000; t += 8) mix = idle.hostMix(t);
  TEST_ASSERT_EQUAL_UINT16(0, mix);                // all idle

  // And back: plugging in must not flash.
  uint16_t up = 0;
  for (uint32_t t = 4000; t <= 4100; t += 8) { idle.frameArrived(t); up = idle.hostMix(t); }
  TEST_ASSERT_TRUE(up > 0);
  TEST_ASSERT_TRUE(up < 256);                      // still climbing at 100 ms
  for (uint32_t t = 4100; t <= 4400; t += 8) { idle.frameArrived(t); up = idle.hostMix(t); }
  TEST_ASSERT_EQUAL_UINT16(256, up);
}

void test_a_board_that_has_never_seen_a_host_stays_lit (void) {
  // "The board is alive, your software is not" - that signal must not expire
  // before anyone has plugged anything in.
  IdleState idle;
  TEST_ASSERT_EQUAL_UINT8(IdlePolicy().idleBrightness, idle.idleBrightness(0));
  TEST_ASSERT_EQUAL_UINT8(IdlePolicy().idleBrightness, idle.idleBrightness(600000));
}

void test_the_rainbow_fades_out_rather_than_running_forever (void) {
  IdlePolicy policy;
  IdleState idle(policy);
  idle.frameArrived(1000);
  const uint32_t idleStart = 1000 + policy.hostTimeoutMs;
  TEST_ASSERT_EQUAL_UINT8(policy.idleBrightness, idle.idleBrightness(idleStart + 1000));
  TEST_ASSERT_EQUAL_UINT8(policy.idleBrightness, idle.idleBrightness(idleStart + policy.rainbowMs - 1));
  const uint8_t half = idle.idleBrightness(idleStart + policy.rainbowMs + policy.rainbowFadeMs / 2);
  TEST_ASSERT_TRUE(half > 0 && half < policy.idleBrightness);
  TEST_ASSERT_EQUAL_UINT8(0, idle.idleBrightness(idleStart + policy.rainbowMs + policy.rainbowFadeMs + 1));
}

void test_the_idle_rainbow_spreads_along_the_strip (void) {
  IdleState idle;
  uint8_t r0 = 0, g0 = 0, b0 = 0, r1 = 0, g1 = 0, b1 = 0;
  idle.idlePixel(0, 108, 0, r0, g0, b0);
  idle.idlePixel(54, 108, 0, r1, g1, b1);
  // Half a strip apart is half the wheel apart: it must not be one flat colour.
  TEST_ASSERT_TRUE(r0 != r1 || g0 != g1 || b0 != b1);
}

void test_a_new_policy_keeps_the_host_state (void) {
  // A brightness change over the control channel used to replace the whole
  // object: the strip forgot the host for a frame and restarted its fade.
  afx::IdleState state;
  state.frameArrived(1000);
  TEST_ASSERT_TRUE(state.hostActive(1500));
  afx::IdlePolicy policy;
  policy.idleBrightness = 200;
  state.setPolicy(policy);
  TEST_ASSERT_TRUE(state.hostActive(1500));
  TEST_ASSERT_EQUAL_UINT8(200, state.idleBrightness(1500));
}

int main (int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_hue_covers_the_wheel_without_a_gap);
  RUN_TEST(test_a_cable_with_nothing_sending_is_not_a_host);
  RUN_TEST(test_a_host_that_stops_is_noticed_after_the_timeout);
  RUN_TEST(test_the_crossfade_runs_both_ways_and_never_cuts);
  RUN_TEST(test_a_board_that_has_never_seen_a_host_stays_lit);
  RUN_TEST(test_the_rainbow_fades_out_rather_than_running_forever);
  RUN_TEST(test_the_idle_rainbow_spreads_along_the_strip);
  RUN_TEST(test_a_new_policy_keeps_the_host_state);
  UNITY_END();
  return 0;
}
