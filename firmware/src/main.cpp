#include <Arduino.h>
#include <NeoPixelBus.h>
#include <unistd.h>
#include <Preferences.h>
#include <esp_timer.h>

#include <atomic>

#include "afx_config.h"
#include "afx_idle.h"
#include "afx_net.h"
#include "afx_patterns.h"
#include "afx_protocol.h"
#include "afx_render.h"

/*
 * The network build is a SEPARATE build, not a runtime switch, and the reason
 * is physical rather than tidy: the USB build unlinks the WiFi stack entirely
 * because WiFi interrupt work on the LED's core is the usual cause of RMT
 * corruption on an ESP32. Linking it back is a real cost, and a board driven
 * over a cable should not pay it. `-D AMBIFLUX_NET` is what asks for it.
 */
#if defined(AMBIFLUX_NET)
#include <WiFi.h>
#include <esp_http_server.h>
#endif

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
 * The WebSocket endpoint, matching what the panel dials.
 *
 * `/afx` rather than `/`, so a future status page or an OTA endpoint can live
 * on the same server without the pixel socket having claimed the root.
 */
constexpr const char *kWsPath = "/afx";

/**
 * RMT generates the bit timing in HARDWARE, which is the whole reason for this
 * chip over the RA4M1 boards. The difference that matters is the failure mode:
 * a starved RMT pauses mid-frame and the strip latches a short frame - visible,
 * recoverable, measurable - rather than violating the timing and latching
 * garbage.
 *
 * `CanShow()` tracks the 280 us latch gap internally, so nothing here has to.
 */
/**
 * The output method, chosen at build time.
 *
 * For 108 LEDs the data time is 3.24 ms against an 8.33 ms budget at 120 Hz, so
 * there is no throughput problem here at all and the parallel/multi-segment
 * tricks that HyperSerialESP32 uses for large rigs buy us nothing. The only
 * thing that matters is whether the peripheral is ever STARVED mid-frame, which
 * latches a short frame the eye sees as a flicker.
 *
 * Two families, and the reason both are here rather than one:
 *
 * - RMT generates the bit timing in hardware. Without DMA it is fed by a refill
 *   interrupt, and recent ESP32 cores are documented to have trouble with that
 *   interrupt's frequency; the standing community advice is to prefer a
 *   DMA-fed peripheral for exactly this reason.
 * - The DMA-fed alternative is fed entirely by DMA, so there is no refill
 *   interrupt to miss.
 *
 * WHICH DMA peripheral is board-specific, and the usual advice is wrong for
 * this one. The common answer is "use I2S", but NeoPixelBus's `NeoEsp32I2s*`
 * methods are compiled out on the ESP32-S3 (`!defined(CONFIG_IDF_TARGET_ESP32S3)`
 * guards the whole header): the S3 replaced that path with the LCD peripheral,
 * and the S3's methods are `NeoEsp32LcdX8`/`X16`. Those are parallel-only - the
 * smallest is eight channels - so a single strip uses channel 0 and leaves the
 * rest idle. That is not waste worth avoiding; it is the only DMA path the S3
 * offers here.
 *
 * Which is actually better on THIS board is a measurement, not a reading, and
 * the firmware already counts what settles it: `shortFrames` in the telemetry
 * is the number of times the strip was not ready when the timer fired. Build
 * one, soak it, read the counter, build the other. RMT stays the default
 * because it costs one pin and no peripheral-wide constraints;
 * `-D AMBIFLUX_OUTPUT_DMA` swaps it without touching another line.
 */
#if defined(AMBIFLUX_OUTPUT_DMA)
using AmbifluxMethod = NeoEsp32LcdX8Ws2812xMethod;
#else
using AmbifluxMethod = NeoEsp32Rmt0Ws2812xMethod;
#endif

NeoPixelBus<NeoGrbFeature, AmbifluxMethod> strip(kMaxLeds, kDataPin);

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

using Parser = afx::FrameParser<kMaxLeds * 6 + afx::kCalibrationSize>;
Parser parser;

#if defined(AMBIFLUX_NET)
/**
 * The network's own parser.
 *
 * NOT the serial one. A stream parser is a state machine over one stream;
 * feeding it from two sources would interleave them and desynchronise both,
 * which is the kind of fault that shows up as an occasional dropped frame and
 * takes a week to find. Two instances cost about 3 KB each on a part with 512.
 */
