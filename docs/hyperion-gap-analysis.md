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
| ArtNet / E1.31 / DDP / TPM2.net | **hayır** | Ham UDP; `chrome.sockets` MV3'te yok (§G'de ölçüldü) |

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

### (G) Eklentiyle mümkün olanlar — **önceki analizim burada yanlıştı**

Bu bölüm bir düzeltme. Daha önce V4L2/HDMI yakalama kartlarını ve SPI/FTDI/HID
LED sürücülerini "tarayıcıda imkânsız" diye yazmıştım. **Değiller.** Eklenti
sayfasında ölçüldü:

```
chrome.sockets      : undefined      chrome.socket : undefined
navigator.hid       : object         navigator.usb : object
navigator.serial    : object         getUserMedia  : function
enumerateDevices    : function       WebTransport  : function
```

**Mümkün olanlar (yanlış sınıflandırmıştım):**

- **USB / HDMI yakalama kartları.** Bir yakalama kartı işletim sisteminde
  webcam olarak görünüyor, yani `enumerateDevices` onu `videoinput` diye
  listeliyor ve `getUserMedia({video:{deviceId}})` açıyor. Bu, Hyperion'un
  V4L2 grabber'ının karşılığı — **ve DRM sorununu kökünden çözüyor**, çünkü
  sinyal HDMI splitter'dan sonra şifresi çözülmüş olarak geliyor. Planın
  "v2 SKU" dediği şey aslında bugün yapılabilir.
- **HID LED cihazları** (`navigator.hid`): Hyperion'un `dev_hid` grubu —
  Lightpack, Paintpack, RawHID, USBASP. Beşi de WebHID ile erişilebilir.
- **FTDI tabanlı cihazlar** (`navigator.usb`): `dev_ftdi` grubu. WebUSB ile
  ham bulk transfer mümkün; FTDI'nin seri emülasyonunu elde yazmak gerekir
  ama yapılabilir bir iş.
- **Yerel ağdaki HTTP cihazları**: `host_permissions` ile mixed content
  sorunu yok. Zaten yazılıydı.

**Gerçekten imkânsız olanlar (ve artık ölçümle biliyorum):**

