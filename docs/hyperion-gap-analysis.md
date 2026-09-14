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

> **2026-09-14 denetimi.** Burada "ArtNet/E1.31/DDP ham UDP istiyor, imkânsız"
> yazıyordu. İddianın kendisi doğru ama **eksikti**, ve eksik olan kısım
> yol haritasını değiştiriyor. Tam analiz `docs/firmware-and-devices.md` §4'te.

Tarayıcı ham UDP açamıyor — bu ölçüldü (`chrome.sockets` eklentide tanımsız) ve
tarayıcı platformunda UDP soketi diye bir şey yok. ArtNet (6454), E1.31 (5568),
DDP (4048), TPM2.net (65506), UDP-RAW ve H801 bu yüzden doğrudan kapalı.

**Ama bir cihazın Hyperion'un kullandığı taşımayı kullanması, tek taşımasının o
olduğu anlamına gelmiyor.** WLED'in örneği belirleyici: Hyperion'un
`LedDeviceWled` sınıfı `LedDeviceUdpDdp`/`LedDeviceUdpRaw`'dan türüyor, yani
UDP. Oysa WLED'in **WebSocket'i var** (`ws://[ip]/ws`, 0.10.2'den beri
varsayılan açık) ve JSON API'nin LED başına renk verebilen alt kümesini kabul
ediyor: `{"seg":{"i":["FF0000","00FF00",…]}}`. Yani tarayıcıdan WLED'i sürmek
mümkün — Hyperion'un hiç kullanmadığı bir kapıyla. Kısıt ağ değil, ESP'de kare
başına JSON ayrıştırma; **kaç fps olduğu ölçülmedi.**

| Cihaz | Hyperion'un taşıması | Tarayıcıdan |
|---|---|---|
| **WLED** | DDP / WARLS (UDP) | **✅** JSON over WebSocket |
| **Home Assistant** | REST | **✅** HTTP + WebSocket |
| Philips Hue | REST + DTLS-UDP akış | kısmen — REST var, akış yok |
| Nanoleaf | REST + UDP akış | kısmen — REST var, akış yok |
| Cololight, AtmoOrb, Yeelight, FadeCandy | UDP / ham TCP | ❌ |
| ArtNet, E1.31, DDP, TPM2.net, UDP-RAW, H801 | UDP | ❌ |

**Ve asıl cevap:** tarayıcının UDP açamamasını çözmeye çalışmak yanlış soru.
Firmware bizim. ESP32-S3 bir WebSocket sunucusu koşabiliyor ve **bugün seri
porttan giden `Afx` karesinin aynısını** taşıyabiliyor — aynı ayrıştırıcı, aynı
test takımı, üçüncü bir protokol maliyeti yok. iOS'u açan da bu: iPhone'da Web
Serial, WebUSB, WebHID ve Web Bluetooth'un dördü de yok, tek yol ağ.

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

Odak **Windows + Chrome**, ama mimari baştan bunun ötesini hedefliyor.

> **2026-09-14 düzeltmesi — bu bölümdeki en kesin iddiam yanlıştı.**
> Burada "mobilde ekran yakalama yok, `getDisplayMedia` mobil Chrome ve
> Safari'de yok" yazıyordu. Bir iPhone'dan gelen iki ekran görüntüsü bunu
> çürüttü: iOS Safari, panelin **sayfa içi** yakalamasını açtı, iOS'un kendi
> "Ekran Paylaşma" sayfasını gösterdi ("Tüm Ekranı Paylaş" seçenekli, ReplayKit
> kayıt göstergesiyle), ve panel `canlı 1180×2556` okudu — yani **cihazın tam
> ekranı, doğal çözünürlükte**, siyah kenar algılayıcısı koşarak ve LED'ler
> motorun örneklediği renklerle dolarak.
>
> Ve kaynaklar hâlâ aksini söylüyor: caniuse'un **Ağustos 2026** verisinde
> "iOS Safari 26.6: desteklenmiyor", MDN aynı, WebKit'in Safari 26.0 duyurusunda
> ekran yakalama hiç geçmiyor.
>
> **Bu çelişki kapanmadı** ve kapanması gereken üç ihtimal var: (a) uyumluluk
> tabloları geride, (b) cihazda bir **özellik bayrağı** açık (iOS'ta Ayarlar →
> Safari → İleri Düzey → Özellik Bayrakları), (c) cihaz bir iOS beta'sında.
> (b) ve (c) durumunda bu, üstüne ürün kurulabilecek bir yetenek **değil**.
> Ayırt edecek olan ölçüm §3.1'de.

### 3.1 Bunun nasıl ölçüleceği

