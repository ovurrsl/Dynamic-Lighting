#include "tusb.h"
#include <Adafruit_NeoPixel.h>
#include <HID.h>
#include <math.h>

// ─────────────────────────────────────────────────────────────
//  Donanım yapılandırması
// ─────────────────────────────────────────────────────────────
#define LED_COUNT 108
#define DATA_PIN 6

// Şeridin kenarlara dağılımı (toplamı LED_COUNT olmak zorunda)
#define TOP_LEDS 35
#define RIGHT_LEDS 19
#define BOTTOM_LEDS 35
#define LEFT_LEDS 19

// Samsung LC27HG70QQ fiziksel ölçüleri (mikrometre)
#define PANEL_WIDTH_UM 624800UL  // 62.48 cm
#define PANEL_HEIGHT_UM 367200UL // 36.72 cm
#define PANEL_DEPTH_UM 93300UL   // 9.33 cm  (LED'ler panelin arkasında)

// ─────────────────────────────────────────────────────────────
//  Kare hızı
// ─────────────────────────────────────────────────────────────
// Tek bir lambanın tepki gecikmesi.
#define UPDATE_LATENCY_MS 1
// Host güncellemeleri için asgari kare aralığı. 108 LED'lik bir WS2812B
// şeridinde strip.show() ~3.3 ms kesintisiz zaman istiyor; host'a bundan
// hızlısını vaat etmemek için MinUpdateInterval olarak da bunu bildiriyoruz.
#define FRAME_INTERVAL_MS 10
// Host yokken / otonom moddaki dahili animasyonun kare aralığı (~30 FPS).
#define IDLE_FRAME_INTERVAL_MS 33

// ─────────────────────────────────────────────────────────────
//  Güç bütçesi
// ─────────────────────────────────────────────────────────────
// 108 WS2812B tam beyazda ~6.5 A çeker; hiçbir USB portu bunu veremez.
// Kareyi göndermeden önce tahmini akımı hesaplayıp bütçeye sığacak şekilde
// kısıyoruz. Bu değeri kendi beslemene göre AYARLA:
//   * Şerit yalnızca kartın 5V pininden besleniyorsa USB 2.0 portunda 500,
//     USB 3.0 / güçlü hub'da ~900 uygundur.
//   * Harici 5V adaptör kullanıyorsan adaptörün akımının ~%80'ini yaz
//     (ör. 5 A adaptör -> 4000).
// Tam beyaz istendiğinde bu sınır yüzünden şerit kısılıyorsa değer düşüktür.
#define POWER_BUDGET_MA 1500
// LED başına tam beyaz tüketimi (üç kanal birlikte, yaklaşık değer).
#define LED_FULL_WHITE_MA 60
// Otonom moddaki dahili animasyonun tepe parlaklığı (0-255).
#define IDLE_BRIGHTNESS 40
// Algısal olarak doğrusal kısılma için gama düzeltmesi.
#define GAMMA_EXPONENT 2.2f

static_assert(TOP_LEDS + RIGHT_LEDS + BOTTOM_LEDS + LEFT_LEDS == LED_COUNT,
              "Kenar LED sayilarinin toplami LED_COUNT ile ayni olmali.");
static_assert(TOP_LEDS > 1 && BOTTOM_LEDS > 1,
              "Ust ve alt kenarlarda konum interpolasyonu icin en az 2 LED gerekli.");
static_assert(RIGHT_LEDS > 0 && LEFT_LEDS > 0,
              "Yan kenarlarda en az 1 LED olmali.");

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

// Tüm feature report'lar tek bir full-speed USB paketine sığmalı.
static_assert(sizeof(LampArrayAttributesReport) <= 64,
              "LampArray attributes report tek pakete sigmali.");
static_assert(sizeof(LampAttributesResponseReport) <= 64,
              "Lamp attributes response report tek pakete sigmali.");
static_assert(sizeof(LampMultiUpdateReport) <= 64,
              "Lamp multi-update HID report must fit in a full-speed USB packet.");
static_assert(sizeof(LampRangeUpdateReport) <= 64,
              "Lamp range update report tek pakete sigmali.");
static_assert(sizeof(LampArrayControlReport) <= 64,
              "LampArray control report tek pakete sigmali.");

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

