#include <unity.h>
#include <string.h>
#include "afx_protocol.h"

using afx::Kind;
using Parser = afx::FrameParser<108 * 6 + afx::kCalibrationSize>;

/**
 * Vectors generated from lib/engine/protocol.ts - the encoder this parser
 * actually receives from, and the one measured at 1018 frames with zero
 * rejects. A firmware parser tested only against its own idea of the format
 * is a parser that agrees with itself.
 */

static uint8_t payload[108 * 6];
static void fillPayload () {
  for (size_t i = 0; i < sizeof(payload); i++) payload[i] = static_cast<uint8_t>(i * 7 + 3);
}

/** Frames the encoder would send: header + payload + trailer. */
static size_t buildAfx (uint8_t *out) {
  const uint16_t n = 108;
  out[0] = 'A'; out[1] = 'f'; out[2] = 'x';
  out[3] = static_cast<uint8_t>((n - 1) >> 8);
  out[4] = static_cast<uint8_t>((n - 1) & 0xff);
  out[5] = static_cast<uint8_t>(out[3] ^ out[4] ^ afx::kHeaderXor);
  memcpy(out + 6, payload, sizeof(payload));
  afx::fletcher(payload, sizeof(payload), out + 6 + sizeof(payload));
  return 6 + sizeof(payload) + 3;
}

static bool feed (Parser &p, const uint8_t *bytes, size_t n, Parser::Frame &frame) {
  bool got = false;
  for (size_t i = 0; i < n; i++) if (p.push(bytes[i], frame)) got = true;
  return got;
}

void test_fletcher_matches_the_encoder (void) {
  fillPayload();
  uint8_t t[3];
  afx::fletcher(payload, sizeof(payload), t);
  // From lib/engine/protocol.ts fletcherAwa() over the same 648 bytes.
  TEST_ASSERT_EQUAL_UINT8(220, t[0]);
  TEST_ASSERT_EQUAL_UINT8(220, t[1]);
  TEST_ASSERT_EQUAL_UINT8(111, t[2]);
}

void test_position_wraps_at_256 (void) {
  // 648 payload bytes cross the wrap twice. A counter that keeps going past
  // 255 diverges from byte 256 on, so this is the test that catches it.
  fillPayload();
  uint8_t correct[3];
  afx::fletcher(payload, sizeof(payload), correct);

  uint8_t ext = 0, f1 = 0, f2 = 0;
  unsigned wide = 0;                       // deliberately NOT wrapping
  for (size_t i = 0; i < sizeof(payload); i++) {
    ext = static_cast<uint8_t>((ext + (payload[i] ^ (wide++ & 0xffff))) % 255);
    f1 = static_cast<uint8_t>((f1 + payload[i]) % 255);
    f2 = static_cast<uint8_t>((f2 + f1) % 255);
  }
  TEST_ASSERT_NOT_EQUAL(correct[2], ext);
}

void test_escape_never_emits_the_magic_byte (void) {
  // n = 739 is where this pattern makes the raw fletcherExt land on 0x41.
  static uint8_t p[739];
  for (size_t i = 0; i < sizeof(p); i++) p[i] = static_cast<uint8_t>(i * 13 + sizeof(p));
  uint8_t t[3];
  afx::fletcher(p, sizeof(p), t);
  TEST_ASSERT_EQUAL_UINT8(0xaa, t[2]);
  TEST_ASSERT_NOT_EQUAL(afx::kMagic, t[2]);
}