Tarayıcıya sormak, tabloya sormaktan üstün — ve bu projede tablolar **üç kez**
yanıldı: `MediaStreamTrackProcessor`'ın worker'da olup olmadığı, yakalama
kartları ile HID/FTDI cihazlarının mümkün olup olmadığı, ve şimdi bu. O yüzden
artık panelin **Cihaz** sayfasında bir yetenek tablosu var (`lib/capabilities.ts`):
tarayıcıya doğrudan soruyor ve cevabı gösteriyor. Destek konuşmasının ilk adımı
da bu — "şu sayfanın fotoğrafını gönder", yirmi sürüm sorusundan fazlasını
cevaplıyor.

Kapatılması gereken üç soru, ve üçünü de yalnız gerçek cihaz cevaplayabilir:

1. **Bayrak mı, varsayılan mı?** Aynı iPhone'da Safari → Ayarlar → İleri Düzey →
   Özellik Bayrakları'nda ekran yakalamayla ilgili bir şey açık mı; ve iOS
   sürümü kaç. Bayraksa ürün buna dayanamaz.
2. **Arka planda yaşıyor mu?** Bu, iOS'taki E4 ve mimari açıdan belirleyici olan
   soru: yakalamayı başlat, Safari'den çık, başka bir şey izle, 60 s sonra
   dön — kare sayacı ilerledi mi. iOS arka plandaki sayfayı askıya alıyorsa
   "ekranı takip eden ambilight" iPhone'da **yok**, çünkü ambilight'ın tüm
   anlamı sen başka bir şey izlerken çalışması. Bu durumda iOS'un rolü kumanda
   ve önizleme olur, kaynak değil.
3. **DRM.** Netflix/Disney+ ReplayKit akışında siyah geliyor mu. Masaüstünde
   geliyor; burada da gelmesi beklenir, ama beklenti ölçüm değil.

### 3.2 Matris

Sütunlar artık **ölçülen** ile **varsayılan**ı ayırıyor. `✅` bir yerde
görülmüş, `◻` yalnız dokümantasyondan, `❌` ölçülmüş ya da yapısal olarak
imkânsız.

| Platform | Tarayıcı | Panel | Ekran yakalama | Yakalama kartı | Seri (Arduino) | HID/USB | Ağ cihazı |
|---|---|---|---|---|---|---|---|
| **Windows** | **Chrome/Edge** | ✅ | ✅ eklenti (ölçüldü, 108 fps) | ◻ | ✅ Web Serial | ✅ WebHID/WebUSB (ölçüldü) | ◻ |
| Windows | Firefox | ✅ | ◻ sayfa | ◻ | ❌ | ❌ | ◻ |
| macOS | Chrome | ✅ | ◻ eklenti | ◻ | ◻ | ◻ | ◻ |
| macOS | Safari | ✅ | ◻ sayfa | ◻ | ❌ | ❌ | ◻ |
| **iOS** | **Safari** | ✅ | **✅ sayfa (ölçüldü, 1180×2556)** — §3'teki uyarıyla | ◻ | ❌ | ❌ | ◻ |
| Android | Chrome | ✅ | ◻ — iOS'tan sonra bu da yeniden ölçülmeli | ◻ OTG kart | ❌ | ◻ WebUSB | ◻ |
| Android TV | Chrome | ✅ | ◻ | ◻ | ❌ | ◻ | ◻ |
| Apple TV | Safari (tvOS) | ✅ | ◻ | ❌ | ❌ | ❌ | ◻ |

Android satırındaki `◻`'ler artık ayrı bir not hak ediyor: iOS hakkındaki
iddiam yanlış çıktıysa Android hakkındaki iddiam da **aynı kaynaktan** geliyordu
ve aynı şüpheyi hak ediyor. Ölçülmeden `❌` yazılmayacak.

### 3.3 Bunun mimariye üç sonucu

**(1) Motor yalnız eklentide yaşayamaz.** Eklenti bir Chromium-masaüstü
çözümü, ve var olma sebebi tek: arka plana düşen sekmenin kısıtlanması. Oysa
iPhone'da çalışan şey **sayfanın kendi yakalaması**ydı — `lib/live-sampler.ts`,
canlı önizleme için yazılmış olan. Yani sayfa içi motorun yarısı zaten var ve
tesadüfen değil: önizlemeyi motorun kendi modülleriyle kurma kararı, şimdi
ikinci bir host'un temeli oluyor.

Doğru yapı: **motor host'tan bağımsız**, iki host var — Chromium masaüstünde
eklenti (kısıtlanmama uğruna), diğer her yerde sayfa. Eklenti artık "tek yol"
değil, "bir platformdaki iyileştirme".

**(2) Ağ sürücüsünün önceliği yükseldi.** iOS Safari'de Web Serial yok,
WebUSB yok, WebHID yok, Web Bluetooth yok — ve bunlar bizim düzeltebileceğimiz
şeyler değil. Bir iPhone'dan şeride giden **tek** yol ağ. Yani "iOS ekranı
okuyabiliyor" bulgusu, ağ sürücüsü olmadan hiçbir şeye yaramıyor: yakalanan
kare gidecek yer bulamıyor. Ağ sürücüsü artık yol haritasında efekt motorunun
yanında, "ikinci" değil.