// ─────────────────────────────────────────────────────────────
//  Paylaşılan durum
//
//  writeState USB kesme bağlamında (tud_hid_set_report_cb) yazılır,
//  renderState yalnızca loop() tarafından okunur. İkisi arasındaki
//  kopyalama tek ve kısa bir kritik bölümde yapılır.
// ─────────────────────────────────────────────────────────────
// writeState yalnızca kesme bağlamında yazılır, renderState yalnızca
// loop() tarafından okunur; senkronizasyonu volatile frameDirty bayrağı ve
// aşağıdaki kısa kritik bölüm sağlıyor.
static LampArrayColor writeState[LED_COUNT];
static LampArrayColor renderState[LED_COUNT];
static uint8_t frameBuffer[LED_COUNT * 3];
static uint8_t gammaTable[256];
static LampAttributes lampAttributes[LED_COUNT];

static volatile uint16_t requestedLampId = 0;
static volatile bool autonomousMode = true;
static volatile bool frameDirty = true;

static uint32_t lastHostFrameMs = 0;
static uint32_t lastIdleFrameMs = 0;
static bool idleFrameActive = false;

static uint16_t minU16(uint16_t left, uint16_t right) {
  return left < right ? left : right;
}

static uint8_t minU8(uint8_t left, uint8_t right) {
  return left < right ? left : right;
}

static void publishWriteState() {
  // Yalnızca bayrağı kaldırıyoruz; kopyalamayı loop() yapıyor. Böylece
  // kesme bağlamında uzun bir memcpy çalıştırmıyoruz.
  frameDirty = true;
}

static void setAutonomousMode(bool enabled) {
  autonomousMode = enabled;
  frameDirty = true;
}

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

// ─────────────────────────────────────────────────────────────
//  Yardımcılar
// ─────────────────────────────────────────────────────────────

static void buildGammaTable() {
  for (uint16_t i = 0; i < 256; i++) {
    const float normalized = (float)i / 255.0f;
    gammaTable[i] = (uint8_t)(powf(normalized, GAMMA_EXPONENT) * 255.0f + 0.5f);
  }
}

/// 1536 adımlı (6 sektör x 256) tam doygunlukta renk tonu dönüşümü.
static void hueToRgb(uint16_t hue1536, uint8_t &red, uint8_t &green,
                     uint8_t &blue) {
  const uint8_t sector = (uint8_t)(hue1536 / 256);
  const uint8_t position = (uint8_t)(hue1536 % 256);

  switch (sector) {
  case 0:  red = 255;                green = position;           blue = 0;                  break;
  case 1:  red = (uint8_t)(255 - position); green = 255;         blue = 0;                  break;
  case 2:  red = 0;                  green = 255;                blue = position;           break;
  case 3:  red = 0;                  green = (uint8_t)(255 - position); blue = 255;          break;
  case 4:  red = position;           green = 0;                  blue = 255;                break;
  default: red = 255;                green = 0;                  blue = (uint8_t)(255 - position); break;
  }
}

/// Host'un gönderdiği rengi yoğunluk kanalı ve gama ile kare arabelleğine yazar.
static void renderHostFrame() {
  for (uint16_t i = 0; i < LED_COUNT; i++) {
    const uint16_t intensity = renderState[i].IntensityChannel;
    const uint8_t red = (uint8_t)((renderState[i].RedChannel * intensity) / 255);
    const uint8_t green = (uint8_t)((renderState[i].GreenChannel * intensity) / 255);
    const uint8_t blue = (uint8_t)((renderState[i].BlueChannel * intensity) / 255);

    frameBuffer[(i * 3) + 0] = gammaTable[red];
    frameBuffer[(i * 3) + 1] = gammaTable[green];
    frameBuffer[(i * 3) + 2] = gammaTable[blue];
  }
}

