# Firmware ve cihazlar: araştırma, karar, ve ölçülecekler

Tarih: 2026-09-14. Bu dosya iki soruyu cevaplıyor:

1. **Şeridi süren firmware nasıl en hızlı, en az gecikmeli hale gelir** — ve
   mevcut kütüphanelerle (FastLED, NeoPixelBus, WLED, Adalight sketch'leri)
   nasıl uyumlu kalır.
2. **Tarayıcıdan hangi ağ LED cihazlarına ulaşılabilir** — ve "ham UDP imkânsız"
   iddiam ne kadar doğruydu.

Yöntem her iki bölümde de aynı: önce ölç ya da kaynaktan oku, sonra karar ver.
Bu projede uyumluluk tabloları üç kez yanıldı.

---

## 1. Bizim durumumuz ne kadar zor — önce bu

Bütün kütüphane tartışması, sayılara bakılmadan yapıldığında anlamsız.

| | Değer |
|---|---|
| LED sayısı | 108, tek şerit |
| WS2812B veri süresi | **3.24 ms** |
| + reset (280 µs) | 3.52 ms |
| 120 Hz kare periyodu | 8.33 ms |
| **Doluluk** | **%42** |
| Afx kare boyutu | 654 bayt |
| 120 Hz'de veri hızı | 78 kB/s |

**Sonuç: bizde bir verim (throughput) sorunu yok.** 108 LED'de hiçbir kütüphane
"yetişemiyor". HyperSerialESP32'nin büyük kurulumlar için kullandığı paralel
çok-segment numarası bize hiçbir şey kazandırmıyor; o, 500+ LED'de anlamlı.

Önemli olan tek şey **aç kalma (starvation)**: çevre birimi kare ortasında
beslenemezse şerit kısa bir kare latch ediyor ve göz bunu titreme olarak
görüyor. Yani doğru soru "hangisi daha hızlı" değil, **"hangisi hiç aç
kalmıyor"**.

İkinci önemli şey **gecikme**, ve o kütüphanede değil, girişte:
USB'den gelen baytın işlenmeye başlamasına kadar geçen süre.

---

## 2. ESP32-S3'te çıkış yolları

### 2.1 Manzara

| Yol | Bit zamanlaması | Besleme | Not |
|---|---|---|---|
| Bit-bang (Adafruit_NeoPixel) | yazılım | CPU, kesmeler kapalı | RA4M1'de bu yüzden reddedildi |
| **RMT** | **donanım** | refill ISR | ESP32'nin klasik yolu |
| **RMT + DMA** | **donanım** | **DMA** | S3'te var (`rmt_tx_channel_config_t.flags.with_dma`) |
| I2S | donanım | DMA | **S3'te yok** — aşağıya bak |
| **LCD** | **donanım** | **DMA** | S3'ün I2S yerine koyduğu şey; yalnız paralel |
| SPI | donanım | DMA | WS2812 için dolaylı, 3-4 bit/bit kodlama |

### 2.2 Ölçülen: "I2S kullan" tavsiyesi bu kartta yanlış

Yaygın tavsiye "RMT'nin kesme sıklığıyla sorunları var, I2S'e geç" biçiminde ve
genel olarak doğru. **ESP32-S3'te uygulanamıyor.** NeoPixelBus'un kaynağından,
`NeoEsp32I2sMethod.h` satır 30:

```cpp
#if defined(ARDUINO_ARCH_ESP32) && !defined(CONFIG_IDF_TARGET_ESP32C3) && !defined(CONFIG_IDF_TARGET_ESP32S3)
```

Yani S3'te bütün `NeoEsp32I2s*` ailesi derlemeden çıkıyor. S3'ün karşılığı LCD
çevre birimi (`NeoEsp32LcdXMethod.h`, satır 29: `defined(CONFIG_IDF_TARGET_ESP32S3)`)
ve o **yalnız paralel**: en küçüğü `NeoEsp32LcdX8Ws2812xMethod`, sekiz kanal.
Tek şerit kanal 0'ı kullanıyor, kalan yedisi boşta duruyor.

Bu, kaçınmaya değer bir israf değil — S3'ün sunduğu tek DMA yolu o.

**Bu bulguyu CI yakaladı**, doküman değil: `nano_esp32_dma` ortamı eklenince
`NeoEsp32I2s1Ws2812xMethod` "does not name a type" dedi. Derlenmeyen bir seçenek
seçenek değildir, ve o ortam artık CI'da tam olarak bu yüzden duruyor.

### 2.3 Karar

Derleme zamanı seçim, **varsayılan RMT**:

```ini
[env:nano_esp32]      ; NeoEsp32Rmt0Ws2812xMethod
[env:nano_esp32_dma]  ; -D AMBIFLUX_OUTPUT_DMA -> NeoEsp32LcdX8Ws2812xMethod
```

Varsayılanın RMT olması bir iddia değil, bir başlangıç noktası: bir pin
harcıyor ve çevre birimi geneline kısıt getirmiyor. **Hangisinin daha iyi
olduğu ölçüm**, ve firmware zaten onu sayıyor: telemetrideki `shortFrames`,
zamanlayıcı ateşlediğinde şeridin hazır olmadığı kare sayısı. Birini yak, bir
saat soak et, sayacı oku, diğerini yak. Sağlıklı olan **tam olarak 0**.

### 2.4 Bu turda yapılan iki somut iyileştirme

**(a) `SetPixelColor` yerine doğrudan tampon.** `SetPixelColor` bir sınır
kontrolü, bir `RgbColor` inşası ve piksel başına bir dispatch; 108 LED ve
120 Hz'de saniyede on üç bin tane, üstelik elimizde zaten hazır olan baytları
üretmek için. `Pixels()` DMA'nın okuyacağı tamponu veriyor; döngü doğrudan
oraya yazıyor ve `Dirty()` çağırıyor (o olmadan `Show()` tamponun
değişmediğine inanıp hiçbir şey göndermiyor).

**(b) Seri görevindeki 1 ms uyku kalktı.** FreeRTOS tick'i 1 kHz, yani
`vTaskDelay(1)` tam bir milisaniyeye kadar uyuyor — 120 Hz'lik bir kare
periyodunun **%12'si**, her karenin gecikmesine, hiçbir karşılığı olmadan
ekleniyordu. Yerine `usleep(100)`: tick'e yuvarlamadan çekirdeği bırakıyor.
Meşgul döngü değil, çünkü o görev core 0'ı beklediği baytları ona vermeye
çalışan USB yığınıyla paylaşıyor.

### 2.5 Nano ESP32'de baud oranı anlamsız — ve bu bir avantaj

HyperSerialESP32'nin README'si USB-seri çipini doğru şekilde uyarıyor: CP2102
en fazla 1 Mb, CH340G 2 Mb, CH9102x 4 Mb. **Arduino Nano ESP32'de böyle bir çip
yok**: ESP32-S3'ün yerel USB'si kullanılıyor (`ARDUINO_USB_MODE=0`,
`ARDUINO_USB_CDC_ON_BOOT=1`). Yerel CDC'de "baud" sayısı yok sayılıyor ve hız
tam-hız USB'nin kendisi. `monitor_speed = 921600` yalnız monitör için bir sayı.

Yani bu kartta seri hız bir darboğaz değil ve olmayacak.

---

## 3. Mevcut kütüphanelerle ve sketch'lerle çalışma

İstek açıktı: uygulama FastLED gibi kütüphanelerle ve hazır kodlarla
çalışabilmeli. Bunun iki yarısı var ve **asıl olanı firmware değil protokol.**

### 3.1 Host tarafı: Adalight konuşmak (yapıldı)

Motor yalnızca `Afx` gönderiyordu, yani AmbiFlux'ı denemek için önce bizim
firmware'imizi yakmak gerekiyordu. Artık format yapılandırma:

| Format | Bayt/LED | Bütünlük | Ne konuşuyor |
|---|---|---|---|
| `Afx` | 6 | Fletcher | bizim firmware; 16-bit doğrusal |
| `Awa` | 3 | Fletcher | HyperHDR, HyperSerialESP32, HyperSerialWLED |
| `Ada` | 3 | **yok** | standart Adalight FastLED sketch'leri |

Bu, "elindeki şeritle çalışır" ile "önce kartını yeniden yak" arasındaki fark.
Kodlayıcılar protokol modülü yazıldığından beri vardı ve test ediliyordu; eksik
olan tek şey seçimdi.

**`Awa`/`Ada` için 8-bit doğrusal gönderiliyor, sRGB değil.** Bir Adalight
sketch'i baytı doğrudan LED kütüphanesine yazıyor; WS2812'nin parlaklığı PWM
duty'sini, o da baytı izliyor. Burada gama kodlamak, fiziğin ikinci kez
uygulamasıyla kabaca karesi alınmış bir çıkış verirdi — port planının
Hyperion'un kendi hattında katalogladığı hatanın aynısı.

### 3.2 Firmware tarafı: zaten dört magic'i ayrıştırıyor

`firmware/lib/afx/src/afx_protocol.h` `Ada`, `Awa`/`AwA`, `Afx` ve `AxC`'yi tek
durum makinesiyle ayırt ediyor. Yani bizim firmware'imiz Hyperion'un ve
HyperHDR'ın çıktısını da kabul ediyor — bağ tek yönlü değil.

### 3.3 Çıkış kütüphanesi dikişi

Çıkış metodu artık `using AmbifluxMethod = ...` tek satırı. FastLED'e geçmek
isteyen o satırı ve `render()`'ın son döngüsünü değiştiriyor; aradaki hiçbir
şey — ayrıştırıcı, interpolasyon, dither, güç sınırlayıcı — kütüphaneyi
tanımıyor ve host'ta test edilmeye devam ediyor.

**FastLED neden varsayılan değil:** FastLED'in ESP32-S3 yolu da RMT tabanlı ve
aynı soruyu soruyor; NeoPixelBus'un `CanShow()` kapısı ise 280 µs latch
aralığını içeride takip ediyor, ki bizim 120 Hz zamanlayıcımızın tam olarak
ihtiyacı olan şey bu. Bu bir kalite yargısı değil, bir uyum kararı.

---

## 4. Ağ LED cihazları — "ham UDP imkânsız" iddiasının denetimi

### 4.1 İddia doğru, ama eksikti

Tarayıcı **ham UDP açamıyor**: `chrome.sockets` eklentide tanımsız (ölçüldü),
ve tarayıcı platformunda UDP soketi diye bir şey yok. Bu, ArtNet (UDP 6454),
E1.31/sACN (5568), DDP (4048), TPM2.net (65506), UDP-RAW ve H801'i doğrudan
dışarıda bırakıyor. Buraya kadar doğru.

**Eksik olan şu: bir cihazın Hyperion'un kullandığı taşımayı kullanması, tek
taşımasının o olduğu anlamına gelmiyor.**

### 4.2 WLED: Hyperion'un kullanmadığı bir kapı var

Hyperion'un `LedDeviceWled` sınıfı `LedDeviceUdpDdp` ve `LedDeviceUdpRaw`'dan
türüyor — yani DDP (UDP) ya da WARLS (UDP 19446). İkisi de tarayıcıya kapalı.

Ama WLED'in **WebSocket'i var** (`ws://[ip]/ws`, 0.10.2'den beri varsayılan
açık) ve JSON API'nin bir alt kümesini kabul ediyor. JSON API ise tek tek LED
ayarlayabiliyor:

```json
{"seg":{"i":["FF0000","00FF00","0000FF"]}}
```

Yani **tarayıcıdan WLED'i LED başına sürmek mümkün** — Hyperion'un hiç
kullanmadığı bir yolla. Kısıt JSON: 108 LED için kare başına ~1 kB metin ve
ESP tarafında kare başına bir JSON ayrıştırma. Ağ değil, ESP'nin CPU'su
sınırlıyor. **Ölçülmedi**, ve ölçülene kadar kaç fps olduğu hakkında bir şey
yazmayacağım.

WLED'in kaynağından (json.cpp, ws.cpp) okunan ve sürücünün (`lib/engine/wled.ts`)
biçimini belirleyen üç şey — üçü de okundu, hiçbiri cihazda ölçülmedi:

1. **`gamma32()`**: cihaz, JSON ile verilen her rengi kendi renk gamasından
   geçiriyor (LED ayarları → renk gaması, fabrika değeri 2.8, varsayılan açık).
   Doğrusal baytı olduğu gibi göndermek onu yolda 2.8'inci kuvvete çıkarır —
   motorun geri kalanının kaçındığı çifte gama. Sürücü baytları **önceden
   dengeliyor** (`linear^(1/γ)`); γ panelde `output.wledGamma` ayarı (gaması
   kapalı cihazda 1).
2. **Tek çerçeve sınırı**: WebSocket işleyicisi bir mesajı yalnız tek çerçevede
   bütün geldiğinde ayrıştırıyor (kaynaktaki yorum "max. 1450 bytes") ve
   bölünene `{"error":9}` diyor. Uzun şerit birkaç mesaj olarak gidiyor, her
   biri ilk LED indeksiyle adreslenmiş (`"i":[151,"RRGGBB",…]`), mesaj başına
   en çok 151 LED. Fake bir WebSocket sunucusuna karşı Chromium'da ölçüldü:
   500 LED = 4 mesaj/kare, en büyük mesaj 1385 bayt, 120 kare/s (loopback TCP,
   ESP değil).
3. **`"live":true` gönderilmiyor**: eski el sıkışma onu gönderiyordu, ama bu
   cihazı UDP gerçek-zaman kipine sokuyor — ana döngü şeridi servis etmeyi
   bırakıyor ve JSON ile yazılan pikseller hiç gösterilmiyor. El sıkışma artık
   `{"on":true,"bri":255,"seg":{"id":N,"frz":true}}`: aç, tam parlaklık (motorun
   kendi parlaklık sınırı tek yetkili), segmenti dondur. Stop'ta siyah kareden
   sonra `{"seg":{"id":N,"frz":false}}` ile segment cihazın kendi efektine geri
   veriliyor.

### 4.3 Tarayıcıdan ulaşılabilirlik tablosu

| Cihaz | Hyperion'un taşıması | Tarayıcıdan | Nasıl |
|---|---|---|---|
| **WLED** | DDP / WARLS (UDP) | **✅** | JSON over WebSocket (`/ws`) |
| **Home Assistant** | REST | **✅** | HTTP + WebSocket API |
| **Philips Hue** | REST + DTLS-UDP (Entertainment) | **kısmen** | REST var; akış modu DTLS-UDP, kapalı |
| **Nanoleaf** | REST + UDP akış | **kısmen** | REST var; akış UDP, kapalı |
| **Cololight / AtmoOrb / Yeelight** | UDP / ham TCP | ❌ | — |
| **FadeCandy** | TCP (OPC) | ❌ | ham TCP yok |
| ArtNet, E1.31, DDP, TPM2.net, UDP-RAW, H801 | UDP | ❌ | tarayıcıda UDP yok |
| **Bizim firmware'imiz** | seri | **✅ olacak** | aşağıda |

### 4.4 Asıl cevap: kendi firmware'imiz WebSocket konuşsun

Tarayıcının UDP açamamasını çözmeye çalışmak yanlış soru. **Firmware bizim.**
ESP32-S3 bir WebSocket sunucusu koşabiliyor ve ikili çerçeve taşıyabiliyor —
yani bugün seri porttan giden `Afx` karesinin **aynısı**, aynı ayrıştırıcıya,
aynı test takımına.

Bunun sonucu iOS'u açıyor: iPhone'da Web Serial, WebUSB, WebHID ve Web
Bluetooth'un dördü de yok, tek yol ağ. Ve bu yol bize üçüncü bir protokol
maliyeti çıkarmıyor.

Sıradaki iş bu yüzden **`FrameSink` soyutlaması → WebSocket sink → firmware'de
WebSocket sunucusu**, ve WLED sürücüsü onun yanında.

---

## 5. Ölçülecekler

Bunları bu ortamda yapamam: burada kart yok, GPU yok, gerçek şerit yok.

| # | Ölçüm | Nasıl | Neyi değiştirir |
|---|---|---|---|
| F1 | RMT vs LCD-DMA | iki env'i yak, 1 saat soak, `shortFrames` oku | varsayılan çıkış metodu |
| F2 | 120 Hz doğruluğu | 24 MHz mantık analizörü, veri hattı | "120 Hz" iddiasının dürüstlüğü |
| F3 | Seviye çevirici | 74AHCT125 vs çıplak 3.3 V, hata oranı | kit BOM'u |
| F4 | Uçtan uca gecikme | 240 fps telefon, flaş deseni (panelde hazır) | bütün zincir |
| F5 | Giriş gecikmesi | `usleep(100)` öncesi/sonrası varış p50 | bu turun değişikliği doğru muydu |
| N1 | WLED WS kare hızı | 108 LED, JSON over WS, kare say | WLED sürücüsü kullanılabilir mi |
| N2 | WiFi linkliyken `shortFrames` | `nano_esp32_net`, 1 saat soak, sayacı oku | ağ derlemesi RMT'yi bozuyor mu — bozuyorsa DMA varsayılan olur |
| N3 | Kendi WS'imizin kare hızı | `ws://kart/afx`, aynı Afx baytları, kare say | ağ üzerinden 120 Hz mümkün mü |

`shortFrames`, `resyncs`, `badChecksum` sağlıklı bir sistemde **tam olarak 0**.
Sıfır değilse bir kablo, bir sürücü ya da bir ayrıştırıcı hatası var — asla
"kabul edilebilir gürültü" değil.
