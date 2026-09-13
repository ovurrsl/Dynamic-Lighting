# Hyperion.NG karşısında neredeyiz

Yol haritamız [hyperion.ng](https://github.com/hyperion-project/hyperion.ng)
(`c9f12db`). Bu dosya onun özellik envanterini çıkarıp bizimkiyle karşılaştırıyor
ve her eksiğin **tarayıcıda mümkün olup olmadığını** söylüyor — çünkü bazıları
değil, ve "eksik" ile "imkânsız" aynı şey değil.

Envanter Hyperion'un kendi kaynağından: `libsrc/hyperion/schema/*.json`
(kullanıcıya görünen her ayar), `libsrc/leddevice/dev_*` (sürücüler),
`libsrc/grabber/` (kaynaklar), `effects/` (efektler).

---

## 1. Piksel hattı — **tamamı bizde var**

Hyperion'un görüntüden LED'e giden matematiğinin tamamı port edildi ve test
edildi. Bu, aradaki en büyük parça ve bitmiş durumda.

| Hyperion | Bizde | Not |
|---|---|---|
| `imageToLedMappingType` 7 mod | `sample.ts` 7 mod | `multicolor_mean`, `mean_squared`, `unicolor_mean`, `dominant_color`, `unicolor_dominant`, ve iki `_advanced` |
| `channelAdjustment` 8 köşeli renk küpü | `adjust.ts` | white/red/green/blue/cyan/magenta/yellow + siyah |
| `saturationGain`, `brightness*`, `temperature` | `adjust.ts` | Kelvin dahil |
| `backlightThreshold`, `backlightColored` | `adjust.ts` | |
| `gammaRed/Green/Blue` 2.2 | `adjust.ts` `taper`, varsayılan **1.0** | Bilinçli sapma: firmware transfer fonksiyonu uygulamıyor |
| `blackborderdetector` 4 mod | `border.ts` 4 mod | Histerezis kare değil **ms** — Hyperion'un `borderFrameCnt=50`'si 120 Hz'de 0.42 s |
| `smoothing` linear/decay + dithering | `smooth.ts` 3 mod | **Asimetrik** üçüncü mod bize özgü (15/90 ms) |
| `ledConfig.classic` + `matrix` + `ledBlacklist` | `layout.ts` | Keystone (`ptlh`…`pbrv`) dahil, tamamı |
| Adalight/AWA seri protokolü | `protocol.ts` | Artı 16-bit doğrusal `Afx` |

**Bizde olup Hyperion'da olmayanlar:** doğrusal ışıkta ortalama (Hyperion
sRGB'de ortalıyor — luminans pompalamasının sebebi), asimetrik yumuşatma, sahne
kesmesi bypass'ı, güç/akım sınırlayıcı (Hyperion'da **hiç yok**), 16-bit
doğrusal aktarım, ve firmware tarafında interpolasyon.

---

## 2. Gerçek eksikler, etki sırasına göre

### (A) Efekt motoru — **41 efekt, bizde sıfır** ★ en büyük eksik

Hyperion `effects/` altında 41 efekt taşıyor: `rainbow-swirl`, `knight-rider`,
`fire`, `plasma`, `police-lights`, `candle`, `snake`, `matrix`, `atomic`,
`x-mas`, `pacman`, `mood-blobs-*` ve diğerleri.

Bu, uygulamayı **ekran yakalamadan bağımsız olarak** kullanılır kılan şey. Şu an
AmbiFlux ekran yakalayamıyorsa hiçbir işe yaramıyor; efektlerle bir masa
lambası, bir parti ışığı, bir bildirim göstergesi oluyor.

**Tarayıcıda daha kolay.** Hyperion bunun için **CPython gömüyor**
(`Effect.cpp`, `PyObject`, `PyImport_ImportModule`) — bir ambilight'a bir Python
yorumlayıcısı. Bizde efekt zaten JavaScript, çalışma zamanı zaten orada. Planın
"Effect engine'i atla" notu Hyperion'u *linklemek* içindi; kendi efektlerimizi
yazmak bambaşka bir maliyet.

### (B) Ağ LED cihazları — **18 sürücü, bizde sıfır** ★ ikinci en büyük

Hyperion `WLED`, `PhilipsHue`, `Nanoleaf`, `Yeelight`, `Cololight`, `AtmoOrb`,
`HomeAssistant`, `Razer`, `ArtNet`, `E1.31`, `DDP`, `TPM2.net` konuşuyor.

