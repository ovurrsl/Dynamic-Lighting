#pragma once
#include <atomic>
#include <stdint.h>

/**
 * The triple buffer between the task that receives frames and the task that
 * shows them.
 *
 * Lock-free, allocation-free, and with no `noInterrupts()` anywhere. The
 * writer always owns a slot the reader is not looking at, and a host that
 * outruns the output rate has its stale frame dropped rather than torn.
 *
 * Pulled out of main.cpp so it can be TESTED, and because the version that
 * lived there had a race the tests below would have caught: the writer chose
 * its next slot by reading the reader's "showing" index without any
 * synchronisation, and between the reader taking a slot and recording it the
 * writer could pick that same slot and write into the frame being shown.
 *
 * This is the textbook arrangement: one atomic byte names the slot that holds
 * the newest complete frame and carries a "fresh" bit; each side swaps its own
 * slot into that word and takes whatever was there. The three indices are a
 * permutation at every instant, so the writer's slot and the reader's slot can
 * never coincide, and neither side ever reads the other's index.
 */
namespace afx {

template <typename T>
class TripleBuffer {
 public:
  /** The slot the writer may fill. Stable until publish(). */
  T &writable () { return slots_[write_]; }

  /**
   * Hands the filled slot to the reader and takes a free one back.
   *
   * If the reader has not taken the previous frame yet, that frame is what
   * comes back and is overwritten next: a stale keyframe is dropped, which
   * is the correct fate for a picture nobody showed in time.
   */
  void publish () {
    const uint8_t previous = ready_.exchange(static_cast<uint8_t>(write_ | kFresh), std::memory_order_acq_rel);
    write_ = static_cast<uint8_t>(previous & kIndex);
  }

  /**
   * The newest frame published since the last take, or nullptr when there is
   * none. The pointer stays valid until the next take(): the writer cannot
   * reach this slot until then.
   */
  const T *take () {
    if ((ready_.load(std::memory_order_acquire) & kFresh) == 0) return nullptr;
    const uint8_t previous = ready_.exchange(read_, std::memory_order_acq_rel);
    read_ = static_cast<uint8_t>(previous & kIndex);
    return &slots_[read_];
  }

  /** The slot the reader last took. Only meaningful after a take() returned it. */
  const T &reading () const { return slots_[read_]; }

  /** True when a frame is waiting. For telemetry and tests; take() decides. */
  bool fresh () const { return (ready_.load(std::memory_order_acquire) & kFresh) != 0; }

  /** For tests: the three indices, to check they stay a permutation. */
  uint8_t writeIndex () const { return write_; }
  uint8_t readIndex () const { return read_; }
  uint8_t readyIndex () const { return static_cast<uint8_t>(ready_.load(std::memory_order_acquire) & kIndex); }

 private:
  static constexpr uint8_t kFresh = 0x80;
  static constexpr uint8_t kIndex = 0x03;

  T slots_[3];
  /** Slot 1 starts as the (stale) ready slot; 0 is the writer's, 2 the reader's. */
  std::atomic<uint8_t> ready_{1};
  uint8_t write_ = 0;
  uint8_t read_ = 2;
};

}  // namespace afx
