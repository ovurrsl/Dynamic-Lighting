#include "tusb.h"
#include <Adafruit_NeoPixel.h>
#include <HID.h>
#include <math.h>

#define LED_COUNT 108
#define DATA_PIN 6
#define UPDATE_LATENCY_MS 1

Adafruit_NeoPixel strip(LED_COUNT, DATA_PIN, NEO_GRB + NEO_KHZ800);

#define LAMP_NOT_PROGRAMMABLE 0x00
#define LAMP_IS_PROGRAMMABLE 0x01
#define LAMP_UPDATE_FLAG_UPDATE_COMPLETE 0x01
#define MICROMETERS_FROM_MM(x) ((uint32_t)(x) * 1000UL)
#define MICROSECONDS_FROM_MS(x) ((uint32_t)(x) * 1000UL)

enum LampPurposeKind : uint32_t {
  LampPurposeControl = 1,
  LampPurposeAccent = 2,
  LampPurposeBranding = 4,
  LampPurposeStatus = 8,
  LampPurposeIllumination = 16,
  LampPurposePresentation = 32,
};

enum LampArrayKind : uint32_t {
  LampArrayKindKeyboard = 1,
  LampArrayKindMouse = 2,
  LampArrayKindGameController = 3,
  LampArrayKindPeripheral = 4,
  LampArrayKindScene = 5,
  LampArrayKindNotification = 6,
  LampArrayKindChassis = 7,
  LampArrayKindWearable = 8,
  LampArrayKindFurniture = 9,
  LampArrayKindArt = 10,
};

struct __attribute__((packed)) LampArrayColor {
  uint8_t RedChannel;
  uint8_t GreenChannel;
  uint8_t BlueChannel;
  uint8_t IntensityChannel;
};

struct __attribute__((packed)) LampAttributes {
  uint16_t LampId;
  uint32_t PositionXInMicrometers;
  uint32_t PositionYInMicrometers;
  uint32_t PositionZInMicrometers;
  uint32_t UpdateLatencyInMicroseconds;
  uint32_t LampPurposes;
  uint8_t RedLevelCount;
  uint8_t GreenLevelCount;
  uint8_t BlueLevelCount;
  uint8_t IntensityLevelCount;
  uint8_t IsProgrammable;
  uint8_t LampKey;
};

#define LAMP_ARRAY_ATTRIBUTES_REPORT_ID 1
struct __attribute__((packed)) LampArrayAttributesReport {
  uint8_t ReportId;
  uint16_t LampCount;
  uint32_t BoundingBoxWidthInMicrometers;
  uint32_t BoundingBoxHeightInMicrometers;
  uint32_t BoundingBoxDepthInMicrometers;
  uint32_t LampArrayKindValue;
  uint32_t MinUpdateIntervalInMicroseconds;
};

#define LAMP_ATTRIBUTES_REQUEST_REPORT_ID 2
struct __attribute__((packed)) LampAttributesRequestReport {
  uint8_t ReportId;
  uint16_t LampId;
};

#define LAMP_ATTRIBUTES_RESPONSE_REPORT_ID 3
struct __attribute__((packed)) LampAttributesResponseReport {
  uint8_t ReportId;
  LampAttributes Attributes;
};

#define LAMP_MULTI_UPDATE_REPORT_ID 4
#define LAMP_MULTI_UPDATE_LAMP_COUNT 8
struct __attribute__((packed)) LampMultiUpdateReport {
  uint8_t ReportId;
  uint8_t LampCount;
  uint8_t LampUpdateFlags;
  uint16_t LampIds[LAMP_MULTI_UPDATE_LAMP_COUNT];
  LampArrayColor UpdateColors[LAMP_MULTI_UPDATE_LAMP_COUNT];
};
static_assert(
    sizeof(LampMultiUpdateReport) <= 64,
    "Lamp multi-update HID report must fit in a full-speed USB packet.");

#define LAMP_RANGE_UPDATE_REPORT_ID 5
struct __attribute__((packed)) LampRangeUpdateReport {
  uint8_t ReportId;
  uint8_t LampUpdateFlags;
  uint16_t LampIdStart;
  uint16_t LampIdEnd;
  LampArrayColor UpdateColor;
};

#define LAMP_ARRAY_CONTROL_REPORT_ID 6
struct __attribute__((packed)) LampArrayControlReport {
  uint8_t ReportId;
  uint8_t AutonomousMode;
};

