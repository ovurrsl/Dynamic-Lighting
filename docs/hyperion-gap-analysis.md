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

### (A) Efekt motoru — ✅ 2026-09-14 · 11 efekt

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

### (B) Ağ LED cihazları — kısmen: iki taşıma, ve geri kalanı UDP

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

**Kayıtlı ama ölçülmemiş bir kısıt: karışık içerik.** Yukarıdaki "kısmen"lerin
pratikte ulaşılabilir olup olmadığını bu belirliyor. Panel HTTPS'te barınıyor;
bir Hue köprüsü kendi imzaladığı sertifikayla HTTPS, bir Nanoleaf ise düz HTTP.
HTTPS bir sayfadan ikisine de istek atmak tarayıcı tarafından engelleniyor — API
REST olsa bile. Eklentinin `chrome-extension://` sayfası host izinleriyle bunu
aşabilir, ama **bu ölçülmedi ve cihaz olmadan ölçülemez**. Yani tablodaki
"kısmen" satırları "API uygun" demek, "bugün çalışır" demek değil.

**Ve asıl cevap:** tarayıcının UDP açamamasını çözmeye çalışmak yanlış soru.
Firmware bizim. ESP32-S3 bir WebSocket sunucusu koşabiliyor ve **bugün seri
porttan giden `Afx` karesinin aynısını** taşıyabiliyor — aynı ayrıştırıcı, aynı
test takımı, üçüncü bir protokol maliyeti yok. iOS'u açan da bu: iPhone'da Web
Serial, WebUSB, WebHID ve Web Bluetooth'un dördü de yok, tek yol ağ.

### (C) Ses yakalama (müzik görselleştirici) — ✅ 2026-09-14

`libsrc/grabber/audio`, `schema-grabberAudio.json`. **Tarayıcıda bedava**:
`getUserMedia({audio:true})` + `AnalyserNode`. Hyperion'un Windows/Linux'a ayrı
ayrı yazdığı şey bizde tek bir Web Audio çağrısı. Ayrıntısı §4 madde 5'te.

### (D) Öncelik ve kaynak katmanları — ✅ 2026-09-14

`priority.ts` vardı ama onu besleyen kaynaklar yoktu. Üçünün de durumu:

- `backgroundEffect` — ✅ **bitti.** Muxer yazıldığı günden beri bir arka plan
  yuvası ayırıyordu (`BACKGROUND_PRIORITY`, `clearAll()` tarafından bilerek
  korunuyor, boşta kontrolü tarafından görmezden geliniyor) ve oraya hiçbir şey
  kaydolmuyordu — mekanizma tamamlanmış ve ulaşılamazdı. Artık yapılandırmada
  bir katman: renk ya da efekt, ve **biten bir yakalama siyahlık değil onu
  bırakıyor.** Analizin kendi cümlesi olan "ekran karardığında arkada sıcak
  beyaz kalsın" isteği karşılanıyor.
- `foregroundEffect` — ✅ **bitti**, ama bizde adı `startup`: Hyperion'un adı
  bir açılış animasyonu için kafa karıştırıcı. Öncelik 1'de, her şeyin üstünde,
  süresi dolunca kendiliğinden bırakıyor.
- `instCapture` — **bilinçli olarak farklı.** Kaynak başına *öncelik*
  açılmıyor: bizim öncelik tablomuz gerekçeli ve panelde görünür bir katman
  listesi var, yani ham sayıları açmak kullanıcıyı tarif edemeyeceği bir kazanç
  için tutarlı bir tasarımı bozmaya davet etmek olurdu. Hyperion onları açıyor
  çünkü katmanlanması başka türlü görünmez.

  **Yakalama katmanının hareketsizlik zaman aşımı ise kaldırıldı**, ve bunu
  arka plan zorladı: hiçbir şey göndermeyen bir ekran yakalaması ezici
  çoğunlukla BOZUK değil DURAĞAN bir ekran — kare değişim başına geliyor, yani
  kimsenin dokunmadığı bir masaüstü tasarımı gereği sessiz. Arka plan
  yapılandırılmışken yakalamayı zaman aşımına uğratmak, biri fareyi
  kıpırdatmayı bıraktığı anda şeridi arka plana veriyor ve ilk değişimde geri
  alıyor olurdu: boş bir masada ekran ile sıcak beyaz arasında titreyen bir
  şerit.

  Gerçekten biten bir yakalama zaten ve daha iyi yakalanıyor: iz `onEnd`
  tetikliyor, ki bu çıkarım değil olgu. Ses zaman aşımını koruyor çünkü canlı
  bir mikrofon hiçlik değil sessizlik gönderiyor, yani sessiz bir ses katmanı
  gerçekten ölü bir giriş demek.

  **Ölçülemedi:** Chromium'un durağan bir ekranda kare göndermeye devam edip
  etmediği. Bu ortamda Xvfb altında gerçek ekran yakalama hiç başlamıyor (0 fps,
  katman yok). Muxer seviyesinde etkileşimi kanıtladım; yukarıdaki tasarım iki
  durumda da doğru olduğu için ölçüm artık kritik değil.