Parser netParser;
afx::NetworkConfig netConfig;
constexpr const char *kNetPrefsKey = "net";
httpd_handle_t httpServer = nullptr;
std::atomic<uint32_t> wsClients{0};
bool wifiStarted = false;
#endif
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
#if defined(AMBIFLUX_NET)
void applyNetwork ();
void saveNetwork ();
#endif

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

#if defined(AMBIFLUX_NET)
  bool netChanged = false;
#endif

  afx::walkTlv(config, tlv, length, [&](uint8_t type, const uint8_t *value, uint8_t size, afx::Applied applied) {
    switch (applied) {
      case afx::Applied::Changed: changed = true; break;
      case afx::Applied::Invalid: refused++; break;
      case afx::Applied::Unknown:
        // Not a device field. The network table is walked from here rather than
        // from its own magic, so a host sends one AxC frame and the board sorts
        // it out - and a USB build simply does not know these types, which is
        // the correct answer there: it has no radio to point at a network.
#if defined(AMBIFLUX_NET)
        switch (afx::applyNetTlv(netConfig, type, value, size)) {
          case afx::Applied::Changed: netChanged = true; break;
          case afx::Applied::Invalid: refused++; break;
          case afx::Applied::Action: report = true; break;
          case afx::Applied::Unknown: break;
        }
#else
        (void) value;
        (void) size;
#endif
        break;
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
#if defined(AMBIFLUX_NET)
  if (netChanged) applyNetwork();
  if (netChanged && save) saveNetwork();
  if (netChanged) report = true;
#endif

  if (report || changed || refused > 0) {
    Serial.printf(
        "{\"axc\":\"config\",\"v\":\"%s\",\"leds\":%u,\"budgetMa\":%u,"
        "\"idle\":%u,\"benchOnBoot\":%d,\"maxLeds\":%u,\"refused\":%u,\"saved\":%d",
        AMBIFLUX_VERSION, static_cast<unsigned>(config.ledCount),
        static_cast<unsigned>(config.budgetMa), static_cast<unsigned>(config.idleBrightness),
        config.benchOnBoot ? 1 : 0, static_cast<unsigned>(afx::kConfigMaxLeds),
        refused, save ? 1 : 0);
#if defined(AMBIFLUX_NET)
    // The SSID and the address, never the passphrase. The board has no reason
    // to read one back, and a credential printed on a telemetry line ends up in
    // whatever log the panel or a support ticket happens to keep.
    Serial.printf(",\"net\":{\"enabled\":%d,\"ssid\":\"%s\",\"ip\":\"%s\",\"path\":\"%s\"}",
                  netConfig.enabled ? 1 : 0, netConfig.ssid,
                  WiFi.isConnected() ? WiFi.localIP().toString().c_str() : "", kWsPath);
#endif
    Serial.print("}\n");
  }
}

#if defined(AMBIFLUX_NET)
/**
 * Guards the triple buffer's WRITER, and only in the network build.
 *
 * The lock-free triple buffer is single-writer by construction: the serial task
 * always has a slot the output task is not reading. A second source publishing
 * concurrently would break that invariant and tear a frame. A mutex - not a
 * spinlock, and never `noInterrupts()` - is the honest fix, and it is held only
 * for the copy.
 */
SemaphoreHandle_t publishLock = nullptr;
struct PublishGuard {
  PublishGuard () { if (publishLock != nullptr) xSemaphoreTake(publishLock, portMAX_DELAY); }
  ~PublishGuard () { if (publishLock != nullptr) xSemaphoreGive(publishLock); }
};
#define AFX_PUBLISH_GUARD PublishGuard guard_
#else
#define AFX_PUBLISH_GUARD do { } while (0)
#endif

/** Publishes a parsed frame for the output task. Runs on whichever task read it. */
void publish (const Parser::Frame &frame) {
  if (frame.kind == afx::Kind::Axc) {
    handleControl(frame.payload, frame.length);
    return;                                   // not a picture; nothing to show
  }
  if (frame.count == 0 || frame.count > kMaxLeds) return;
  AFX_PUBLISH_GUARD;
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
  Parser::Frame frame;
  for (;;) {
    const int available = Serial.available();
    if (available <= 0) {
      /*
       * 100 us, not vTaskDelay(1).
       *
       * The FreeRTOS tick is 1 kHz, so vTaskDelay(1) sleeps up to a full
       * millisecond - which is 12% of a 120 Hz frame period added to the
       * latency of every frame, for nothing. usleep() here yields the core
       * without rounding up to a tick.
       *
       * Not a busy spin either: this task shares core 0 with the USB stack that
       * is trying to hand it the very bytes it is waiting for.
       */
      usleep(100);
      continue;
    }
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

#if defined(AMBIFLUX_NET)

// ---------------------------------------------------------------------------
// The WebSocket server.
// ---------------------------------------------------------------------------

/**
 * The same bytes the serial port carries, over a socket.
 *
 * That sentence is the whole design and it is meant literally: the handler
 * below does not know what a frame is. It pushes the bytes it received into the
 * same `FrameParser` the cable feeds, and a parsed frame goes to the same
 * `publish`. No second protocol, no second parser, no second set of tests - and
 * the Fletcher trailer, the resync rule and the magic dispatch are covered once.
 *
 * The server is the IDF's own `esp_http_server`, deliberately, rather than one
 * of the async web-server libraries. It is already in the framework, so the
 * network build adds no third-party dependency to a product whose build has to
 * be reproducible; and its task is one we can place, which matters here more
 * than usual (see `core_id` below).
 */
constexpr size_t kWsMaxFrame = kMaxLeds * 6 + afx::kCalibrationSize + 16;

esp_err_t wsHandler (httpd_req_t *req) {
  if (req->method == HTTP_GET) {
    // The handshake. Nothing to read yet.
    wsClients.fetch_add(1, std::memory_order_relaxed);
    return ESP_OK;
  }

  httpd_ws_frame_t ws = {};
  ws.type = HTTPD_WS_TYPE_BINARY;
  // Length first, payload second: the API wants the size before it will fill a
  // buffer, and asking for the payload blind is how a long frame smashes a
  // stack allocation.
  esp_err_t err = httpd_ws_recv_frame(req, &ws, 0);
  if (err != ESP_OK) return err;
  if (ws.len == 0 || ws.len > kWsMaxFrame) return ESP_OK;   // ignored, not fatal

  /*
   * One static buffer, which is safe because `esp_http_server` dispatches every
   * handler from its single server task. That is a real assumption, so it is
   * written down here rather than left to be inferred - if this server is ever
   * given more than one task, this buffer needs a lock or a stack of its own.
   */
  static uint8_t payload[kWsMaxFrame];
  ws.payload = payload;
  err = httpd_ws_recv_frame(req, &ws, kWsMaxFrame);
  if (err != ESP_OK) return err;
  if (ws.type != HTTPD_WS_TYPE_BINARY) return ESP_OK;       // text is not pixels

  Parser::Frame frame;
  const uint32_t nowMs = millis();
  for (size_t i = 0; i < ws.len; i++) {
    if (netParser.push(payload[i], frame)) {
      publish(frame);
      if (frame.kind != afx::Kind::Axc) idleState.frameArrived(nowMs);
    }
  }
  return ESP_OK;
}

void startServer () {
  if (httpServer != nullptr) return;
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  /*
   * Core 0, with the serial reader, so core 1 stays the LEDs' alone. The whole
   * reason the USB build unlinks WiFi is that its work on the LED core starves
   * the RMT peripheral mid-frame; pinning what we can pin is the part of that
   * we control.
   */
  config.core_id = 0;
  config.task_priority = 3;
  config.stack_size = 8192;
  config.max_open_sockets = 4;
  config.lru_purge_enable = true;
  if (httpd_start(&httpServer, &config) != ESP_OK) {
    httpServer = nullptr;
    return;
  }
  const httpd_uri_t route = {
      .uri = kWsPath, .method = HTTP_GET, .handler = wsHandler, .user_ctx = nullptr,
      .is_websocket = true, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};
  httpd_register_uri_handler(httpServer, &route);
}

void stopServer () {
  if (httpServer == nullptr) return;
  httpd_stop(httpServer);
  httpServer = nullptr;
  wsClients.store(0, std::memory_order_relaxed);
}

/** Brings the radio to match the configuration, in either direction. */
void applyNetwork () {
  if (!afx::netConfigured(netConfig)) {
    stopServer();
    if (wifiStarted) {
      WiFi.disconnect(true);
      WiFi.mode(WIFI_OFF);
      wifiStarted = false;
    }
    return;
  }
  stopServer();                       // the address may be about to change
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);               // sleep is latency, and this is a live link
  WiFi.begin(netConfig.ssid, netConfig.passphrase[0] == '\0' ? nullptr : netConfig.passphrase);
  wifiStarted = true;
}

void saveNetwork () {
  uint8_t blob[afx::kNetBlobSize];
  afx::serialiseNet(netConfig, blob);
  prefs.putBytes(kNetPrefsKey, blob, sizeof(blob));
}

void loadNetwork () {
  uint8_t blob[afx::kNetBlobSize];
  const size_t read = prefs.getBytes(kNetPrefsKey, blob, sizeof(blob));
  if (read == sizeof(blob)) afx::deserialiseNet(blob, read, netConfig);
}

/**
 * Starts and stops the server as the association comes and goes.
 *
 * Polled rather than driven by an event handler on purpose: this runs on the
 * main loop beside the telemetry, so it cannot land in the middle of an output
 * frame, and half a second of delay in noticing a reconnection costs nothing.
 */
void serviceNetwork (uint32_t nowMs) {
  static uint32_t lastCheck = 0;
  if (nowMs - lastCheck < 500) return;
  lastCheck = nowMs;
  if (!wifiStarted) return;
  if (WiFi.isConnected()) {
    startServer();
  } else if (httpServer != nullptr) {
    // The socket is gone with the association; the host's own sink reconnects
    // with backoff, so there is nothing to hold open here.
    stopServer();
  }
}

#endif  // AMBIFLUX_NET

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

  /*
   * Straight into the strip's own buffer rather than through SetPixelColor().
   *
   * SetPixelColor is a bounds check, an RgbColor construction and a per-pixel
   * dispatch; at 108 LEDs and 120 Hz that is thirteen thousand of each per
   * second, spent producing bytes we already have laid out. Pixels() hands back
   * the buffer the DMA will read, and the feature's own byte order is what
   * decides where each channel goes - so this writes GRB because NeoGrbFeature
   * is what the strip was declared with, and changing that declaration changes
   * this loop with it.
   *
   * Dirty() is what SetPixelColor would have set; without it Show() believes
   * the buffer is unchanged and sends nothing.
   */
  uint8_t *const pixels = strip.Pixels();
  for (uint16_t led = 0; led < ledCount; led++) {
    const uint16_t src = static_cast<uint16_t>(led * 3);
    const uint16_t dst = static_cast<uint16_t>(led * 3);
    const uint8_t r = static_cast<uint8_t>(duty[src + 0] * scale256 >> 8);
    const uint8_t g = static_cast<uint8_t>(duty[src + 1] * scale256 >> 8);
    const uint8_t b = static_cast<uint8_t>(duty[src + 2] * scale256 >> 8);
    pixels[dst + 0] = g;
    pixels[dst + 1] = r;
    pixels[dst + 2] = b;
  }
  strip.Dirty();

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
#if defined(AMBIFLUX_NET)
  // On its own line rather than merged into the object above: a host that has
  // never heard of the network build still parses the first line unchanged.
  Serial.printf("{\"t\":%lu,\"net\":{\"up\":%d,\"ip\":\"%s\",\"ws\":%lu,\"clients\":%lu}}\n",
                static_cast<unsigned long>(nowMs), WiFi.isConnected() ? 1 : 0,
                WiFi.isConnected() ? WiFi.localIP().toString().c_str() : "",
                static_cast<unsigned long>(httpServer != nullptr ? 1 : 0),
                static_cast<unsigned long>(wsClients.load(std::memory_order_relaxed)));
#endif
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
#if defined(AMBIFLUX_NET)
  publishLock = xSemaphoreCreateMutex();
  loadNetwork();
  applyNetwork();
#endif
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
#if defined(AMBIFLUX_NET)
  serviceNetwork(nowMs);
#endif
  if (nowMs - lastReport >= kTelemetryMs) {
    lastReport = nowMs;
    reportTelemetry(nowMs);
  }
}