void test_a_clean_afx_frame_parses (void) {
  fillPayload();
  static uint8_t wire[657];
  const size_t n = buildAfx(wire);
  TEST_ASSERT_EQUAL_UINT32(657, n);       // the encoder's own frame size

  Parser p;
  Parser::Frame frame;
  TEST_ASSERT_TRUE(feed(p, wire, n, frame));
  TEST_ASSERT_EQUAL_UINT16(108, frame.count);
  TEST_ASSERT_EQUAL_UINT32(648, frame.length);
  TEST_ASSERT_TRUE(frame.kind == Kind::Afx);
  TEST_ASSERT_EQUAL_UINT8(payload[0], frame.payload[0]);
  TEST_ASSERT_EQUAL_UINT8(payload[647], frame.payload[647]);
  TEST_ASSERT_EQUAL_UINT32(1, p.stats.frames);
  TEST_ASSERT_EQUAL_UINT32(0, p.stats.resyncs);
  TEST_ASSERT_EQUAL_UINT32(0, p.stats.badChecksum);
}

void test_back_to_back_frames (void) {
  fillPayload();
  static uint8_t wire[657 * 3];
  const size_t one = buildAfx(wire);
  memcpy(wire + one, wire, one);
  memcpy(wire + one * 2, wire, one);
  Parser p;
  Parser::Frame frame;
  unsigned got = 0;
  for (size_t i = 0; i < one * 3; i++) if (p.push(wire[i], frame)) got++;
  TEST_ASSERT_EQUAL_UINT32(3, got);
  TEST_ASSERT_EQUAL_UINT32(0, p.stats.resyncs);
}

void test_a_stream_containing_AAfx_stays_in_sync (void) {
  // THE resync rule. A leading extra 'A' must not eat the real magic: the
  // mismatching byte is re-evaluated, and since it is 'A' the parser stays in
  // Magic1 instead of falling back to Magic0.
  fillPayload();
  static uint8_t wire[1 + 657];
  wire[0] = 'A';
  buildAfx(wire + 1);
  Parser p;
  Parser::Frame frame;
  TEST_ASSERT_TRUE(feed(p, wire, sizeof(wire), frame));
  TEST_ASSERT_EQUAL_UINT32(1, p.stats.frames);
}

void test_garbage_then_a_frame (void) {
  fillPayload();
  static uint8_t wire[64 + 657];
  for (size_t i = 0; i < 64; i++) wire[i] = static_cast<uint8_t>(i * 31 + 1);
  buildAfx(wire + 64);
  Parser p;
  Parser::Frame frame;
  TEST_ASSERT_TRUE(feed(p, wire, sizeof(wire), frame));
  TEST_ASSERT_EQUAL_UINT32(1, p.stats.frames);
}

void test_a_corrupted_payload_is_refused_and_the_next_frame_still_lands (void) {
  fillPayload();
  static uint8_t wire[657 * 2];
  const size_t one = buildAfx(wire);
  memcpy(wire + one, wire, one);
  wire[100] ^= 0xff;                       // flip a payload byte in frame 1
  Parser p;
  Parser::Frame frame;
  unsigned got = 0;
  for (size_t i = 0; i < one * 2; i++) if (p.push(wire[i], frame)) got++;
  TEST_ASSERT_EQUAL_UINT32(1, got);                    // only the good one
  TEST_ASSERT_EQUAL_UINT32(1, p.stats.badChecksum);
}

void test_a_bad_header_checksum_costs_bytes_not_a_payload (void) {
  fillPayload();
  static uint8_t wire[657 * 2];
  const size_t one = buildAfx(wire);
  memcpy(wire + one, wire, one);
  wire[5] ^= 0x01;                         // break chk on frame 1
  Parser p;
  Parser::Frame frame;
  unsigned got = 0;
  for (size_t i = 0; i < one * 2; i++) if (p.push(wire[i], frame)) got++;
  TEST_ASSERT_EQUAL_UINT32(1, got);
  TEST_ASSERT_EQUAL_UINT32(1, p.stats.countMismatch);
}

void test_a_header_larger_than_this_strip_is_refused (void) {
  // Six bytes of garbage spelling a valid 65536-LED header must not commit the
  // parser to 393 KB of payload.
  uint8_t wire[6] = {'A', 'f', 'x', 0xff, 0xff, 0};
  wire[5] = static_cast<uint8_t>(wire[3] ^ wire[4] ^ afx::kHeaderXor);
  Parser p;
  Parser::Frame frame;
  feed(p, wire, sizeof(wire), frame);
  TEST_ASSERT_EQUAL_UINT32(1, p.stats.countMismatch);
  TEST_ASSERT_EQUAL_UINT32(0, p.stats.frames);
}