İki karar ve ikisi de teste dayanıyor:

**Arka plan `idleIfEmpty()` için gerçek bir katman.** Bu kontrol arka plan
yuvasını atlıyordu — oraya hiçbir şey kaydolamazken doğruydu, ve şimdi arka
planın var olma sebebi olan tam durumda şeridi karartırdı.

**Açılış katmanının kendi son tarihi var, muxer'ın hareketsizlik zaman aşımı
değil.** O zaman aşımı son GİRDİDEN itibaren ölçüyor; animasyonlu bir katman
her tick'te kare besliyor, yani kendi bitişini sonsuza kadar öteliyordu. Düz
renk doğru sona eriyor, efekt hiç ermiyordu — yani ilk test ettiğin durumda
doğru olan cinsten bir hata. Tarayıcı probu yakaladı, sonra o yolu sabitleyen
bir test yazıldı.

### (E) Çoklu örnek (instance) — ✅ 2026-09-14

Hyperion bir kurulumda birden fazla LED örneği sürebiliyor, her biri kendi
yerleşimi ve cihazıyla. Masa + TV aynı anda. Artık bizde de var; ayrıntısı §4
madde 9'da.

### (F) Olaylar — ✅ 2026-09-14, CEC hariç

`schema-schedEvents` (zamanlanmış aç/kapat) yapıldı; ayrıntısı §4 madde 8'de,
ve kurallar şerit başına adreslenebiliyor.

`schema-osEvents` (uyku/kilit) ayrı bir özellik olarak YAPILMADI ve gerekmiyor:
uyku, kilit ve ekran kapanması yakalama izini bitiriyor, motor da bunu
kaybolmuş kaynak olarak bildiriyor (`lost`). Yani olay zaten işleniyor —
Hyperion'un ayrı bir dinleyiciye ihtiyaç duymasının sebebi, onun yakalayıcısının
böyle bir sinyali olmaması.

`schema-cecEvents` tarayıcıda imkânsız ve zaten monitör ambilight'ında
alakasız.

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

   Firmware'in ucu da bitti: `pio run -e nano_esp32_net` WiFi'ı linkleyip
   `ws://<adres>/afx` üzerinde bir WebSocket sunuyor, ve soket handler'ı karenin
   ne olduğunu **bilmiyor** — aldığı baytları kablonun beslediği ayrıştırıcının
   ikizine itiyor. Ayrı bir env, çünkü WiFi'ı linklemenin bedeli fiziksel: LED
   çekirdeğine düşen WiFi kesme işi RMT bozulmasının en yaygın sebebi. Kimlik
   bilgileri paneldeki Cihaz sayfasından `AxC` ile giriliyor; kart SSID'yi ve
   adresini bildiriyor, parolayı asla.

   **Ölçülmemiş:** WLED'in JSON'la ulaşılabilir kare hızı (N1), WiFi
   linkliyken `shortFrames` (N2) ve kendi soketimizin kare hızı (N3) —
   üçü de `docs/firmware-and-devices.md` §5'te.
