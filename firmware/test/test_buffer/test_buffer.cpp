#include <unity.h>
#include "afx_buffer.h"

using afx::TripleBuffer;

struct Frame {
  uint32_t sequence = 0;
};

static void assert_permutation (const TripleBuffer<Frame> &b) {
  const uint8_t w = b.writeIndex(), r = b.readIndex(), y = b.readyIndex();
  TEST_ASSERT_TRUE(w < 3 && r < 3 && y < 3);
  TEST_ASSERT_NOT_EQUAL(w, r);
  TEST_ASSERT_NOT_EQUAL(w, y);
  TEST_ASSERT_NOT_EQUAL(r, y);
}

void test_nothing_to_take_before_the_first_publish (void) {
  TripleBuffer<Frame> b;
  TEST_ASSERT_NULL(b.take());
  TEST_ASSERT_FALSE(b.fresh());
  assert_permutation(b);
}

void test_a_published_frame_is_taken_once (void) {
  TripleBuffer<Frame> b;
  b.writable().sequence = 7;
  b.publish();
  TEST_ASSERT_TRUE(b.fresh());
  const Frame *taken = b.take();
  TEST_ASSERT_NOT_NULL(taken);
  TEST_ASSERT_EQUAL_UINT32(7, taken->sequence);
  // The same frame is not handed out twice: a reader that runs faster than
  // the writer must see "nothing new", not the old picture again.
  TEST_ASSERT_NULL(b.take());
  TEST_ASSERT_EQUAL_UINT32(7, b.reading().sequence);
  assert_permutation(b);
}

void test_a_stale_frame_is_dropped_and_the_newest_is_taken (void) {
  // Two publishes with no take in between: the first is what a host that
  // outruns the output rate loses, and the reader gets the second.
  TripleBuffer<Frame> b;
  b.writable().sequence = 1;
  b.publish();
  b.writable().sequence = 2;
  b.publish();
  const Frame *taken = b.take();
  TEST_ASSERT_NOT_NULL(taken);
  TEST_ASSERT_EQUAL_UINT32(2, taken->sequence);
  TEST_ASSERT_NULL(b.take());
  assert_permutation(b);
}

void test_the_writer_never_gets_the_slot_the_reader_is_showing (void) {
  // The race the old scheme had: the reader takes a slot, and before it has
  // recorded which, the writer picks its next slot. Here the writer can only
  // ever swap with the READY word, never with the reader's slot, whatever
  // the interleaving - so a write never lands on the frame being shown.
  TripleBuffer<Frame> b;
  uint32_t sequence = 0;
  for (unsigned round = 0; round < 1000; round++) {
    const unsigned publishes = 1 + (round % 3);
    for (unsigned i = 0; i < publishes; i++) {
      b.writable().sequence = ++sequence;
      b.publish();
      assert_permutation(b);
      // Filling the next writable slot must not touch what the reader holds.
      TEST_ASSERT_NOT_EQUAL(b.writeIndex(), b.readIndex());
    }
    const Frame *taken = b.take();
    TEST_ASSERT_NOT_NULL(taken);
    TEST_ASSERT_EQUAL_UINT32(sequence, taken->sequence);
    assert_permutation(b);
    TEST_ASSERT_NOT_EQUAL(b.writeIndex(), b.readIndex());
    // The reader's slot stays intact through further writes.
    b.writable().sequence = 0xdead;
    TEST_ASSERT_EQUAL_UINT32(sequence, b.reading().sequence);
  }
}

int main (int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_nothing_to_take_before_the_first_publish);
  RUN_TEST(test_a_published_frame_is_taken_once);
  RUN_TEST(test_a_stale_frame_is_dropped_and_the_newest_is_taken);
  RUN_TEST(test_the_writer_never_gets_the_slot_the_reader_is_showing);
  UNITY_END();
  return 0;
}
