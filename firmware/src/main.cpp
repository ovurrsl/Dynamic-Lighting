#include <Arduino.h>
#include <NeoPixelBus.h>
#include <Preferences.h>
#include <esp_timer.h>

#include <atomic>

#include "afx_config.h"
#include "afx_idle.h"
#include "afx_patterns.h"
#include "afx_protocol.h"
#include "afx_render.h"

/**
 * AmbiFlux firmware. The only layer that touches the board.
 *
 * Everything with an algorithm in it lives in lib/afx and is tested on the
 * host (`pio test -e native`, 37 tests). What is left here is wiring, and that
 * is on purpose: this file cannot be tested, so it should be as close to empty
 * of decisions as possible.
 *
 * Two tasks, pinned:
 *
 *   core 0  serial: read bytes, parse frames, publish keyframes
 *   core 1  output: 120 Hz esp_timer -> interpolate -> dither -> limit -> show
 *
 * The LED task gets core 1 to itself. On ESP32 the usual cause of RMT/I2S
 * corruption is other work - classically WiFi ISRs - landing on the same core;
 * WiFi is unlinked entirely (see platformio.ini) and nothing else goes here.
 */

namespace {

constexpr uint16_t kMaxLeds = AMBIFLUX_MAX_LEDS;
constexpr uint32_t kOutputHz = 120;
constexpr uint32_t kOutputPeriodUs = 1000000 / kOutputHz;   // 8333, not 8000
constexpr uint8_t kDataPin = 2;
constexpr uint32_t kTelemetryMs = 1000;

/**
 * RMT generates the bit timing in HARDWARE, which is the whole reason for this
 * chip over the RA4M1 boards. The difference that matters is the failure mode:
 * a starved RMT pauses mid-frame and the strip latches a short frame - visible,
 * recoverable, measurable - rather than violating the timing and latching
 * garbage.
 *
 * `CanShow()` tracks the 280 us latch gap internally, so nothing here has to.
 */
NeoPixelBus<NeoGrbFeature, NeoEsp32Rmt0Ws2812xMethod> strip(kMaxLeds, kDataPin);

/**
 * Three buffers, not two.
 *
 * Lock-free, allocation-free, and with no `noInterrupts()` anywhere: the
 * serial task always has a buffer to write that the output task is not
 * reading, so a host that outruns the output rate drops a stale frame by
 * itself instead of tearing one.
 */
struct Keyframe {
  uint16_t colours[kMaxLeds * 3];    // linear 16-bit
  uint16_t count = 0;
  uint32_t sequence = 0;             // carried end to end, for latency work
};

Keyframe buffers[3];
std::atomic<uint8_t> latestReady{255};
uint8_t writeSlot = 0;
uint8_t showingSlot = 255;

/** What the output task is gliding from and to. */
uint16_t current[kMaxLeds * 3];
uint16_t target[kMaxLeds * 3];
/**
 * What this board is driving. Loaded from NVS at boot, changed over AxC, and
 * saved only when asked - a flash write per frame would wear the part out.
 */
afx::DeviceConfig config;
Preferences prefs;
constexpr const char *kPrefsNamespace = "ambiflux";
constexpr const char *kPrefsKey = "cfg";

/**
 * LEDs currently being driven. Starts at the configured count so the bench run
 * and the idle animation cover the real strip, and follows each frame's header
 * once a host is talking - the host is the authority while it is there.
 */
uint16_t ledCount = config.ledCount;
uint32_t frameSequence = 0;

afx::FrameParser<kMaxLeds * 6 + afx::kCalibrationSize> parser;
afx::Interpolator interpolator;
afx::Dither<kMaxLeds * 3> dither;
afx::PowerLimiter limiter;
afx::IdleState idleState;

/**
 * The bench run, shown once at boot before any host has spoken.
 *
 * This replaces the rainbow for the first fifteen seconds, and it is a much
 * better use of them: the rainbow only says "the board is alive", while this
 * says the index order is right, the corners are where the layout thinks they
 * are, the channel order is RGB, the bottom end is not crushed, and the power
 * limiter engages. All of it with nothing but a USB cable.
 *
 * A host taking over cancels it; `ambiflux/AxC` type 0x02 starts it again.
 */
afx::Bench bench;
bool benchRunning = true;
uint32_t benchStartMs = 0;

struct Telemetry {
  uint32_t framesRx = 0;
  uint32_t framesShown = 0;
  uint32_t shortFrames = 0;     // CanShow() said no when the timer fired
};
Telemetry telemetry;

esp_timer_handle_t outputTimer = nullptr;
volatile bool outputDue = false;

/**
 * Fires the output. `esp_timer` and NOT vTaskDelayUntil: the FreeRTOS tick is
 * 1000 Hz, so it can only express whole milliseconds - 120 Hz is 8.333 ms,
 * which becomes 8 ms (125 Hz) or 9 ms (111 Hz) and a beat pattern between
 * them. Visible, and baffling to anyone trying to measure the output rate.
 */
void IRAM_ATTR onOutputTimer (void *) { outputDue = true; }

// Defined further down, beside the NVS handle they use; the control channel is
// what calls them, and it is declared first.
void applyConfig ();
void saveConfig ();

/**
 * The control channel: version, configuration, and whatever else the host asks
 * that is not a picture.
 *
 * It exists as a separate magic so a control message can never be mistaken for
 * pixels - which is exactly what would happen without this branch, since an
 * AxC frame's TLV body is the same bytes as a short 8-bit frame and would be
 * pushed straight onto the strip.
 */
void handleControl (const uint8_t *tlv, size_t length) {
  bool changed = false;
  bool save = false;
  bool report = false;
  unsigned refused = 0;

  afx::walkTlv(config, tlv, length, [&](uint8_t type, const uint8_t *, uint8_t, afx::Applied applied) {
    switch (applied) {
      case afx::Applied::Changed: changed = true; break;
      case afx::Applied::Invalid: refused++; break;
      case afx::Applied::Unknown: break;
      case afx::Applied::Action:
        switch (static_cast<afx::Tlv>(type)) {
          case afx::Tlv::Version: report = true; break;
          case afx::Tlv::QueryConfig: report = true; break;
          case afx::Tlv::RunBench: benchRunning = true; benchStartMs = millis(); break;
          case afx::Tlv::Save: save = true; break;
          case afx::Tlv::ResetDefaults: config = afx::DeviceConfig(); changed = true; save = true; break;
          default: break;
        }
        break;
    }
  });

  if (changed) applyConfig();
  if (save) saveConfig();

  if (report || changed || refused > 0) {
    Serial.printf(
        "{\"axc\":\"config\",\"v\":\"%s\",\"leds\":%u,\"budgetMa\":%u,"
        "\"idle\":%u,\"benchOnBoot\":%d,\"maxLeds\":%u,\"refused\":%u,\"saved\":%d}\n",
        AMBIFLUX_VERSION, static_cast<unsigned>(config.ledCount),
        static_cast<unsigned>(config.budgetMa), static_cast<unsigned>(config.idleBrightness),
        config.benchOnBoot ? 1 : 0, static_cast<unsigned>(afx::kConfigMaxLeds),
        refused, save ? 1 : 0);
  }
}

/** Publishes a parsed frame for the output task. Runs on the serial task. */
void publish (const afx::FrameParser<kMaxLeds * 6 + afx::kCalibrationSize>::Frame &frame) {
  if (frame.kind == afx::Kind::Axc) {
    handleControl(frame.payload, frame.length);
    return;                                   // not a picture; nothing to show
  }
  if (frame.count == 0 || frame.count > kMaxLeds) return;
  Keyframe &slot = buffers[writeSlot];
  slot.count = frame.count;
  slot.sequence = ++frameSequence;

  if (frame.kind == afx::Kind::Afx) {
    // 16-bit big-endian linear, straight through: no transfer function here,
    // because the host already averaged in linear light and the LED's duty is
    // proportional to the byte. Applying a curve here would apply it twice.
    for (uint16_t i = 0; i < frame.count * 3; i++) {
      slot.colours[i] = static_cast<uint16_t>(frame.payload[i * 2] << 8 | frame.payload[i * 2 + 1]);
    }
  } else {
    // Ada/Awa are 8-bit; widen so the rest of the pipeline has one type.
    for (uint16_t i = 0; i < frame.count * 3; i++) {
      slot.colours[i] = static_cast<uint16_t>(frame.payload[i] * 257);
    }
  }

  latestReady.store(writeSlot, std::memory_order_release);
  writeSlot = static_cast<uint8_t>((writeSlot + 1) % 3);
  if (writeSlot == showingSlot) writeSlot = static_cast<uint8_t>((writeSlot + 1) % 3);
  telemetry.framesRx++;
}

void serialTask (void *) {
  static uint8_t chunk[512];
  decltype(parser)::Frame frame;
  for (;;) {
    const int available = Serial.available();
    if (available <= 0) { vTaskDelay(1); continue; }
    const size_t read = Serial.readBytes(chunk, available > static_cast<int>(sizeof(chunk))
                                                  ? sizeof(chunk) : static_cast<size_t>(available));
    for (size_t i = 0; i < read; i++) {
      if (parser.push(chunk[i], frame)) {
        publish(frame);
        // A control message is not a picture: it must not keep the idle
        // animation away while nothing is actually lighting the strip.
        if (frame.kind != afx::Kind::Axc) idleState.frameArrived(millis());
      }
    }
  }
}

/** One output frame: glide, mix with idle, dither, limit, show. */
void render () {
  const uint32_t nowUs = static_cast<uint32_t>(esp_timer_get_time());
  const uint32_t nowMs = nowUs / 1000;

  const uint8_t ready = latestReady.exchange(255, std::memory_order_acquire);
  if (ready != 255) {
    const Keyframe &frame = buffers[ready];
    showingSlot = ready;
    ledCount = frame.count;
    // Where we are NOW becomes the start of the next glide, so a frame that
    // arrives mid-glide does not snap.
    for (uint16_t i = 0; i < ledCount * 3; i++) current[i] = target[i];
    for (uint16_t i = 0; i < ledCount * 3; i++) target[i] = frame.colours[i];
    interpolator.arrived(nowUs);
  }

  // A host always wins: the moment one is driving, the bench is over.
  if (benchRunning && idleState.hostActive(nowMs)) benchRunning = false;
  if (benchRunning && bench.at(nowMs - benchStartMs, ledCount) == afx::Pattern::None) benchRunning = false;

  const uint32_t t = interpolator.progress(nowUs);
  const uint16_t mix = idleState.hostMix(nowMs);

  uint32_t dutySum = 0;
  static uint8_t duty[kMaxLeds * 3];
  for (uint16_t led = 0; led < ledCount; led++) {
    uint8_t idleR = 0, idleG = 0, idleB = 0;
    if (!benchRunning && mix < 256) idleState.idlePixel(led, ledCount, nowMs, idleR, idleG, idleB);
    uint8_t benchR = 0, benchG = 0, benchB = 0;
    if (benchRunning) bench.pixel(nowMs - benchStartMs, led, ledCount, benchR, benchG, benchB);

    for (uint8_t channel = 0; channel < 3; channel++) {
      const uint16_t at = static_cast<uint16_t>(led * 3 + channel);
      uint8_t byte;
      if (benchRunning) {
        // Straight through, no dither and no interpolation: these patterns are
        // a measurement, and smoothing one is measuring the smoother.
        byte = channel == 0 ? benchR : channel == 1 ? benchG : benchB;
      } else {
        const uint16_t host = afx::glide(current[at], target[at], t);
        const uint16_t idle = static_cast<uint16_t>((channel == 0 ? idleR : channel == 1 ? idleG : idleB) * 257);
        const uint16_t blended = static_cast<uint16_t>(
            (static_cast<uint32_t>(host) * mix + static_cast<uint32_t>(idle) * (256 - mix)) >> 8);
        byte = dither.step(at, blended);
      }
      duty[at] = byte;
      dutySum += byte;
    }
  }

  // The limiter comes LAST and works on duty bytes: a WS2812B's current is
  // proportional to PWM duty, not to any perceptual value. And after the
  // dither, because it squeezes the bottom end the dither exists to protect.
  const float scale = limiter.update(dutySum, ledCount, 1.0f / kOutputHz);
  const uint16_t scale256 = static_cast<uint16_t>(scale * 256.0f + 0.5f);

  for (uint16_t led = 0; led < ledCount; led++) {
    strip.SetPixelColor(led, RgbColor(
        static_cast<uint8_t>(duty[led * 3 + 0] * scale256 >> 8),
        static_cast<uint8_t>(duty[led * 3 + 1] * scale256 >> 8),
        static_cast<uint8_t>(duty[led * 3 + 2] * scale256 >> 8)));
  }

  if (strip.CanShow()) {
    strip.Show();
    telemetry.framesShown++;
  } else {
    // The 280 us latch gap has not elapsed. Skipping is correct - forcing a
    // Show() here is what tears a frame.
    telemetry.shortFrames++;
  }
}

void reportTelemetry (uint32_t nowMs) {
  const afx::Stats &stats = parser.stats;
  Serial.printf(
      "{\"t\":%lu,\"v\":\"%s\",\"leds\":%u,\"rx\":%lu,\"shown\":%lu,\"short\":%lu,"
      "\"resyncs\":%lu,\"badChk\":%lu,\"countMismatch\":%lu,\"scale\":%.3f,\"host\":%d,\"up\":%lu}\n",
      static_cast<unsigned long>(nowMs), AMBIFLUX_VERSION, ledCount,
      static_cast<unsigned long>(telemetry.framesRx),
      static_cast<unsigned long>(telemetry.framesShown),
      static_cast<unsigned long>(telemetry.shortFrames),
      static_cast<unsigned long>(stats.resyncs),
      static_cast<unsigned long>(stats.badChecksum),
      static_cast<unsigned long>(stats.countMismatch),
      static_cast<double>(limiter.quantised()),
      idleState.hostActive(nowMs) ? 1 : 0,
      benchRunning ? 1 : 0,
      static_cast<unsigned long>(millis()));
}

void applyConfig () {
  afx::PowerModel model;
  model.budgetMa = static_cast<float>(config.budgetMa);
  limiter = afx::PowerLimiter(model);

  afx::IdlePolicy policy;
  policy.idleBrightness = config.idleBrightness;
  idleState = afx::IdleState(policy);

  ledCount = config.ledCount;
}

void saveConfig () {
  uint8_t blob[afx::kConfigBlobSize];
  afx::serialiseConfig(config, blob);
  prefs.putBytes(kPrefsKey, blob, sizeof(blob));
}

void loadConfig () {
  uint8_t blob[afx::kConfigBlobSize];
  const size_t read = prefs.getBytes(kPrefsKey, blob, sizeof(blob));
  // A blob this build cannot read leaves the defaults standing rather than
  // half-applying itself; deserialiseConfig does not touch `config` on failure.
  if (read == sizeof(blob)) afx::deserialiseConfig(blob, read, config);
  applyConfig();
}

}  // namespace

/** Pushes the configuration into the stages that were built from it. */
void setup () {
  Serial.begin(921600);
  prefs.begin(kPrefsNamespace, false);
  loadConfig();
  strip.Begin();
  strip.Show();
  benchRunning = config.benchOnBoot;
  benchStartMs = millis();

  // The serial reader runs on core 0 so core 1 belongs to the LEDs alone.
  xTaskCreatePinnedToCore(serialTask, "afx-serial", 4096, nullptr, 2, nullptr, 0);

  const esp_timer_create_args_t args = {
      .callback = &onOutputTimer, .arg = nullptr,
      .dispatch_method = ESP_TIMER_TASK, .name = "afx-output", .skip_unhandled_events = true};
  esp_timer_create(&args, &outputTimer);
  esp_timer_start_periodic(outputTimer, kOutputPeriodUs);
}

void loop () {
  static uint32_t lastReport = 0;
  if (outputDue) {
    outputDue = false;
    render();
  }
  const uint32_t nowMs = millis();
  if (nowMs - lastReport >= kTelemetryMs) {
    lastReport = nowMs;
    reportTelemetry(nowMs);
  }
}