3. **Motoru host'tan ayır — ✅ 2026-09-14.** Motorun tamamı
   `lib/engine/runtime.ts`'e taşındı ve host enjekte ediliyor; eklentinin
   `offscreen.ts`'i 875 satırdan 199'a indi ve artık üç şey yapıyor: yakalama
   aç, canvas ver, mesaj taşı. Sayfa host'u (`lib/page-host.ts`) **aynı**
   motoru koşturuyor — iki motor olsaydı biri çürürdü.

   Platformlar arasında gerçekten ayrışan tek yer kare kaynağıydı, o da
   `lib/engine/source.ts`'e çıkarıldı: `MediaStreamTrackProcessor` (yalnız
   Chromium), `<video>` + `requestVideoFrameCallback`, ve rVFC'siz tarayıcılar
   için `<video>` + zamanlayıcı. Üçü de `createImageBitmap`'e aynı şeyi
   veriyor, yani **fark ilk aşamada bitiyor**, motorun içinde değil.

   **Üçü de gerçek bir tarayıcıda, gerçek ekran yakalamasıyla ölçüldü**
   (Chromium 141, 1280×1024, loopback):

   | Rota | Teslim | Varış p50 | Düşen |
   |---|---|---|---|
   | akış (MSTP) | 59.1 fps | 16.8 ms | 0 |
   | video + rVFC | 58.2 fps | 16.7 ms | 0 |
   | video + zamanlayıcı | 39.7 fps | 24.6 ms | 0 |

   Zamanlayıcı rotası ölçülebilir biçimde daha kötü ve sebebi yapısal: rVFC
   kare başına — yani ekran DEĞİŞTİKÇE — ateşlenirken zamanlayıcı aynı resmi
   kendi temposunda yeniden okuyor. Firefox'un bugünkü durumu bu, ve panel
   hangi rotanın koştuğunu yazıyor: tek bir "fps" sayısı üçünü birbirine
   karıştırırdı.

   **Kaçınılmaz kısıt, saklanmadan söylendi:** bir sayfa, sekmesi gizlendiğinde
   ya da küçültüldüğünde kısıtlanıyor. Motorun en başta eklentiye taşınmasının
   sebebi tam olarak buydu ve zamanlayıcılarla etrafından dolaşılamıyor. Yani
   sayfa host'u telefon, ikinci makine ya da eklentisiz tarayıcı için dürüst;
   tek monitörde tam ekran oyun için değil. Panelde Cihaz sayfasında bu
   cümlenin kendisi yazıyor.
4. **Efekt motoru — ✅ 2026-09-14, on ikiye çıktı 2026-09-16.** `lib/engine/effects.ts`:
   on iki efekt (gökkuşağı, renk lekeleri, nefes, mum, kuyruklu yıldız, polis,
   plazma, parıltı, tarama, silme, takip, ateş), kendi paneli, iki host'ta da
   çalışıyor. Sayı `EFFECT_KINDS.length`'ten okunuyor; panel de öyle.

   **Hyperion'un yaptığını yapmadık.** Onun efekt motoru `Effect.cpp` içinde
   **CPython 3 gömüyor** (`PyImport_ImportModule`), efektler Python betiği
   olarak yazılabilsin diye. Bir avuç animasyon için devasa bir bağımlılık, ve
   tarayıcıda bu WASM Python taşımak demek olurdu. Buradaki her efekt birkaç
   satır aritmetik, deterministik ve test edilmiş (42 test).

   Üç kural, üçü de karar:

   - **İndeks değil geometri.** Efektlere her LED'in gerçekte nereye baktığı
     veriliyor — örnekleyicinin kullandığı dikdörtgenlerin aynısı — böylece
     gökkuşağı çerçevenin etrafında dönüyor ve kuyruklu yıldız şeridin
     fiziksel olarak sarıldığı yönde koşuyor. `i / count` ile yazılmış bir
     efekt yalnız yazıldığı rig'de doğru görünür.
   - **Doğrusal ışık.** Renkler insanın seçtiği yerde (renk çemberi) sRGB'de
     kuruluyor ve bir kez çözülüyor; başka yerde yapmak transfer fonksiyonunu
     iki kez uygulardı.
   - **`Math.random` hiç yok.** Titreşen efektler tohumlanmış bir üreteç
     kullanıyor, yani bir mum testte kare kare tekrarlanabilir. Aksi hâlde
     "ateş efekti fazla seğiriyor" ile "ateş efektinde hata var" ayırt
     edilemezdi.

   Bir de gerçek hata çıktı ve düzeltildi: `along` 0..1 dahil olduğu için ilk
   ve son LED dikişte çakışıyordu — kapanış segmenti toplama katılmadan her
   sarmalı olan efekt dikişte iki baş yakıyordu, ve gerçek bir çerçevede o iki
   LED köşede yan yana.