/// Otonom mod / host yokken çalışan dahili animasyon: şerit boyunca
/// yavaşça süzülen kısık bir gökkuşağı. Eskiden bu durumda şerit tamamen
/// söndürülüyordu ve cihaz "bozuk" görünüyordu.
static void renderIdleFrame(uint32_t nowMs) {
  const uint16_t baseHue = (uint16_t)((nowMs / 24UL) % 1536UL);

  for (uint16_t i = 0; i < LED_COUNT; i++) {
    const uint16_t hue =
        (uint16_t)((baseHue + (((uint32_t)i * 1536UL) / LED_COUNT)) % 1536UL);

    uint8_t red = 0;
    uint8_t green = 0;
    uint8_t blue = 0;
    hueToRgb(hue, red, green, blue);

    frameBuffer[(i * 3) + 0] = (uint8_t)((gammaTable[red] * IDLE_BRIGHTNESS) / 255);
    frameBuffer[(i * 3) + 1] = (uint8_t)((gammaTable[green] * IDLE_BRIGHTNESS) / 255);
    frameBuffer[(i * 3) + 2] = (uint8_t)((gammaTable[blue] * IDLE_BRIGHTNESS) / 255);
  }
}

/// Kare arabelleğindeki toplam akımı tahmin eder ve POWER_BUDGET_MA'yı
/// aşıyorsa tüm kareyi eşit oranda kısar. Dönen değer 0-256 aralığında
/// sabit noktalı ölçek katsayısıdır.
static uint16_t powerBudgetScale() {
  uint32_t channelSum = 0;
  for (uint16_t i = 0; i < (LED_COUNT * 3); i++) {
    channelSum += frameBuffer[i];
  }

  if (channelSum == 0) {
    return 256;
  }

  // Tam beyaz bir LED'in üç kanal toplamı 765'tir.
  const uint32_t estimatedMilliamps =
      ((uint32_t)LED_FULL_WHITE_MA * channelSum) / 765UL;

  if (estimatedMilliamps <= POWER_BUDGET_MA) {
    return 256;
  }

  return (uint16_t)(((uint32_t)POWER_BUDGET_MA * 256UL) / estimatedMilliamps);
}

static void commitFrame() {
  const uint16_t scale = powerBudgetScale();

  for (uint16_t i = 0; i < LED_COUNT; i++) {
    uint8_t red = frameBuffer[(i * 3) + 0];
    uint8_t green = frameBuffer[(i * 3) + 1];
    uint8_t blue = frameBuffer[(i * 3) + 2];

    if (scale < 256) {
      red = (uint8_t)(((uint16_t)red * scale) >> 8);
      green = (uint8_t)(((uint16_t)green * scale) >> 8);
      blue = (uint8_t)(((uint16_t)blue * scale) >> 8);
    }

    strip.setPixelColor(i, red, green, blue);
  }

  strip.show();
}

static void buildLampAttributes() {
  // Tüm LED'ler için genel LampArray ayarları.
  for (uint16_t i = 0; i < LED_COUNT; i++) {
    lampAttributes[i].LampId = i;
    lampAttributes[i].UpdateLatencyInMicroseconds =
        MICROSECONDS_FROM_MS(UPDATE_LATENCY_MS);
    lampAttributes[i].LampPurposes =
        LampPurposeAccent | LampPurposeIllumination;
    lampAttributes[i].RedLevelCount = 0xFF;
    lampAttributes[i].GreenLevelCount = 0xFF;
    lampAttributes[i].BlueLevelCount = 0xFF;
    lampAttributes[i].IntensityLevelCount = 0xFF;
    lampAttributes[i].IsProgrammable = LAMP_IS_PROGRAMMABLE;
    lampAttributes[i].LampKey = 0x00;
    // LED'ler monitörün arkasında (derinlik ekseni).
    lampAttributes[i].PositionZInMicrometers = PANEL_DEPTH_UM;
  }

  uint16_t ledIndex = 0;

  // 1. ÜST KENAR (sol üst köşeden -> sağ üst köşeye)
  for (uint16_t i = 0; i < TOP_LEDS; i++) {
    lampAttributes[ledIndex].PositionXInMicrometers =
        (PANEL_WIDTH_UM * i) / (TOP_LEDS - 1);
    lampAttributes[ledIndex].PositionYInMicrometers = 0;
    ledIndex++;
  }

  // 2. SAĞ KENAR (sağ üstten -> sağ alta)
  for (uint16_t i = 0; i < RIGHT_LEDS; i++) {
    lampAttributes[ledIndex].PositionXInMicrometers = PANEL_WIDTH_UM;
    lampAttributes[ledIndex].PositionYInMicrometers =
        (PANEL_HEIGHT_UM * (i + 1)) / (RIGHT_LEDS + 1);
    ledIndex++;
  }

  // 3. ALT KENAR (sağ alttan -> sol alta)
  for (uint16_t i = 0; i < BOTTOM_LEDS; i++) {
    lampAttributes[ledIndex].PositionXInMicrometers =
        PANEL_WIDTH_UM - ((PANEL_WIDTH_UM * i) / (BOTTOM_LEDS - 1));
    lampAttributes[ledIndex].PositionYInMicrometers = PANEL_HEIGHT_UM;
    ledIndex++;
  }

  // 4. SOL KENAR (sol alttan -> sol üste)
  for (uint16_t i = 0; i < LEFT_LEDS; i++) {
    lampAttributes[ledIndex].PositionXInMicrometers = 0;
    lampAttributes[ledIndex].PositionYInMicrometers =
        PANEL_HEIGHT_UM - ((PANEL_HEIGHT_UM * (i + 1)) / (LEFT_LEDS + 1));
    ledIndex++;
  }
}