static const uint8_t LampArrayReportDescriptor[] PROGMEM = {
    0x05, 0x59, 0x09, 0x01, 0xA1, 0x01, 0x85, 0x01, 0x09, 0x02, 0xA1, 0x02,
    0x09, 0x03, 0x15, 0x00, 0x27, 0xFF, 0xFF, 0x00, 0x00, 0x95, 0x01, 0x75,
    0x10, 0xB1, 0x03, 0x09, 0x04, 0x09, 0x05, 0x09, 0x06, 0x09, 0x07, 0x09,
    0x08, 0x27, 0xFF, 0xFF, 0xFF, 0x7F, 0x95, 0x05, 0x75, 0x20, 0xB1, 0x03,
    0xC0, 0x85, 0x02, 0x09, 0x20, 0xA1, 0x02, 0x09, 0x21, 0x27, 0xFF, 0xFF,
    0x00, 0x00, 0x95, 0x01, 0x75, 0x10, 0xB1, 0x02, 0xC0, 0x85, 0x03, 0x09,
    0x22, 0xA1, 0x02, 0x09, 0x21, 0xB1, 0x02, 0x09, 0x23, 0x09, 0x24, 0x09,
    0x25, 0x09, 0x27, 0x09, 0x26, 0x27, 0xFF, 0xFF, 0xFF, 0x7F, 0x95, 0x05,
    0x75, 0x20, 0xB1, 0x02, 0x09, 0x28, 0x09, 0x29, 0x09, 0x2A, 0x09, 0x2B,
    0x09, 0x2C, 0x09, 0x2D, 0x26, 0xFF, 0x00, 0x95, 0x06, 0x75, 0x08, 0xB1,
    0x02, 0xC0, 0x85, 0x04, 0x09, 0x50, 0xA1, 0x02, 0x09, 0x03, 0x25, 0x08,
    0x95, 0x01, 0xB1, 0x02, 0x09, 0x55, 0x25, 0x01, 0xB1, 0x02, 0x09, 0x21,
    0x27, 0xFF, 0xFF, 0x00, 0x00, 0x95, 0x08, 0x75, 0x10, 0xB1, 0x02, 0x09,
    0x51, 0x09, 0x52, 0x09, 0x53, 0x09, 0x54, 0x09, 0x51, 0x09, 0x52, 0x09,
    0x53, 0x09, 0x54, 0x09, 0x51, 0x09, 0x52, 0x09, 0x53, 0x09, 0x54, 0x09,
    0x51, 0x09, 0x52, 0x09, 0x53, 0x09, 0x54, 0x09, 0x51, 0x09, 0x52, 0x09,
    0x53, 0x09, 0x54, 0x09, 0x51, 0x09, 0x52, 0x09, 0x53, 0x09, 0x54, 0x09,
    0x51, 0x09, 0x52, 0x09, 0x53, 0x09, 0x54, 0x09, 0x51, 0x09, 0x52, 0x09,
    0x53, 0x09, 0x54, 0x26, 0xFF, 0x00, 0x95, 0x20, 0x75, 0x08, 0xB1, 0x02,
    0xC0, 0x85, 0x05, 0x09, 0x60, 0xA1, 0x02, 0x09, 0x55, 0x25, 0x01, 0x95,
    0x01, 0xB1, 0x02, 0x09, 0x61, 0x09, 0x62, 0x27, 0xFF, 0xFF, 0x00, 0x00,
    0x95, 0x02, 0x75, 0x10, 0xB1, 0x02, 0x09, 0x51, 0x09, 0x52, 0x09, 0x53,
    0x09, 0x54, 0x26, 0xFF, 0x00, 0x95, 0x04, 0x75, 0x08, 0xB1, 0x02, 0xC0,
    0x85, 0x06, 0x09, 0x70, 0xA1, 0x02, 0x09, 0x71, 0x25, 0x01, 0x95, 0x01,
    0xB1, 0x02, 0xC0, 0xC0,
};

LampArrayColor writeState[LED_COUNT];
LampArrayColor readState[LED_COUNT];
LampArrayColor renderState[LED_COUNT];
volatile uint16_t requestedLampId = 0;
volatile bool autonomousMode = true;
volatile bool frameDirty = true;

static uint16_t minU16(uint16_t left, uint16_t right) {
  return left < right ? left : right;
}

static uint8_t minU8(uint8_t left, uint8_t right) {
  return left < right ? left : right;
}

static void publishWriteState() {
  noInterrupts();
  memcpy(readState, writeState, sizeof(readState));
  frameDirty = true;
  interrupts();
}

static void setAutonomousMode(bool enabled) {
  noInterrupts();
  autonomousMode = enabled;
  frameDirty = true;
  interrupts();
}

static LampAttributes lampAttributes[LED_COUNT];

static HIDSubDescriptor
    lampArrayDescriptorNode(LampArrayReportDescriptor,
                            sizeof(LampArrayReportDescriptor));

class LampArrayLampArrayUsbRegistration {
public:
  LampArrayLampArrayUsbRegistration() {
    HID().AppendDescriptor(&lampArrayDescriptorNode);
  }
};