5. **Ses görselleştirici — ✅ 2026-09-14.** `lib/engine/audio.ts` (saf analiz)
   + `lib/engine/audio-input.ts` (tarayıcı tutkalı) + kendi paneli. Üç
   görselleştirici: spektrum, seviye, nabız. İki giriş: mikrofon (her
   tarayıcı, iPhone dahil) ve sekme/sistem sesi (yalnız Chromium — Safari ve
   Firefox ses izi olmayan bir ekran paylaşımı veriyor, ve bu söyleniyor).

   Kararların hepsi analizde:

   - **Bantlar logaritmik, doğrusal değil.** FFT frekansta eşit aralıklı bin
     veriyor; onları şerite eşit dağıtmak müziğin tamamını ilk onda birine
     tıkıyor — 60 Hz'lik bir kick ile 12 kHz'lik bir hi-hat yüz LED'de dört
     LED arayla düşerdi. Duyma kabaca logaritmik, bantlar da öyle.
   - **Kazanç malzemeyi takip ediyor.** Müzik -20 ile -6 dB arasında herhangi
     bir yerde master'lanıyor, odanın mikrofon seviyesi ise belirsiz. Sabit
     kazanç ya hiç yanmayan ya sürekli beyaz bir şerit verir; tepe takipçisi
     normalize ediyor — hızlı yükselen, yavaş düşen.
   - **Gürültü tabanı.** Sessiz bir oda sessiz değil: fan, disk, şebeke
     uğultusu. Taban olmadan şerit sonsuza kadar hafifçe titrer ve kullanıcı
     haklı olarak bozuk olduğuna karar eder.

   Panelde "duyulan seviye" ölçeri var ve **görselleştiricinin kendi tepkisini
   değil genel seviyeyi** gösteriyor: şerit odanın karşısında, ve "motor bir
   şey duyuyor mu" sorusu şeride bakmadan cevaplanabilmeli. Nabız yalnız bası
   dinlediği için onun tepkisini göstermek, basssız müzikte düz sıfır okuyup
   kullanıcıyı gayet çalışan bir girişi kontrol etmeye gönderirdi.