**Bizim için stratejik olarak en önemli madde**, çünkü kendi firmware'imize
ihtiyacı ortadan kaldırıyor: elinde WLED'li bir şerit olan biri hiçbir şey
yakmadan AmbiFlux'u kullanabilir.

Tarayıcı kısıtı: ham UDP yok. Ama:

| Protokol | Tarayıcıda | Nasıl |
|---|---|---|
| **WLED** | **evet** | JSON HTTP API + WebSocket (`/ws`) — ikisi de tarayıcıdan çağrılabilir |
| **Philips Hue Entertainment** | kısmen | HTTPS + DTLS; DTLS tarayıcıda yok, ama v1 HTTP API düşük hızda çalışır |
| **Home Assistant** | **evet** | REST + WebSocket |
| **Nanoleaf** | **evet** | HTTP API (yüksek hızlı akış UDP, düşük hızlı HTTP) |
| ArtNet / E1.31 / DDP / TPM2.net | **hayır** | Ham UDP; tarayıcıda imkânsız |

Not: sayfa HTTPS'te olduğu için yerel ağdaki `http://` cihaza çağrı **mixed
content**'e takılır. Çözüm zaten elimizde — çağrıyı **eklentinin** yapması;
eklentinin kendi origin'i var ve `host_permissions` ile yerel ağa çıkabiliyor.

### (C) Ses yakalama (müzik görselleştirici) — bizde yok

`libsrc/grabber/audio`, `schema-grabberAudio.json`. **Tarayıcıda bedava**:
`getUserMedia({audio:true})` + `AnalyserNode`. Hyperion'un Windows/Linux'a ayrı
ayrı yazdığı şey bizde tek bir Web Audio çağrısı.

### (D) Öncelik ve kaynak katmanları — yarısı var

`priority.ts` var ama onu besleyen kaynaklar yok. Hyperion'da:

- `foregroundEffect` — açılışta çalışan, süreli efekt/renk
- `backgroundEffect` — altta her zaman duran katman
- `instCapture` — ekran/video/ses kaynakları, her biri **kendi önceliğiyle** ve
  hareketsizlik zaman aşımıyla

Bu olmadan "ekran karardığında arkada sıcak beyaz kalsın" gibi temel bir istek
karşılanamıyor.

### (E) Çoklu örnek (instance) — bizde yok

Hyperion bir kurulumda birden fazla LED örneği sürebiliyor, her biri kendi
yerleşimi ve cihazıyla. Masa + TV aynı anda. Bizde profiller var ama **aynı anda
bir tanesi** çalışıyor.

### (F) Olaylar — bizde yok

`schema-osEvents` (uyku/kilit), `schema-schedEvents` (zamanlanmış aç/kapat),
`schema-cecEvents`. Tarayıcı karşılıkları: `visibilitychange`, `Page Lifecycle`,
ve zamanlayıcı. CEC tarayıcıda imkânsız ve zaten monitör ambilight'ında alakasız.

### (G) Tarayıcıda yapılamayacaklar — kapsam dışı, eksik değil

Boblight/flatbuffer/protobuf sunucuları, örnekler arası forwarder, V4L2 ve
HDMI yakalama kartları, Raspberry Pi'ye özgü grabber'lar (dispmanx, amlogic,
drm, framebuffer), SPI/FTDI/HID/PWM LED sürücüleri. Hepsi yerel donanım ya da
ham soket gerektiriyor.

---

## 3. Yol haritası

Sıra etkiye göre, ve her biri bir öncekinden bağımsız:

1. **Efekt motoru** — uygulamayı ekran yakalamasız kullanılır kılıyor, ve
   tarayıcıda Hyperion'dakinden daha ucuz.
2. **Öncelik katmanları** — ön plan/arka plan efekti, kaynak öncelikleri.
   Efektler gelince bunlar anlam kazanıyor.
3. **WLED sürücüsü** — kendi firmware'imizi zorunlu olmaktan çıkarıyor.
4. **Ses görselleştirici** — Web Audio, küçük iş, büyük görünürlük.
5. **Olaylar** — sekme gizlenince duraklat, zamanlanmış aç/kapat.
6. **Çoklu örnek** — mimariyi en çok değiştiren madde, o yüzden en sonda.