static LampArrayLampArrayUsbRegistration LampArrayLampArrayUsbRegistration;

void setup() {
  // Samsung LC27HG70QQ Fiziksel Ölçüleri (Mikrometre)
  const uint32_t width_um = 624800;  // 62.48 cm
  const uint32_t height_um = 367200; // 36.72 cm
  const uint32_t depth_um = 93300;   // 9.33 cm

  // LED Dağılımı
  const uint16_t TOP_LEDS = 35;
  const uint16_t RIGHT_LEDS = 19;
  const uint16_t BOTTOM_LEDS = 35;
  const uint16_t LEFT_LEDS = 19;

  // Tüm LED'ler için genel LampArray ayarları (Amaç: Illumination)
  for (uint16_t i = 0; i < LED_COUNT; i++) {
    lampAttributes[i].LampId = i;
    lampAttributes[i].UpdateLatencyInMicroseconds =
        MICROSECONDS_FROM_MS(UPDATE_LATENCY_MS);
    lampAttributes[i].LampPurposes = LampPurposeIllumination;
    lampAttributes[i].RedLevelCount = 0xFF;
    lampAttributes[i].GreenLevelCount = 0xFF;
    lampAttributes[i].BlueLevelCount = 0xFF;
    lampAttributes[i].IntensityLevelCount = 0xFF;
    lampAttributes[i].IsProgrammable = LAMP_IS_PROGRAMMABLE;
    lampAttributes[i].LampKey = 0x00;
    lampAttributes[i].PositionZInMicrometers =
        depth_um; // LED'ler monitörün arkasında (Derinlik)
  }

  uint16_t ledIndex = 0;

  // 1. ÜST KENAR (Sol üst köşeden -> sağ üst köşeye)
  for (uint16_t i = 0; i < TOP_LEDS; i++) {
    lampAttributes[ledIndex].PositionXInMicrometers =
        (width_um * i) / (TOP_LEDS - 1);
    lampAttributes[ledIndex].PositionYInMicrometers = 0;
    ledIndex++;
  }

  // 2. SAĞ KENAR (Sağ üstten -> sağ alta)
  for (uint16_t i = 0; i < RIGHT_LEDS; i++) {
    lampAttributes[ledIndex].PositionXInMicrometers = width_um;
    lampAttributes[ledIndex].PositionYInMicrometers =
        (height_um * (i + 1)) / (RIGHT_LEDS + 1);
    ledIndex++;
  }

  // 3. ALT KENAR (Sağ alttan -> sol alta)
  for (uint16_t i = 0; i < BOTTOM_LEDS; i++) {
    lampAttributes[ledIndex].PositionXInMicrometers =
        width_um - ((width_um * i) / (BOTTOM_LEDS - 1));
    lampAttributes[ledIndex].PositionYInMicrometers = height_um;
    ledIndex++;
  }

  // 4. SOL KENAR (Sol alttan -> sol üste)
  for (uint16_t i = 0; i < LEFT_LEDS; i++) {
    lampAttributes[ledIndex].PositionXInMicrometers = 0;
    lampAttributes[ledIndex].PositionYInMicrometers =
        height_um - ((height_um * (i + 1)) / (LEFT_LEDS + 1));
    ledIndex++;
  }

  strip.begin();
  strip.show();
}

void loop() {
  if (frameDirty) {
    noInterrupts();
    memcpy(renderState, readState, sizeof(renderState));
    frameDirty = false;
    interrupts();

    if (autonomousMode) {
      for (uint16_t i = 0; i < LED_COUNT; i++) {
        strip.setPixelColor(i, 0, 0, 0);
      }
    } else {
      for (uint16_t i = 0; i < LED_COUNT; i++) {
        uint16_t intensity = renderState[i].IntensityChannel;
        uint8_t r = (uint8_t)((renderState[i].RedChannel * intensity) / 255);
        uint8_t g = (uint8_t)((renderState[i].GreenChannel * intensity) / 255);
        uint8_t b = (uint8_t)((renderState[i].BlueChannel * intensity) / 255);
        strip.setPixelColor(i, r, g, b);
      }
    }
    strip.show();
  }
}

static uint16_t copyFeaturePayloadWithoutReportId(uint8_t *buffer,
                                                  uint16_t reqlen,
                                                  const void *reportWithId,
                                                  uint16_t reportSizeWithId) {
  const uint8_t *bytes = reinterpret_cast<const uint8_t *>(reportWithId);
  const uint16_t payloadLength = reportSizeWithId - 1;
  const uint16_t copyLength = minU16(payloadLength, reqlen);
  memcpy(buffer, bytes + 1, copyLength);
  return copyLength;
}