void test_ada_has_no_trailer (void) {
  uint8_t wire[6 + 9];
  wire[0] = 'A'; wire[1] = 'd'; wire[2] = 'a';
  wire[3] = 0; wire[4] = 2;                              // 3 LEDs
  wire[5] = static_cast<uint8_t>(wire[3] ^ wire[4] ^ afx::kHeaderXor);
  for (size_t i = 0; i < 9; i++) wire[6 + i] = static_cast<uint8_t>(i + 1);
  Parser p;
  Parser::Frame frame;
  TEST_ASSERT_TRUE(feed(p, wire, sizeof(wire), frame));
  TEST_ASSERT_EQUAL_UINT16(3, frame.count);
  TEST_ASSERT_EQUAL_UINT32(9, frame.length);
  TEST_ASSERT_TRUE(frame.kind == Kind::Ada);
}

void test_awa_calibrated_magic_is_not_a_stray_A (void) {
  // 'AwA' announces four calibration bytes appended to the payload, and the
  // trailing 'A' must be matched BEFORE the resync rule sees it.
  const uint16_t n = 2;
  uint8_t body[2 * 3 + 4];
  for (size_t i = 0; i < sizeof(body); i++) body[i] = static_cast<uint8_t>(i * 5 + 2);
  uint8_t wire[6 + sizeof(body) + 3];
  wire[0] = 'A'; wire[1] = 'w'; wire[2] = 'A';
  wire[3] = 0; wire[4] = static_cast<uint8_t>(n - 1);
  wire[5] = static_cast<uint8_t>(wire[3] ^ wire[4] ^ afx::kHeaderXor);
  memcpy(wire + 6, body, sizeof(body));
  afx::fletcher(body, sizeof(body), wire + 6 + sizeof(body));
  Parser p;
  Parser::Frame frame;
  TEST_ASSERT_TRUE(feed(p, wire, sizeof(wire), frame));
  TEST_ASSERT_TRUE(frame.calibrated);
  TEST_ASSERT_EQUAL_UINT16(2, frame.count);
  TEST_ASSERT_EQUAL_UINT32(6, frame.length);     // payload only; calib excluded
  TEST_ASSERT_EQUAL_UINT32(0, p.stats.resyncs);
}

void test_a_frame_split_across_reads_parses (void) {
  // The port hands over whatever it has; a frame arrives in pieces.
  fillPayload();
  static uint8_t wire[657];
  const size_t n = buildAfx(wire);
  Parser p;
  Parser::Frame frame;
  unsigned got = 0;
  for (size_t i = 0; i < n; i++) if (p.push(wire[i], frame)) got++;   // 1 byte at a time
  TEST_ASSERT_EQUAL_UINT32(1, got);
}

int main (int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_fletcher_matches_the_encoder);
  RUN_TEST(test_position_wraps_at_256);
  RUN_TEST(test_escape_never_emits_the_magic_byte);
  RUN_TEST(test_a_clean_afx_frame_parses);
  RUN_TEST(test_back_to_back_frames);
  RUN_TEST(test_a_stream_containing_AAfx_stays_in_sync);
  RUN_TEST(test_garbage_then_a_frame);
  RUN_TEST(test_a_corrupted_payload_is_refused_and_the_next_frame_still_lands);
  RUN_TEST(test_a_bad_header_checksum_costs_bytes_not_a_payload);
  RUN_TEST(test_a_header_larger_than_this_strip_is_refused);
  RUN_TEST(test_ada_has_no_trailer);
  RUN_TEST(test_awa_calibrated_magic_is_not_a_stray_A);
  RUN_TEST(test_a_frame_split_across_reads_parses);
  return UNITY_END();
}