- **Ham UDP.** `chrome.sockets` MV3'te yok — Chrome Apps ile birlikte kalktı ve
  geri gelmiyor. Bu, **ArtNet, E1.31, DDP, TPM2.net**'i doğrudan konuşmayı
  imkânsız kılıyor. `WebTransport` var ama QUIC konuşan bir sunucu gerektiriyor,
  bir ArtNet cihazına yaramaz. Bu protokoller ancak bir köprü (WLED'in kendi
  HTTP API'si gibi) üzerinden dolaylı olarak kullanılabilir.
- **Dinleyen soketler.** Boblight, flatbuffer ve protobuf sunucuları bir porta
  bağlanıp istemci beklemek zorunda; eklentinin soket dinleme yolu yok.
- **Raspberry Pi'ye özgü grabber'lar** (dispmanx, amlogic, drm, framebuffer) ve
  SPI/PWM çıkışı: bunlar bir işletim sistemi sürücüsü, tarayıcının erişebileceği
  bir cihaz değil.

Yani doğru ayrım "tarayıcı vs yerel uygulama" değil: **cihaza giden bir yol var
mı yok mu.** USB, HID, seri ve HTTP için var; ham soket için yok.

## 3. Platformlar

Odak **Windows + Chrome**, ama mimari baştan bunun ötesini hedefliyor. Her satır
bir iddia değil, bir kısıt listesi.

| Platform | Tarayıcı | Panel | Ekran yakalama | Yakalama kartı | Seri (Arduino) | HID/USB cihaz | Ağ cihazı |
|---|---|---|---|---|---|---|---|
| **Windows** | **Chrome/Edge** | ✅ | ✅ eklenti | ✅ | ✅ Web Serial | ✅ WebHID/WebUSB | ✅ |
| Windows | Firefox | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| macOS | Chrome | ✅ | ✅ eklenti | ✅ | ✅ | ✅ | ✅ |
| macOS | Safari | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Android | Chrome | ✅ | ❌ | ⚠️ OTG kart | ❌ | ⚠️ WebUSB var | ✅ |
| Android TV | Chrome | ✅ | ❌ | ⚠️ | ❌ | ⚠️ | ✅ |
| Apple TV | Safari (tvOS 17+) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |

Yakalama kartı satırı önemli: mobil ve TV'de ekran yakalama yok ama **bir USB
yakalama kartı webcam olarak görünüyor**, yani oralarda bile gerçek bir
ambilight kaynağı mümkün.

Üç gerçek, dürüstçe:

1. **Web Serial yalnız Chromium'da var.** Firefox ve Safari onu uygulamayı
   reddetti. Bu platformlarda Arduino'ya doğrudan bağlanmak mümkün değil —
   ve bu bizim düzeltebileceğimiz bir şey değil.
2. **Mobil ve TV'de ekran yakalama yok.** `getDisplayMedia` mobil Chrome ve
   Safari'de yok. Ama bu platformlar **kumanda** olarak tam değerli: efekt seç,
   renk ayarla, profil yükle — hepsi ağ cihazına ya da çalışan bir masaüstü
   örneğine gider.
3. **Ağ cihazı desteği her platformu açıyor.** WLED'e HTTP ile bağlanmak her
   yerde çalışıyor. Bu yüzden ağ cihazları yol haritasında efektlerden hemen
   sonra: yakalamanın olmadığı her platformda uygulamayı yine de kullanılır
   kılan tek madde bu.

Bunu mimaride karşılayan şey **çıkış katmanının soyut olması**: `serial.ts` bir
`FrameSink` uyguluyor, WLED sürücüsü de aynı arayüzü uygulayacak, ve panel
hangisinin bağlı olduğunu bilmek zorunda kalmayacak.

## 4. Yol haritası

Sıra etkiye göre, ve her biri bir öncekinden bağımsız:

1. **Efekt motoru** — uygulamayı ekran yakalamasız kullanılır kılıyor, ve
   tarayıcıda Hyperion'dakinden daha ucuz. Mobil ve TV'de çalışabilen ilk
   gerçek özellik de bu.
2. **Çıkış katmanını soyutla** — `FrameSink` arayüzü; seri port onu zaten
   uyguluyor, ağ cihazları için önkoşul.
3. **WLED sürücüsü** — kendi firmware'imizi zorunlu olmaktan çıkarıyor ve
   Web Serial'ı olmayan her platformu açıyor.
4. **Ses görselleştirici** — Web Audio, küçük iş, büyük görünürlük, her
   platformda çalışıyor.
5. **Yakalama kartı girişi** — `enumerateDevices` + `getUserMedia`. Ekran
   yakalamanın olmadığı platformlarda tek gerçek kaynak, ve **DRM'li içeriği
   çözen tek yol**: sinyal HDMI splitter'dan sonra şifresiz geliyor.
6. **Öncelik katmanları** — ön plan/arka plan efekti, kaynak öncelikleri.
   Efektler ve ses gelince bunlar anlam kazanıyor.
7. **Olaylar** — sekme gizlenince duraklat, zamanlanmış aç/kapat.
8. **Çoklu örnek** — mimariyi en çok değiştiren madde, o yüzden en sonda.

### Yapılandırılabilirlik kuralı

Hiçbir şey bu depodaki düzeneğe göre sabitlenmeyecek. 108 LED, 35/19/35/19
kenarlar, 16:9, 1500 mA güç bütçesi — hepsi **varsayılan**, hiçbiri varsayım.
Firmware tarafında bu zaten böyle (`AxC` ile çalışma zamanı yapılandırması,
NVS'te saklanıyor); panel tarafında da yerleşim editörü her knob'u açıyor.
Yeni bir özellik eklenirken ölçüt şu: *başka bir monitörü, başka bir şeridi,
başka bir beslemesi olan biri bunu ayarlayabiliyor mu?*