extern "C" uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id,
                                          hid_report_type_t report_type,
                                          uint8_t *buffer, uint16_t reqlen) {
  (void)instance;

  if (report_type != HID_REPORT_TYPE_FEATURE) {
    return 0;
  }

  if (report_id == LAMP_ARRAY_ATTRIBUTES_REPORT_ID) {
    LampArrayAttributesReport report = {
        LAMP_ARRAY_ATTRIBUTES_REPORT_ID,
        LED_COUNT,
        624800, // BoundingBoxWidthInMicrometers: LC27HG70QQ Genişliği
        367200, // BoundingBoxHeightInMicrometers: LC27HG70QQ Yüksekliği
        93300,  // BoundingBoxDepthInMicrometers: LC27HG70QQ Derinliği
        LampArrayKindScene,
        MICROSECONDS_FROM_MS(UPDATE_LATENCY_MS)};

    return copyFeaturePayloadWithoutReportId(buffer, reqlen, &report,
                                             sizeof(report));
  }

  if (report_id == LAMP_ATTRIBUTES_RESPONSE_REPORT_ID) {
    noInterrupts();
    uint16_t lampId = requestedLampId;
    if (lampId >= LED_COUNT) {
      lampId = 0;
    }
    requestedLampId = (uint16_t)((lampId + 1) % LED_COUNT);
    interrupts();

    LampAttributesResponseReport report = {};
    report.ReportId = LAMP_ATTRIBUTES_RESPONSE_REPORT_ID;
    report.Attributes = lampAttributes[lampId];

    return copyFeaturePayloadWithoutReportId(buffer, reqlen, &report,
                                             sizeof(report));
  }

  return 0;
}

extern "C" void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id,
                                      hid_report_type_t report_type,
                                      uint8_t const *buffer, uint16_t bufsize) {
  (void)instance;

  if (report_type != HID_REPORT_TYPE_FEATURE) {
    return;
  }

  if (report_id == LAMP_ATTRIBUTES_REQUEST_REPORT_ID &&
      bufsize >= sizeof(LampAttributesRequestReport) - 1) {
    LampAttributesRequestReport report = {};
    report.ReportId = LAMP_ATTRIBUTES_REQUEST_REPORT_ID;
    memcpy(reinterpret_cast<uint8_t *>(&report) + 1, buffer,
           sizeof(report) - 1);
    noInterrupts();
    requestedLampId = (report.LampId < LED_COUNT) ? report.LampId : 0;
    interrupts();
    return;
  }

  if (report_id == LAMP_ARRAY_CONTROL_REPORT_ID &&
      bufsize >= sizeof(LampArrayControlReport) - 1) {
    LampArrayControlReport report = {};
    report.ReportId = LAMP_ARRAY_CONTROL_REPORT_ID;
    memcpy(reinterpret_cast<uint8_t *>(&report) + 1, buffer,
           sizeof(report) - 1);
    setAutonomousMode(report.AutonomousMode != 0);
    return;
  }

  if (report_id == LAMP_RANGE_UPDATE_REPORT_ID &&
      bufsize >= sizeof(LampRangeUpdateReport) - 1) {
    LampRangeUpdateReport report = {};
    report.ReportId = LAMP_RANGE_UPDATE_REPORT_ID;
    memcpy(reinterpret_cast<uint8_t *>(&report) + 1, buffer,
           sizeof(report) - 1);

    if (report.LampIdStart < LED_COUNT && report.LampIdEnd < LED_COUNT &&
        report.LampIdStart <= report.LampIdEnd) {
      for (uint16_t i = report.LampIdStart; i <= report.LampIdEnd; i++) {
        writeState[i] = report.UpdateColor;
      }

      if ((report.LampUpdateFlags & LAMP_UPDATE_FLAG_UPDATE_COMPLETE) != 0) {
        publishWriteState();
      }
    }
    return;
  }

  if (report_id == LAMP_MULTI_UPDATE_REPORT_ID &&
      bufsize >= sizeof(LampMultiUpdateReport) - 1) {
    LampMultiUpdateReport report = {};
    report.ReportId = LAMP_MULTI_UPDATE_REPORT_ID;
    memcpy(reinterpret_cast<uint8_t *>(&report) + 1, buffer,
           sizeof(report) - 1);

    const uint8_t count = minU8(report.LampCount, LAMP_MULTI_UPDATE_LAMP_COUNT);
    for (uint8_t i = 0; i < count; i++) {
      if (report.LampIds[i] < LED_COUNT) {
        writeState[report.LampIds[i]] = report.UpdateColors[i];
      }
    }

    if ((report.LampUpdateFlags & LAMP_UPDATE_FLAG_UPDATE_COMPLETE) != 0) {
      publishWriteState();
    }
    return;
  }
}