// ─────────────────────────────────────────────────────────────
//  Arduino giriş noktaları
// ─────────────────────────────────────────────────────────────

void setup() {
  buildGammaTable();
  buildLampAttributes();

  strip.begin();
  strip.show();
}

void loop() {
  const uint32_t now = millis();

  // Host bağlı değilken ya da otonom moda alındığımızda kendi
  // animasyonumuzu gösteriyoruz.
  const bool hostInControl = !autonomousMode && tud_mounted() && !tud_suspended();

  if (!hostInControl) {
    if (!idleFrameActive || (uint32_t)(now - lastIdleFrameMs) >= IDLE_FRAME_INTERVAL_MS) {
      renderIdleFrame(now);
      commitFrame();
      lastIdleFrameMs = now;
      idleFrameActive = true;
    }
    return;
  }

  // Host kontrolüne yeni geçtiysek bir sonraki kareyi koşulsuz gönder.
  if (idleFrameActive) {
    idleFrameActive = false;
    frameDirty = true;
  }

  if (!frameDirty) {
    return;
  }

  if ((uint32_t)(now - lastHostFrameMs) < FRAME_INTERVAL_MS) {
    return;
  }

  noInterrupts();
  memcpy(renderState, writeState, sizeof(renderState));
  frameDirty = false;
  interrupts();

  renderHostFrame();
  commitFrame();
  lastHostFrameMs = now;
}

// ─────────────────────────────────────────────────────────────
//  HID feature report işleyicileri
// ─────────────────────────────────────────────────────────────

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
        PANEL_WIDTH_UM,  // BoundingBoxWidthInMicrometers
        PANEL_HEIGHT_UM, // BoundingBoxHeightInMicrometers
        PANEL_DEPTH_UM,  // BoundingBoxDepthInMicrometers
        LampArrayKindScene,
        MICROSECONDS_FROM_MS(FRAME_INTERVAL_MS)};

    return copyFeaturePayloadWithoutReportId(buffer, reqlen, &report,
                                             sizeof(report));
  }

  if (report_id == LAMP_ATTRIBUTES_RESPONSE_REPORT_ID) {
    // Host, lamba tablosunu ardışık okumalarla gezer; her okumada sıradaki
    // lambaya geçiyoruz.
    uint16_t lampId = requestedLampId;
    if (lampId >= LED_COUNT) {
      lampId = 0;
    }
    requestedLampId = (uint16_t)((lampId + 1) % LED_COUNT);

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
    requestedLampId = (report.LampId < LED_COUNT) ? report.LampId : 0;
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

    // Aralığı kırpıyoruz: host şeritten büyük bir aralık gönderdiğinde
    // eskiden kare tamamen yok sayılıyordu.
    if (report.LampIdStart < LED_COUNT &&
        report.LampIdStart <= report.LampIdEnd) {
      const uint16_t lastLampId = minU16(report.LampIdEnd, LED_COUNT - 1);
      for (uint16_t i = report.LampIdStart; i <= lastLampId; i++) {
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