**(3) `FrameSink` soyutlaması bunun önkoşulu ve artık ertelenemez.** Bugün
kareler tek bir yere gidiyor. Hem sayfa host'u hem ağ sürücüsü aynı dikişe
ihtiyaç duyuyor.

## 4. Yol haritası

Sıra etkiye göre. **2026-09-14'te yeniden sıralandı:** iOS bulgusu (§3) çıkış
katmanını ve ağ sürücüsünü yukarı taşıdı — bir iPhone ekranı okuyabiliyorsa ama
şeride ulaşamıyorsa bulgunun hiçbir değeri yok.

1. **Çıkış katmanını soyutla — ✅ 2026-09-14.** `lib/engine/sink.ts`:
   `FrameSink` **renk alıyor, bayt değil**, çünkü her cihaz bizim baytlarımızı
   konuşmuyor — WLED'e bir `Afx` karesi vermek, kendi kodlamamızı renklere geri
   çözüp metin olarak yeniden kodlamak demekti. Kodlama da eklentiden çıkıp
   test edilen koda taşındı (`lib/engine/encode.ts`). Kuyruk yok: aynı anda tek
   kare uçuşta, gerisi düşürülüp sayılıyor — bir WiFi takılması bir saniyelik
   geçmişi teslim etmesin diye, ki bu bir seri porttan daha çok ağda önemli.
2. **Ağ sürücüsü — ✅ 2026-09-14.** `lib/engine/net.ts` iki sink veriyor:
   `createSocketSink` **seri portun taşıdığı baytların aynısını** bir
   WebSocket'e yazıyor (aynı ayrıştırıcı, aynı firmware testleri, yeni protokol
   yok), `createWledSink` ise WLED'in kendi JSON soketini konuşuyor
   (`lib/engine/wled.ts`). Soket enjekte ediliyor, bu yüzden bağlanma, yeniden
   bağlanma, backoff, kapalıyken gönderme ve uçuş ortasında kapanma Node'da
   sahte bir soketle koşuluyor — gerçek bir cihaza karşı güvenilir biçimde
   provoke edilemeyecek yollar bunlar. Panel tarafı da bitti: LED donanımı
   sayfasında taşıma seçici, adres alanı ve WLED segmenti var, cihaz sayfası da
   taşımanın kendi sayaçlarını (yeniden bağlanma, düşen kare) gösteriyor.

   **Kalan:** firmware'in WebSocket sunucusu — `createSocketSink`'in
   konuşacağı uç. Ölçülmemiş: WLED'in JSON'la ulaşılabilir kare hızı
   (`docs/firmware-and-devices.md` N1).
3. **Motoru host'tan ayır** — Chromium masaüstünde eklenti (kısıtlanmama
   uğruna), diğer her yerde sayfa. `lib/live-sampler.ts` yakalama yarısını
   zaten yapıyor; eksik olan çıkış yarısı ve host seçimi. §3'teki (2) numaralı
   ölçüm olumsuz çıkarsa bu madde iOS'u kurtarmaz ama macOS Safari'yi ve
   Firefox'u yine de açar.
4. **Efekt motoru** — uygulamayı ekran yakalamasız kullanılır kılıyor, ve
   tarayıcıda Hyperion'dakinden daha ucuz.
5. **Ses görselleştirici** — Web Audio, küçük iş, büyük görünürlük, her
   platformda çalışıyor.
6. **Yakalama kartı girişi** — `enumerateDevices` + `getUserMedia`. Ekran
   yakalamanın olmadığı platformlarda tek gerçek kaynak, ve **DRM'li içeriği
   çözen tek yol**: sinyal HDMI splitter'dan sonra şifresiz geliyor.
7. **Öncelik katmanları** — ön plan/arka plan efekti, kaynak öncelikleri.
   Efektler ve ses gelince bunlar anlam kazanıyor.
8. **Olaylar** — sekme gizlenince duraklat, zamanlanmış aç/kapat.
9. **Çoklu örnek** — mimariyi en çok değiştiren madde, o yüzden en sonda.

### Yapılandırılabilirlik kuralı

Hiçbir şey bu depodaki düzeneğe göre sabitlenmeyecek. 108 LED, 35/19/35/19
kenarlar, 16:9, 1500 mA güç bütçesi — hepsi **varsayılan**, hiçbiri varsayım.
Firmware tarafında bu zaten böyle (`AxC` ile çalışma zamanı yapılandırması,
NVS'te saklanıyor); panel tarafında da yerleşim editörü her knob'u açıyor.
Yeni bir özellik eklenirken ölçüt şu: *başka bir monitörü, başka bir şeridi,
başka bir beslemesi olan biri bunu ayarlayabiliyor mu?*