6. **Yakalama kartı girişi — ✅ 2026-09-14.** `lib/engine/devices.ts` +
   yapılandırmada `capture.source` ve `capture.deviceId` + Yakalama sayfasında
   kaynak seçici.

   Bir yakalama kartı tarayıcıya **kamera** olarak görünüyor, yani akış
   açıldıktan sonra hiçbir şey değişmiyor — aynı iki kare kaynağı okuyor. İş
   tamamen BİRİNİ SEÇMEKTE, ve keskin kenarlar orada:

   - **İzin verilene kadar etiketler boş.** `enumerateDevices` izin
     verilmeden dört tane `""` döndürüyor, ve dört boş satır gösteren bir
     seçici hiç seçici olmamasından kötü. "Cihaz yok" ile "cihaz var ama
     adını söyleyemem" farklı cümleler ve farklı düğmeler istiyor.
   - **Yakalama kartı ile web kamerası ayırt edilemiyor.** İkisi de video
     girişi ve ad, üreticinin yazdığı her neyse o. Tahminle filtrelemek,
     kartı beklenmedik bir ad taşıyan herkesin kartını gizlerdi — o yüzden
     hiçbir şey filtrelenmiyor.
   - **`deviceId` kalıcı değil**, site verisi temizlenince dönüyor. Saklanan
     id güncel listeye karşı doğrulanıyor: eksikse cümle kuruluyor, "ilk
     bulduğuna geç" yapılmıyor. Sessizce başka bir kamerayı açmak, birinin
     ambilight'ının kendi yüzünü takip etmesinin yolu.

   Gerçek tarayıcıda uçtan uca doğrulandı (Chrome'un sahte cihazı): listele →
   seç → uygula → başlat, 1920×1080, 0 düşen kare.
7. **Öncelik katmanları — ✅ 2026-09-14.** Muxer (`lib/engine/priority.ts`)
   yazıldığından beri duruyordu ve 48 testi vardı; eksik olan onu besleyecek
   bir şeydi. Artık yakalama, efekt, ses, test deseni ve renk birer KATMAN:

   | Öncelik | Kaynak | Neden orada |
   |---|---|---|
   | 50 | test deseni | bir ölçüm; her şeyin önüne geçmeli |
   | 100 | süreli renk | bir kesinti; üstüne efekt oturamamalı |
   | 150 | efekt | |
   | 160 | ses | |
   | 200 | süresiz renk | bir ZEMİN; efektten sonra dönülecek yer |
   | 240 | yakalama | açık bıraktığın şey, gerisi "bunun yerine" |

   **Bir efekti başlatmak artık yakalamayı durdurmuyor** — üstünde duruyor, ve
   efekti durdurmak yakalamayı geri veriyor. Süreli renk kendiliğinden sona
   erip altındakini ortaya çıkarıyor.

   Renk/süreli renk ayrımı yazarken yanlış yaptığım ve testin yakaladığı
   yer: `setColor`'a süre verilip verilmemesi PRİORİTEYİ belirliyor, çağıran
   bir sayı seçmiyor. "Şeridi sıcak beyaza ayarla" efektten sonra dönülecek
   bir zemin; "kırmızı yak" bir efektin içinden geçmesi gereken bir bildirim.
   Aynı çağrı ikisini de yapıyor.

   Arayüz: Genel bakış sayfasında katman listesi, kazanan işaretli, her
   katmanda kendi durdurma düğmesi. Renk sayfası da gerçekten şeride
   bağlandı — "Şeride gönder" ve "5 saniye yak".
8. **Olaylar** — ✅ **bitti.** `lib/engine/schedule.ts` saf bir zaman kuralı
   motoru: kural saati yerel dakikada, günler 0..6 (boş = her gün), eylem
   dur/yakala/efekt/renk. Saat `momentFrom(new Date(), clock())` ile ENJEKTE
   ediliyor — `Date.now()`'a bakan bir zamanlayıcı ancak beklenerek test
   edilebilirdi, 22:00 kuralı için de bu "hiç" demek. 14 test.

   İki karar, ikisi de ancak gerçek bir masada görünüyor:

   - **Kural saat onu GEÇERKEN tetikleniyor, saate eşitken değil.** Eşitlik
     aynı kuralı bir dakika boyunca saniyede bir uygulardı; şeritte bu, altmış
     kez baştan başlayan bir efekt demek.
   - **Uyumuş bir makine kaçırdığı kuralların yalnız SONUNCUSUNU alıyor.**
     Akşam dokuzda sabah sekizin ayarına uyanmak yanlış; beş saatlik kuralı
     yarım saniyede oynatmak daha saçma. Eşik 10 dakika: kısıtlanmış bir arka
     plan sekmesi (en kötü ihtimalle dakikada bir) uyku sanılmıyor.

   Listenin "sekme gizlenince duraklat" yarısı zaten çözülmüştü ve ayrı bir
   özellik değil: yakalama izi oturumla birlikte ölüyor, motor da bunu
   kaybolmuş kaynak olarak bildiriyor.

   **Kurallar diskte, motorda değil** — ve bu, tarayıcı probu yenilemeden
   sonra kuralların yok olduğunu gösterdiği için eklendi. Motor bellektir:
   sayfa yenilenince gidiyor, eklentinin offscreen dokümanı da Chrome
   kapanınca. Gecesinde kendini unutan bir zamanlama, zamanlama değildir.
   Sayfa tarafında `localStorage` (`loadStoredSchedule`/`storeSchedule`,
   motor KURULURKEN besleniyor — yalnız zamanlama kartı açıkken tetiklenen
   bir kural zamanlama sayılmaz); eklenti tarafında service worker'ın
   `chrome.storage.local`'ı, offscreen doküman da yüklenirken tam
   yapılandırmada olduğu gibi kuralları isteyerek alıyor. Kural kaydetmek
   dokümanı ayrıca inşa ediyor: bir kural ancak canlı bir motora ulaşırsa
   tetiklenebilir.

   Tarayıcıda ölçüldü: kural kuruldu → sayfa yenilendi → zamanlama sayfasından
   ÇIKILDI → kural saatinde (05:37:00) renk katmanı kendiliğinden geldi,
   "şeritte" olarak işaretli. Kimse bakmıyorken tetiklenmesi zaten
   zamanlamanın tamamı.

   Arayüzde iki cümle, ikisi de talimat değil KISIT: bir sayfada zamanlayıcı
   ekran seçici açamaz (kullanıcı hareketi yok, ve bu tarayıcının kuralı),
   ve uyumuş makine yalnız son kuralı alır.
9. **Çoklu örnek — ✅ 2026-09-14.** Yol haritasının son maddesi. Motor zaten
   modül durumu olmayan bir fabrikaydı, yani iki tane çalıştırmak zor kısım
   değildi. Zor kısım yakalama:

   **Aynı kaynağı okuyan şeritler TEK yakalamayı paylaşıyor.** Optimizasyon
   olduğu için değil — bir `getDisplayMedia` izni onu isteyen çağrıya ait
   olduğu için. İki motor kendi yakalamasını açsaydı iki seçici çıkardı ve
   ikincisinde başka bir pencereyi seçen kullanıcı iki farklı şeyi takip eden
   iki şerit elde ederdi, ekranda bunu açıklayan hiçbir şey olmadan.

   **Farklı kaynak okuyanlar ayrı yakalama alıyor**, ve bu taviz değil özellik:
   ekranı takip eden masa şeridi + HDMI yakalama kartını takip eden TV şeridi,
   TV tarafında DRM karartmasını yenen tek düzen. Gruplama anahtarı tam olarak
   hangi akışın açılacağını belirleyen ayarlar (kaynak, cihaz, kare hızı);
   kırpma ve analiz ızgarası gelen kareye şerit başına uygulanıyor, yani aynı
   ekranın farklı yarılarına bakan iki şerit hâlâ tek yakalama.

   Üç yeni saf modül, 37 test: `fanout.ts` (bir kaynak, N tüketici; referans
   sayımı, tüketici başına idempotent bırakma, hata fırlatan tüketicinin
   tamponu yine de bırakması — üçü de "kırk kareden sonra duran yakalama"
   olarak görünüyor), `instances.ts` (liste modeli; örnek profil DEĞİL: profil
   geçtiğin, örnek yanında çalışan), `pool.ts` (havuz motoru PROXY'lemiyor —
   on yedi metodu saran bir havuz, ikisinin ayrışacağı on yedi yer olurdu).

   **Tarayıcıda ölçüldü** (Xvfb, GPU yok, sahte kaynak — yani kötümser):

   | Şerit | Teslim edilen yakalama | Şerit başına çıkış |
   |---|---|---|
   | 1 | 20.0 fps | 118.7 Hz |
   | 2 | **20.0 fps** | ~100 Hz |
   | 3 | **20.0 fps** | ~77 Hz |

   Yakalama hızı şerit sayısından bağımsız — dağıtım tam olarak bunun için var
   ve iddia ölçülmüş oldu. Çıkış hızı ise şerit başına düşüyor: üç motorun
   120 Hz tick'i tek bir iş parçacığında yumuşatma + kodlama + sink demek.
   Dürüst olmak gerekirse bu ortam kötümser (GPU yok, yazılım canvas) ve
   firmware zaten keyframe'lerden 120 Hz ara kare üretiyor, yani 77 Hz'lik bir
   host hâlâ şeritte 120 Hz veriyor. Ama eğilim gerçek ve gerçek bir makinede
   ölçülmesi gereken bir sonraki sayı bu.

   Arayüz: yeni **Şeritler** sayfası (ad, aç/kapa, seç, ekle, kaldır, şerit
   başına canlı durum) ve kenar çubuğunda ikiden fazla şerit varken görünen
   şerit seçici — çünkü ikinci bir şerit diğer her sayfanın anlamını
   değiştiriyor: yerleşim, yakalama ayarları, kartın ağı ve renk kontrolleri
   artık BİR şeride ait. Seçici tek şeritte hiç render edilmiyor, ki bu her
   yeni kurulum.

   Eski tek yapılandırma **taşınıyor, silinmiyor**: hem `localStorage`'daki
   hem `chrome.storage`'daki eski anahtar okunup ilk şerit yapılıyor, eski
   anahtar da yerinde bırakılıyor (geri dönen biri şeridini yapılandırılmış
   bulsun diye). Zaten kullanmış olan herkesin yerleşimi orada, ve yerleşim bu
   uygulamada yeniden yazılması en pahalı şey.

   Dürüstçe söylenen kısıt, arayüzde de yazıyor: **USB üzerinden motor
   eşleşmiş ilk seri portu açıyor.** Tarayıcı eşleşmiş bir porta onu ayırt
   edebileceğimiz kalıcı bir kimlik vermiyor (`getInfo()` yalnız
   vendor/product veriyor, iki aynı kart aynı sayıları döndürüyor), yani iki
   karta bağlı iki şerit için en az birinde ağ taşıması gerekiyor.

### Yapılandırılabilirlik kuralı

Hiçbir şey bu depodaki düzeneğe göre sabitlenmeyecek. 108 LED, 35/19/35/19
kenarlar, 16:9, 1500 mA güç bütçesi — hepsi **varsayılan**, hiçbiri varsayım.
Firmware tarafında bu zaten böyle (`AxC` ile çalışma zamanı yapılandırması,
NVS'te saklanıyor); panel tarafında da yerleşim editörü her knob'u açıyor.
Yeni bir özellik eklenirken ölçüt şu: *başka bir monitörü, başka bir şeridi,
başka bir beslemesi olan biri bunu ayarlayabiliyor mu?*
