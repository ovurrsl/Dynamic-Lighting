# Hyperion.NG → AmbiFlux: özellik aktarım planı

Hyperion.NG 2.2.2-beta.1 incelendi (sığ klon, 1064 dosya, 31 MB). Bu doküman
onun **her kullanıcı-görünür özelliğini** listeleyip bizim tarayıcı tabanlı
ürüne aktarma sırasını veriyor — kolaydan zora.

Hedef mimari: **Chrome eklentisi + offscreen document.** Donanım: **elindeki
Arduino'lar** (Nano ESP32 birincil). Bu doküman başka cihaz önermiyor.

---

## 1. Önce yapısal gerçek: Hyperion bir sunucu, biz bir tarayıcı istemcisiyiz

Bu, özellik listesinin yarısını doğrudan belirliyor, o yüzden en başta duruyor.

Hyperion arka planda çalışan bir **servis**. Dinlediği portlar var: JSON-RPC
19444, protobuf 19445, flatbuffer 19400, boblight 19333, web arayüzü 8090/8092.
Kendini mDNS/SSDP ile ağa duyuruyor. Başka Hyperion kurulumlarına yönlendirme
yapıyor.

**Tarayıcı bunların hiçbirini yapamaz.** Bir sayfa/eklenti gelen bağlantı kabul
edemez, port dinleyemez, kendini ağa duyuramaz. Bu bir eksiklik değil, tarayıcı
güvenlik modelinin temeli.

Sonuç: Hyperion'un özellikleri üçe ayrılıyor ve bu ayrım pazarlıksız —

| | |
|---|---|
| **Taşınır** | Görüntü→LED hattındaki her algoritma, yerleşim üretimi, kalibrasyon, yumuşatma, letterbox, öncelik arbitrasyonu, efektler |
| **Şekli değişir** | JSON-RPC komut yüzeyi → bizim REST/olay yüzeyimiz; abonelikler → sayfa içi olay veri yolu; yapılandırma import/export → aynı fikir, farklı taşıma |
| **Taşınmaz** | Dinleyen her sunucu, ağ keşfi, yönlendirici, CEC, OS uyku/kilit olayları, sistem tepsisi, uygulama içi güncelleyici, 44 LED sürücüsünün 43'ü |

Son satır için: biz **tek bir cihazı** sürüyoruz, kendi Arduino'muzu, seri
üzerinden. Hyperion'un 44 sürücüsünden bizi ilgilendiren **bir** tanesi var:
`dev_serial/LedDeviceAdalight.cpp`.

---

## 2. Ölçülmüş temeller (2026-09-13, Chromium 141, bu makinede)

Plan tahmine değil ölçüme dayanıyor. Üç şey doğrudan test edildi.

### 2a. Motor nerede yaşayabilir

| Ölçüm | Sonuç | Ne belirliyor |
|---|---|---|
| `MediaStreamTrackProcessor` in `window` | **VAR** | motor bir dokümanda yaşayabilir |
| aynısı DedicatedWorker'da | **YOK** | MDN yanlış; worker'a taşınamaz |
| offscreen `DISPLAY_MEDIA` ömür limiti | **yok** | oturum süresiz yaşar |
| `chrome.desktopCapture` streamId | tek kullanımlık, saniyelerde ölüyor | ekran seçimi kalıcı yapılamaz |

Zincir bir **doküman** gerektiriyor, ve eklentideki offscreen document hem
doküman olan hem **hiç render edilmeyen** tek yer. Bu kesişim başka yerde yok —
eklenti kararı artık kanıta dayanıyor, tercihe değil.

Alternatifler ve neden kaybettiler: **kurulabilir PWA** (penceresi kapanınca
yakalama ölüyor; küçültülünce `visibilityState` hidden), **düz sekme** (aynısı,
daha kötü), **WebUSB** (Arduino CDC, OS sürücüsü arayüzü talep ediyor — Web
Serial doğru API), **yerel yardımcı uygulama** (Hyperion'un ta kendisi, hiçbir
kısıtı yok — ama tarayıcı istiyorsun; bu kaçış yolu olarak kalıyor).

### 2b. Küçültme: elle WebGL yazmaya gerek yok

1280×720 tek-piksel dama deseni → 128×72 (doğru sonuç düz 127-128 gri):

| Yöntem | Sonuç |
|---|---|
| `createImageBitmap(VideoFrame, {resizeQuality:'high'})` | **127, yayılım 0** ✅ |
| `drawImage` + `imageSmoothingQuality:'high'` | **127, yayılım 0** ✅ |
| `resizeQuality:'pixelated'` | 0, saf siyah — aliasing hatası |

`createImageBitmap` yakalamanın verdiği `VideoFrame`'i **doğrudan** kabul ediyor
ve doğru alan ortalaması yapıyor. Hyperion'un D2D yolunun piksellerin %94'ünü
atma problemi bizde yok, ve planladığım iki aşamalı WebGL hattı gereksiz.

### 2c. 120 FPS hat kaynaklı bir sorun değil

Kare başına tüm iş — 2560×1440 `VideoFrame` → 128×72 yüksek kaliteli küçültme →
geri okuma → tüm ızgarada sRGB→doğrusal çözme, **GPU'suz headless'ta**:

```
p50 1.10 ms   p90 1.40 ms   p99 2.50 ms   en kötü 2.60 ms
120 FPS bütçesi 8.33 ms → GEÇTİ     yakalama valfi 4.17 ms → GEÇTİ
teorik tavan ~876 FPS
```

Tek yönlü sonuç: GPU olmadan bütçeyi 3.3 kat aşıyor, GPU'yla ancak daha iyi olur.
Darboğaz hat değil; yakalama kaynağının teslim hızı, seri hat ve firmware.

**Tasarım kuralı: motorun hiçbir yerinde `requestAnimationFrame` yok.** Görünmez
dokümanda rAF durur; 2D/WebGL komutları verildiğinde çalışır. Her şey MSTP kare
callback'inde ve sabit timer tick'inde.

---

## 3. Aktarım merdiveni

Zorluk = bizim kod tabanımıza ekleme maliyeti, Hyperion'daki karmaşıklık değil.

### Kademe 0 — elimizde olanlar

Bu oturumda yapıldı: Ed25519 lisans, profil CRUD, HeroUI paneli, `lib/light.ts`
(sRGB↔doğrusal, 16-bit BE `Afx` yükü), Supabase şeması.

### Kademe 1 — saf fonksiyonlar, bağımlılık yok (birkaç gün, en yüksek getiri)

Hepsi saf matematik: girdi dizi, çıktı dizi. Test etmesi kolay, tarayıcı
gerekmiyor, ve ambilight **kalitesinin** tamamı bu kademede.

| # | Özellik | Hyperion kaynağı | Bizde |
|---|---|---|---|
| 1 | **Öncelik arbitrasyonu** (kaynak seçimi, duration, auto/manual) | `PriorityMuxer.cpp` — 1 dosya | `extension/src/priority.ts` |
| 2 | **Yumuşatma**: linear + decay + dithering | `LinearColorSmoothing.cpp` — 1 dosya | `smooth.ts` |
| 3 | **Letterbox/siyah kenar**, 4 mod + histerezis | `libsrc/blackborder/` — 1 dizin | `border.ts` |
| 4 | **Renk kalibrasyonu**: 8 köşe profili, gama R/G/B, parlaklık, backlight eşiği, sıcaklık (K), doygunluk kazancı, LED aralığı başına profil | `MultiColorAdjustment`, `RgbTransform`, `RgbChannelAdjustment` | `adjust.ts` |
| 5 | **Görüntü→LED eşleme, 7 mod**: mean, mean-squared, unicolor mean, dominant ×2, dominant-advanced ×2 + `accuracyLevel`, `reducedPixelSetFactor` | `ImageToLedsMap.cpp` | `sample.ts` |

**Kademe 1'in en önemli kararı:** Hyperion sRGB'de ortalıyor ve gamayı sonradan
uyguluyor — luminans pompalamasının sebebi bu ve varsayılan olarak böyle sevk
ediliyor. Biz **doğrusalda ortalıyoruz**. Yani bu algoritmaları port ederken
renk uzayını değiştiriyoruz; bu bilinçli bir sapma ve gerçek bir kalite
farklılaştırıcısı.

`PriorityMuxer` önce gelmeli: her şey ona takılıyor (efekt mi, düz renk mi,
yakalama mı çıkışa hâkim — ve "sinyal yok" durumunda ne olacak).

### Kademe 2 — yerleşim ve yapılandırma (birkaç gün)

| # | Özellik | Not |
|---|---|---|
| 6 | **Klasik yerleşim üreteci**: kenar başına LED, boşluk uzunluğu/konumu, giriş konumu, ters yön, yatay/dikey derinlik, overlap, kenar boşluğu | Bizim sabit 35/19/35/19'un yerini alıyor — **satılabilirliğin anahtarı** |
| 7 | **Keystone/köşe düzeltme** (4 köşe için H/V nokta) | Klasik üretecin parçası |
| 8 | **Matris yerleşimi** (LED duvarı): snake/parallel, yön, başlangıç köşesi, boşluklar | Bizim ürün için ikincil |
| 9 | **LED karaliste** (`{start, num}` aralıkları) | Ucuz, gerçek ihtiyaç |
| 10 | **LED başına `colorOrder`** + RGB bayt sırası sihirbazı | Kırmızı/yeşil yakıp kullanıcıya sorarak türetiyor |
| 11 | **Yerleşim önizlemesi + canlı video katmanı** | Panelde şerit önizlemesi var; canlı video eklenir |

### Kademe 3 — yakalama kalitesi (1-2 hafta)

| # | Özellik | Tarayıcıda karşılığı |
|---|---|---|
| 12 | **Crop** L/R/T/B + `pixelDecimation` | Küçültme çağrısının kaynak dikdörtgeni |
| 13 | **Sinyal algılama** (sinyal yok → ışığı kes): RGB eşikleri, örnekleme alanı, sayaç eşiği | Doğrudan taşınır, `PriorityMuxer` ile birleşiyor |
| 14 | **Çoklu monitör seçimi** | `getDisplayMedia` seçicisi zaten veriyor |
| 15 | **Açılış efekti + arka plan efekti/rengi** (öncelik 255) | Ucuz, ürünü bitmiş gösteriyor |
| 16 | **Ses tepkimeli mod** (VU metre: multiplier, tolerance, hot/warn/safe renkleri ve eşikleri) | `getUserMedia` + `AudioContext` — tarayıcıda **Hyperion'dan kolay** |
| 17 | **Video modu** 2D / 3DSBS / 3DTAB | Örnekleme dikdörtgenlerinin dönüşümü, saf matematik |

### Kademe 4 — efektler (1-2 hafta, yeniden tasarlanarak)

Hyperion **CPython gömüyor** (`libsrc/effectengine/` + `libsrc/python/`). 42
`.json` tanımı aslında **25 `.py` script'inin** parametre varyantı.

Biz Python gömmüyoruz. Yapılacak: 25 script'i TypeScript'e yeniden yazmak.
Hepsi basit — LED dizisi üzerinde zamanla değişen fonksiyonlar:

- ortam/mood: `mood-blobs` (6 varyant), `breath`, `candle`, `fire`, `plasma`,
  `Seawaves`, `waves`, `rainbow-mood`, `trails`, `traces`
- hareket: `knight-rider`, `swirl`, `double-swirl`, `rainbow-swirl`, `snake`,
  `running_dots`, `collision`, `atomic`
- yenilik/oyun: `pacman`, `matrix`, `x-mas`, `flag`, `light-clock`, `sparks`,
  `police-*`, `strobe-*`
- yardımcı: `ledtest`, `ledtest-seq`, `fade`, `cinema-fade-in/off`
- **GIF/görsel oynatıcı** (`gif.py`): tarayıcıda `ImageDecoder` ile **daha
  kolay** — animasyonlu GIF çözme yerleşik

Efekt parametre formları: Hyperion JSON şemadan üretiyor. Bizde Zod + HeroUI
zaten var, aynı deseni veriyor.

Bu kademe **ambilight kalitesi değil**, ürün algısı. O yüzden Kademe 1-3'ten
sonra.

### Kademe 5 — sistem ve ürün (haftalar)

| # | Özellik | Karar |
|---|---|---|
| 18 | **Yapılandırma import/export** | Ucuz, yüksek değer — profil sistemimiz zaten var |
| 19 | **Ayar seviyeleri** (Default/Advanced/Expert kademeli gösterim) | Ucuz UX kazancı; Hyperion'un her şema alanında `access` var |
| 20 | **Günlük kaydı + log görünümü** | Eklentide sayaçlar var; kullanıcıya gösterilmesi |
| 21 | **Çoklu instance** (aynı anda birden fazla LED donanımı, her biri bağımsız yerleşim/kalibrasyon) | **v1'de yok.** Hyperion'da en invaziv şey; ama veri modelimiz bunu imkânsız kılmamalı |

---

## 4. Taşınmayanlar, ve neden

Bunları "yapılacak" listesine koymamak bilinçli.

| Hyperion özelliği | Neden taşınmıyor | Yerine |
|---|---|---|
| JSON-RPC sunucusu (19444), protobuf (19445), flatbuffer (19400), boblight (19333) | **Tarayıcı port dinleyemez** | Kendi HTTP API'miz; sayfa↔eklenti mesajlaşması |
| Web sunucusu + WebSocket API | aynı sebep | Panel zaten Vercel'de |
| mDNS/SSDP keşfi ve duyurusu | aynı sebep | — |
| Yönlendirici (ikinci Hyperion'a aktarma) | gelen bağlantı gerektiriyor | — |
| **CEC** (TV uzaktan kumandası, standby algılama) | `libcec` **GPLv2**, ve tarayıcıdan HDMI-CEC erişimi yok | — |
| OS uyku/kilit olayları, sistem tepsisi, otomatik başlatma | tarayıcı sanal alanı | Chrome açılışıyla eklenti başlıyor |
| Uygulama içi güncelleyici/downgrade | tarayıcı sanal alanı | Eklenti Web Store'dan güncelleniyor |
| 44 LED sürücüsünün 43'ü (ağ/SPI/HID/FTDI/PWM, Hue, Nanoleaf, WLED…) | **Biz tek cihaz sürüyoruz** | `dev_serial` — tek ilgili sürücü |
| V4L2/Media Foundation USB yakalama kartları | v1 kapsamı ekran yakalama | v2 SKU (HDMI splitter yolu) |
| Gömülü Python efekt motoru | çok büyük bağımlılık | Kademe 4'te TS'e yeniden yazım |
| Auth/token, SQLite + migration'lar | bizde farklı ve zaten var | Ed25519 lisans token'ları |

---

## 5. Lisans

Kök `LICENSE` birebir **MIT**, `Copyright (c) 2014-2026 Hyperion Project`.
Kapalı kaynak ticari kullanım için güvenli: yalnızca bildirim yükümlülüğü.

- **Algoritmaları kendi kodumuzda yeniden yazarsak** tek yükümlülük
  `THIRD-PARTY-NOTICES.txt`'te MIT metni + telif bildirimi.
- `3RD_PARTY_LICENSES`'ta **Hippocratic 2.1** var (Animate.css) — yalnız
  Hyperion'un web arayüzünde, bizi hiç ilgilendirmiyor.
- **libcec GPLv2** — CEC'i zaten almıyoruz, ağaçtaki tek GPL bileşeni böylece
  dışarıda kalıyor.
- **Qt LGPLv3** — Qt'ye hiç link etmiyoruz.

Yani: dosyaları olduğu gibi almıyoruz, algoritmaları TypeScript'te yeniden
yazıyoruz. Yükümlülük bir bildirim dosyası.

---

## 6. Doğrulama

**Bu makinede yapılabilenler** (mevcut `node --test` düzeneği yeterli, tarayıcı
gerekmiyor): Kademe 1'in tamamı saf fonksiyon, yani hepsi birim test edilebilir.
Kritik olanlar:

- Yumuşatma: deterministik tick'lerle attack/release asimetrisi, decay eğrisi,
  dithering'in zaman ortalamasının hedef değere eşit çıkması
- Letterbox: sentetik 2.39:1 kare → doğru inset; histerezisin salınmadığı
- Renk zinciri: bilinen girdi → bilinen çıktı, ve **doğrusalda ortalamanın
  sRGB'de ortalamadan farklı çıktığının gösterilmesi**
- Eşleme: 7 modun her biri; 108 LED dikdörtgeninin örtüşmediği
- Öncelik: duration bitimi, auto/manual seçim, sinyal-yok geçişi
- Yerleşim üreteci: kenar sayıları + boşluk + ters yön → beklenen `hmin/hmax/vmin/vmax`

**Senin makinende ölçülmesi gerekenler** (bende ekran ve Arduino yok):

- Teslim edilen yakalama FPS'i, istenen 60 ve 120'de, ön planda **ve** arka
  planda — kareleri say, `getSettings().frameRate`'i yok say, p50/p1/p99 bildir
- Görünmez dokümanda MSTP kare akışının sürüp sürmediği (ölçemediğim tek
  mimari bilinmez)
- Gerçek GPU'da `resizeQuality:'high'` filtresinin aynı davrandığı, ve gerçek
  yakalamanın NV12/I420 verdiğinde renk dönüşümünün bozulmadığı
- Uçtan uca gecikme: 240 fps telefon kamerası, monitör ve LED aynı karede
- **İçerik matrisi (DRM)**: Netflix tarayıcı vs Store uygulaması, Prime,
  Disney+, YouTube HDR. Bu bir test değil, **ürün destek dokümanı**

---

## 7. Seri protokolün tam hali (kaynaktan çıkarıldı)

Hyperion'un 44 LED sürücüsünden bizi ilgilendiren tek dosya:
`libsrc/leddevice/dev_serial/LedDeviceAdalight.cpp`. Aşağısı ezberden değil,
koddan.

Tek sürücüde üç protokol var (`streamProtocol`: `"0"`=ADA, `"1"`=LBAPA, `"2"`=AWA).
Başlık üçünde de **6 bayt**.

```
ADA:  'A' 'd' 'a'            hi(N-1) lo(N-1) (hi^lo^0x55)  + N*3 bayt RGB
AWA:  'A' 'w' ('a' veya 'A') hi(N-1) lo(N-1) (hi^lo^0x55)  + N*3 bayt RGB
                                                            [+ 4 kalibrasyon]
                                                            + 3 bayt Fletcher
```

**Beş detay, hepsi yanlış yapılmaya müsait:**

1. **LED sayısı `N-1` olarak, big-endian 16-bit.** (LBAPA bilinçli tutarsız:
   `N` gönderiyor. Biz LBAPA'yı almıyoruz.)
2. **AWA'nın üçüncü magic baytı bir bayrak.** `'a'` normal; **`'A'` ise** piksel
   verisinden sonra 4 kalibrasyon baytı (`limit, red, green, blue`) geliyor
   demek. Firmware RGBW dönüşümünü bu 4 bayta göre kendisi yapıyor.
3. **Fletcher yalnızca piksel baytlarını kapsıyor** (+ varsa kalibrasyon
   baytları). **Başlık checksum'a girmiyor.** `hasher` tam olarak
   `_ledBuffer.data() + HEADER_SIZE`'dan başlıyor.
4. **`position` bir `uint8_t` ve 256'da sarıyor.** 108 LED = 324 piksel baytı,
   yani **bizde sarıyor.** `size_t` kullanan bir yeniden yazım 256. bayttan
   sonra sapar ve checksum tutmaz. Bu, sessizce bozan türden bir hata.
5. **`0x41` escape'i YALNIZCA üçüncü bayta uygulanıyor.** `fletcher1` ve
   `fletcher2` kaçırılmıyor ve meşru olarak `0x41` olabiliyorlar; firmware
   başlığın sayı+XOR doğrulamasıyla bunu tolere ediyor.

```c
fletcherExt = (fletcherExt + (*(hasher) ^ (position++))) % 255;  // position: uint8_t
fletcher1   = (fletcher1 + *(hasher++)) % 255;                   // ikisi de 0'dan başlıyor
fletcher2   = (fletcher2 + fletcher1) % 255;
...
*writer++ = fletcher1;
*writer++ = fletcher2;
*writer++ = (fletcherExt != 0x41) ? fletcherExt : 0xaa;          // yalnız bu
```

### Bizi doğrudan etkileyen üç sonuç

**Hyperion seri hatta asla 8 bitten fazla göndermiyor.** Cihaza giden tip
`ColorRgb` — tam 3 bayt paketli struct, tek piksel giriş noktası. 16-bit tek
yerde var (`dev_spi/LedDeviceHD108`) ve orada bile 8-bit değeri kopyalıyor, yeni
bilgi yok. Yani **bizim 16-bit doğrusal `Afx` protokolümüz Hyperion'dan
gelmiyor, bizim eklentimiz** — firmware'i biz yazdığımız için yapabiliyoruz, ama
"Adalight uyumlu" demek 8-bit demek. AWA'yı kanıtlanmış 8-bit geri uyumluluk
yolu olarak tutuyoruz.

**AWA'nın geri besleme kanalı var ve bunu istiyoruz.** `readFeedback()` porttan
satır okuyor; `FPS:` ile başlayanlar istatistik olarak loglanıyor. Yani firmware
aynı seri hat üzerinden gerçek kare hızını bildirebiliyor — enstrümantasyon
planımızdaki `framesRx − framesShown` sayacının taşıma yolu bu, ayrı bir kanal
gerekmiyor.

**`latchTime` tuzağı doğrulandı ve daha kötü.** `LedDevice.cpp` kapısı
`elapsedTimeMs < _latchTime_ms` ise yazmayı **sessizce atlıyor** (başarı olarak
sayıyor). Adalight şemasının varsayılanı **30 ms → ~33 fps tavan**, ve
karşılaştırma `QDateTime` ile **1 ms çözünürlüklü duvar saati** — monotonik
değil. Bizim 120 Hz hedefi için böyle bir kapı olmamalı; varsa `0` olmalı ve
monotonik mikrosaniye saat kullanılmalı.

### Kendi iddiamı düzeltiyorum

Planımda "asla 1200 baud'da açma (bootloader/DFU reset tetikler)" yazmıştım ve
bunu referanstan geliyormuş gibi konumlandırmıştım. **Hyperion'un tüm ağacında
1200, DTR, RTS, bootloader ya da board-reset'e dair tek satır kod veya yorum
yok.** Aradım. Hyperion'un tek hafifletmesi `delayAfterConnect` (port açıldıktan
sonra ilk yazımdan önce bekleme).

1200-baud touch davranışı gerçek bir Arduino sınıfı kart davranışı
(Leonardo/Micro/ESP32-S2/S3), ama **bizim ekleyeceğimiz bir şey, port
ettiğimiz bir şey değil.** Doğru kayıt bu.

Ayrıca: `dev_serial/LedDeviceSkydimo.cpp` Adalight'a benziyor ama başlığı bozuk
(`'A','d','a',0,0,N` — XOR checksum yok, 8-bit sayı). "Adalight" yazarken yanlışlıkla
onu yazmamak lazım.

### Lisans açısından iyi haber

AWA/HyperSerial protokolünün kökeni **HyperHDR, MIT, © 2021 awawa-dev**. Yani
uyguladığımız seri format MIT kökenli — ticari kapalı kaynak ürün için temiz.

---

## 8. Tarayıcıdan Hyperion'a bağlanmak (ayrı bir olasılık)

Bu planın ana hattı değil, ama not edilmeye değer: eğer bir kullanıcı **zaten
Hyperion çalıştırıyorsa**, tarayıcıdan ona bağlanmak mümkün — ve tam olarak iki
yüzey üzerinden:

- `POST /jsonrpc` (HTTP 8090) — CORS `Access-Control-Allow-Origin: *` açık
- Aynı porttaki **WebSocket** — akış/abonelik/login komutları **yalnızca** burada
  çalışıyor, çünkü HTTP yolu `_noListener` set ediyor ve `ledstream-start`,
  `serverinfo subscribe`, `logging start`, `authorize login` komutlarını
  reddediyor

Üç engel: HTTPS sayfadan `ws://`/`http://` açılamıyor (mixed content) ve 8092'nin
sertifikası kendinden imzalı; varsayılan şifre değiştirilmemişse uzak WebSocket
bağlantıları `CloseCodePolicyViolated` ile kapatılıyor; Chrome'un Private Network
Access kısıtları geçerli.

Token alma yolu bizim için ilginç: `authorize requestToken` **kimlik doğrulaması
gerektirmiyor**, 3 dakikalık bir istek oluşturuyor, kullanıcı Hyperion arayüzünde
"Kabul et"e basıyor. Şifre gerekmiyor. Üçüncü parti bir uygulamanın kullanması
gereken akış bu.

---

## 9. Renk uzayı: iddia kanıtlandı

Bu, tüm kalite farklılaştırmamızın dayandığı nokta, o yüzden kanıtla:

**Hyperion'un LED hattında hiçbir yerde doğrusallaştırma yok.** Ortalama,
yumuşatma ve düzeltme zincirinin tamamı 8-bit sRGB-kodlu tam sayılar üzerinde
çalışıyor.

- `ImageToLedsMap.h:419-438` — `calcMeanColor` grabber'dan gelen `uint8_t`
  değerleri toplayıp sayıya bölüyor. Transfer fonksiyonu yok, float yok.
- `RgbTransform.cpp:57-79` — "gama" LUT'u `out = 255*(i/255)^gamma`, ve bu
  **zaten sRGB olan** değere uygulanıyor. Yani ekranın sRGB kodlamasının
  **üstüne ikinci bir güç fonksiyonu** — çözme değil. Varsayılan 2.2, yani
  orta gri sRGB 128 → **55**. Kolorimetrik bir işlem değil, bilinçli olarak
  algısal bir karartma düğmesi.
- `RgbTransform.cpp:212-217` — renk sıcaklığı sRGB'de düz kanal çarpımı.
- Tüm depoda sRGB transfer fonksiyonuna dokunan yalnız iki yer var: Okhsv
  doygunluk/parlaklık kazancı (`ok_color.h:58-66`, ve bu varsayılan olarak
  kapalı) ve Philips Hue sürücüsü (`LedDevicePhilipsHue.cpp:220-222`, çünkü Hue
  API'si CIE xy istiyor). **Kod tabanında kolorimetrik olarak doğru tek yer bu
  ikincisi.**

**Ve `multicolor_mean_squared` modunun varlık sebebi tam olarak bu.** RMS
(`sqrt(Σr²/N)`) sRGB'de, "doğrusalda ortala sonra yeniden kodla"nın kaba ve ucuz
bir yaklaşımı — parlak pikselleri fazla ağırlıklıyor. Yani bizim doğrusal
ortalamamız, Hyperion'un yaklaşık olarak taklit etmeye çalıştığı şeyin
**prensipli hali.** Aynı işi yapan ikinci bir mod eklemiyoruz; doğrusunu
yapıyoruz.

---

## 10. Kademe 1 algoritmalarının tam hali

### Yumuşatma — linear modu

`performLinear` (`LinearColorSmoothing.cpp:488-520`). **Sabit süreli bir lerp
değil**, her çıkış tick'inde yeniden türetilen geometrik bir yaklaşma:

```
k = 1 - deltaTime / (targetTime - previousWriteTime)      // ∈ [0,1]
her kanal için: diff = target - prev
                prev += sign(diff) * ceil(k * |diff|)
```

`ceil` kritik: `diff != 0` olduğu her tick'te en az ±1 LSB hareket garantiliyor,
yani 1 birim uzakta asimptotik takılma yok. Bedeli yavaş geçişlerde görünür
1/255 basamaklanma. `k ≤ 1` olduğu için asla aşmıyor. Linear mod `decay`,
`interpolationRate` ve `dithering`'i tamamen yok sayıyor.

Girdi uçuş sırasında gelirse hedef değişiyor ve sonraki tick yeniden hesaplıyor
— bu yüzden bizim "yakalama yalnız hedefi güncelliyor, IIR kendi saatinde
koşuyor" tasarımı Hyperion'la aynı fikir.

### Yumuşatma — decay modu ve ağırlık fonksiyonu

Kare geçmişi bir deque'te `{zaman, renkler}` olarak tutuluyor. Budama bilinçli
olarak **pencere başlangıcını kesen kareyi saklıyor** (`p = -1` ile başlıyor),
böylece pencerenin en eski dilimi her zaman bir renge sahip.

```
decay == 1 →  w = (frameEnd - frameStart) * invWindow          // saf zaman payı
decay != 1 →  s = (frameStart - windowStart) * invWindow
              t = (frameEnd   - windowStart) * invWindow
              w = (decay + 1) * (t^decay - s^decay)
```

Yarı ömür: `t_half = (1 - 2^(-1/decay)) * settlingTime`. `decay=1` için
settling'in %50'si, `decay=8` için ~%8.3'ü.

Bir davranış bilinçli ve taşınırken karar vermek gerekiyor: pencere tam
dolmadığında `fs < 1` ise **yeniden normalize edilmiyor**, yani açılışta çıkış
siyahtan içeri soluyor.

### Zamansal dithering — hattın en değerli fikri

`assembleAndDitherFrame` (`cpp:293-326`). Bu, Floyd–Steinberg hata yayılımının
**uzayda değil zamanda** uygulanmışı, kanal başına bağımsız:

```
f = mean + residual
out = clamp(round(f), 0, 255)
residual = f - out          // yuvarlama hatası sonraki kareye taşınıyor
```

Hedef 10.4 ise 25 Hz'de 10,11,10,11,10,10,11,10,11,10… çıkıyor ve göz 10.4 olarak
integre ediyor. `mean ∈ [0,255]` olduğu için residual ±0.5 civarında sınırlı —
wind-up yok.

**Bu bizim için önemli bir karar noktası.** Planımızda dither firmware'de
(sigma-delta). Hyperion host'ta yapıyor. İkisi birbirini dışlamıyor ama **ikisi
birden yapılırsa çift dither olur.** Karar: firmware 16-bit alıyorsa dither
orada; 8-bit yolda host tarafında.

*(Bu satır bir süre `8-bit Afx/AWA yolunda` diyordu, ki `Afx` 16-bit formatın
kendisi olduğu için kendi kararıyla çelişiyordu. Uygulanan hâli: `Awa` ve `Ada`
host'ta dither'lanabiliyor, `Afx` bunu **reddediyor** — `lib/engine/encode.ts`.)*

Decay modunda iki **bağımsız saat** var: ortalama `interpolationRate`'te yeniden
hesaplanıyor, kare `updateFrequency`'de gönderiliyor. Dither açıkken kuantalama
yazma hızında çalışıyor (her gönderilen kare taze residual taşıyor).

### Siyah kenar algılama — dört modun tam probu

Eşik: `ceil(threshold% * 255)`, varsayılan %5 → **13**. `isBlack` **üç kanalın
da** eşiğin altında olmasını istiyor. Hepsi genişlik/yüksekliğin ilk **üçte
birini** tarıyor ve tam tarama değil, birkaç satır örnekliyor — tasarım gereği
kare başına O(1).

- **`default`** (3 satır, 4 kenar): X için sağ kenar-orta satır, sol kenar-1/3
  satır, sol kenar-2/3 satır aynı döngüde. Sol ve sağ probu aynı döngüye
  karıştırmak, işi iki katına çıkarmadan simetri sağlayan hile.
- **`classic`**: köşegen yürüyüşü, sonra sola ve yukarı genişleme. Ucuz ama
  sol üst köşedeki karanlık içerik kandırıyor.
- **`osd`**: X'i `default` gibi bulup, Y'yi **bulunan x'te dört köşede**
  arıyor — bir köşedeki ekran bilgisi katmanı tek başına kenar değiştiremiyor.
- **`letterbox`**: yalnız üst/alt, genişliğin %25 ve %75'inde iki yönden, artı
  **merkez yalnız üstten** — koddaki gerekçesi: *"center will only check top
  (minimise false detection of captions)"*. Altyazı yanlış pozitifini önlüyor.

Histerezis sabitleri: `unknownFrameCnt` **600**, `borderFrameCnt` **50**,
`maxInconsistentCnt` **10**, `blurRemoveCnt` **1** piksel.

**Ve bu tasarımın gerçek sebebi, depodaki en iyi yorum**
(`BlackBorderProcessor.cpp:150-160`): grabber bazen daha küçük siyah kenarlı
"bozuk" kareler veriyormuş — görüntü donmuş olsa bile birkaç karede bir rastgele
— ve yazarın notu: *"**dönüştürücünün güç kaynağını değiştirmek sistemimde o
'rastgele' etkiyi belirgin şekilde artırdı**"*. Yani bir HDMI yakalama kartının
güç kaynağı artefaktı, tüm histerezis durum makinesinin tasarımını belirlemiş.

Bir de maliyet: kenar değişince **tüm indeks haritası yeniden kuruluyor**
(`verifyBorder` → `registerProcessingUnit`). Histerezisin bu kadar isteksiz
olmasının sebebi bu.

Bizim planımızdaki "histerezis kare değil zaman tabanlı olmalı" notu geçerli:
50 kare Hyperion'un 10 FPS'inde 5 saniye, bizim 120 FPS'imizde **0.42 saniye**.

### Renk düzeltme zinciri — tam sıra

`MultiColorAdjustment::applyAdjustment`, LED başına kare başına:

1. **Okhsv kazancı** — doygunluk ve parlaklık çarpanı, Okhsv uzayında (ve bu
   uzay sRGB'yi doğru çözüyor). İkisi de varsayılan 1.0, yani **varsayılan
   olarak atlanıyor.** Zincirdeki algısal olarak doğru tek aşama.
2. **Gama LUT** — kanal başına 256 girişli, `(i/255)^gamma * 255`.
3. **Parlaklık bileşenleri** — dönüşüm değil, aşama 5'in kullandığı üç skaler:
   ```
   B_in = (brightness < 50) ? (-0.09*brightness + 7.5) : (-0.04*brightness + 5.0)
   brightness_rgb = ceil(min(255, 255 / B_in))
   brightness_cmy = ceil(min(255, 255 / (B_in * Fcmy)))
   brightness_w   = ceil(min(255, 255 / (B_in * Fw)))
   Fcmy = comp/100 + 1,   Fw = comp*2/100 + 1
   ```
   50'de menteşelenen iki elle ayarlanmış doğru parça.
4. **8 köşe: trilineer ayrıştırma.** Bu, sistemin anlaşılması gereken kısmı —
   renk RGB küpünün 8 köşesine barycentric ağırlıklarla dağıtılıyor:
   ```
   black   = (255-r)(255-g)(255-b) / 255²        white = r·g·b / 255²
   red     = r(255-g)(255-b) / 255²              yellow = r·g(255-b) / 255²
   ...                                            (8 ağırlık, toplamı 255)
   ```
   Sonra her ağırlık, kullanıcının o köşe için kalibre ettiği rengi seçiyor.
   **Yani 8 köşe renk, yalnızca küp köşeleri açığa çıkarılmış bir 3-B renk
   LUT'u** — "benim LED'imin kırmızısı aslında (255,20,5)" diyebiliyorsun ve
   tüm ara renkler yumuşak takip ediyor. Aynı zamanda RGB/CMY/W'nin farklı güç
   çekmesini telafi etmenin kancası. **BLACK köşesine bilinçli olarak
   `brightness=255` geçiliyor**, yani siyah taban asla ölçeklenmiyor.
5. **Köşe başına parlaklık LUT'u** — `clamp(_adjust.c * brightness * input / 255²)`.
6. **Yeniden birleştirme** — 8 katkının kanal başına toplamı.
7. **Renk sıcaklığı** — `c *= tempRGB.c / 255`, Tanner Helland siyah cisim
   yaklaşımı, 6600 K'de birim (identity).
8. **Backlight/siyah taban** — `(r+g+b) < 3*low` ise tabana çek. Eşik eğrisi
   doğrusal değil: `shaped = (2^(2t)-1)/3`, yani %50 → 85.
   Ve `_backLightEnabled` bir kullanıcı ayarı **değil**: görünen kaynak düz renk
   ya da efekt olduğunda zorla kapatılıyor, böylece "LED'leri siyah yap"
   gerçekten siyah oluyor.

### Bir karede üç ayrı hız sınırlayıcı, seri hâlde

Bu, "neden Hyperion 120 Hz veremiyor" sorusunun cevabı:

```
grabber fps (varsayılan 25, maks 30)
  → coalescing kapısı: işleme bitmediyse kareyi DÜŞÜR (sayılıyor, %5 üstü uyarı)
  → yumuşatma çıkış aralığı (varsayılan 25 Hz)
  → cihaz latchTime kapısı (Adalight'ta 30 ms → ~33 Hz)
```

Üçü çarpışmıyor, **seri hâlde daralıyor.** Bizim hattımızda bu üç kapıdan
hiçbiri olmamalı: yakalama 120, yumuşatma 120 tick, seri latch yok.

---

## 11. Hyperion'un hataları — kopyalanmayacaklar

Port ederken bunları taşımamak, aktarımın yarısı kadar değerli.

| # | Nerede | Ne | Sonucu |
|---|---|---|---|
| 1 | `ImageToLedsMap.cpp:96` | İndeks adımı `actualWidth`, ama tampon adımı tam `_width` | **Sol/sağ kenar algılandığı anda her satır kayıyor ve örneklenen bölge çapraz sürükleniyor.** Biz `y * fullWidth + x` kullanacağız |
| 2 | `ImageProcessor.h:144-149` | `case 1` ve `case 2` `mappingTypeToInt` ile **ters** | Arayüzde "mean squared" seçmek aslında uniform mean veriyor. Kullanıcı-görünür hata |
| 3 | `MultiColorAdjustment.cpp:157-159` | 8 köşe katkısının **clamp'sız `uint8_t` toplamı** | Varsayılan olmayan kalibrasyonda **taşıp sarıyor** — parlak bölge karanlığa dönüyor |
| 4 | `RgbChannelAdjustment.cpp:65`, `MultiColorAdjustment.cpp:130` | `static_cast<uint8_t>(double)` yuvarlamıyor, **kırpıyor** | Köşe ayrıştırmasında 8/255'e kadar sistematik luminans kaybı |
| 5 | `ImageToLedsMap.h:508` | `uint_fast32_t` piksel başına 255² topluyor | 32-bit platformda ~66.000 pikselden sonra taşıyor; ayrıca `sqrt`'ten **önce** tam sayı bölmesi |
| 6 | `ImageToLedsMap.h:671` | k-means'te **iterasyon sınırı yok**, ve yakınsama testi hareketin kendisine değil **hareketteki değişime** bakıyor | Patolojik salınımda sonsuz döngü |
| 7 | `schema-smoothing.json` | `interpolationRate` şema varsayılanı **1.0**, C++ fallback'i **25** | Yeni kaydedilmiş config ile eski config çok farklı davranıyor |
| 8 | `schema-color.json` | `brightnessCompensation` şema **0**, kod fallback'i **100** | Aynı sınıf uyumsuzluk |
| 9 | `utils/hyperion.h:172` | `ledIndexList[i]` olması gereken yerde `[j]` | LED kalibrasyon aralığı ayrıştırmasında yanlış eleman okunuyor |
| 10 | `ImageToLedsMap.cpp:83-88` | LED bölgesi 1600 pikseli geçince **sessizce her 2. pikseli atlıyor** | Otomatik performans koruması, ama kullanıcı bilmiyor |

---

## 12. Yakalama kalitesi: bizim yolumuz nerede duruyor

Hyperion'un 12 grabber'ı arasında küçültme kalitesi dramatik biçimde değişiyor —
ve bu, bizim ölçtüğümüz sonucu bağlama oturtuyor.

| Backend | Küçültme | Kalite |
|---|---|---|
| **DDA** (Windows) | D2D `DrawBitmap`, `INTERPOLATION_MODE_LINEAR` | **Gerçek filtreli tek backend.** Ama hedef `B8G8R8A8_UNORM`, `_SRGB` değil → filtreleme gama-kodlu değerlerde |
| DirectX/D3D9 | `D3DXLoadSurfaceFromSurface`, `D3DX_DEFAULT` | Filtreli (üçgen/doğrusal) |
| X11 | XRender `FilterBilinear` | Filtreli |
| **XCB** | XRender filtresi `"fast"` | **Nearest.** Aynı ekran, X11'den düşük kalite |
| **Qt** (taşınabilir yedek) | `QImage::scaled()` argümansız | **`FastTransformation` = nearest neighbour.** 3840→480'de 64 pikselde 1, filtresiz |
| CPU resampler (V4L2 vb.) | saf **nearest-neighbour nokta örnekleme** | `pixelDecimation=8` varsayılanıyla piksellerin 1/64'ü |

Ve bir sistematik hata: YUV→RGB dönüşümü **her zaman BT.601 limited-range**
(`ColorSys.cpp:54-64`). Modern 1080p/4K HDMI genelde BT.709, bazen full-range.
Renk matrisi seçimi kod tabanında hiç yok → video grabber girdisinde sistematik
ton/doygunluk kayması.

**Bizim ölçtüğümüz `createImageBitmap(VideoFrame, {resizeQuality:'high'})` düz
127, yayılım 0 verdi — yani doğru alan ortalaması.** Bu, DDA dışındaki her
Hyperion masaüstü backend'inden iyi; DDA'dan da iyi, çünkü biz doğrusal ışıkta
çalışıyoruz ve o gama uzayında filtreliyor. Tarayıcı burada bir dezavantaj
değil, avantaj.

---

## 13. Efekt motorunun API yüzeyi (Kademe 4'ün sözleşmesi)

Efektler gömülü CPython'da çalışan **QThread**'ler. Python'a `PyCapsule` olarak
veriliyorlar ve üç modül değişkeni enjekte ediliyor: `hyperion.ledCount`,
`hyperion.latchTime`, `hyperion.args`.

Kritik tasarım detayı: efekt tuvali ekran değil **LED ızgarası** boyutunda
(`getLedGridSize()`). Yani efektler kaba bir soyut ızgaraya boyuyor, sonra o
normal görüntü→LED eşlemesinden geçiyor. TS'e taşırken aynısını yapmalıyız.

Yüzey ~20 metot ve özünde küçük bir 2-B çizim API'si:

- **Çıkış:** `setColor(r,g,b)` / `setColor(bytearray)` (tam `3*ledCount`),
  `setImage(w,h,bytearray)`, `imageShow([idx])`
- **Çizim:** `imageDrawLine/Point/Rect/Polygon/Pie`, `imageSolidFill`,
  `imageLinearGradient/ConicalGradient/RadialGradient`, `imageSetPixel/GetPixel`
- **Dönüşüm:** `imageCRotate`, `imageCOffset`, `imageCShear`, `imageResetT`
- **Durum:** `imageSave`, `imageStackClear` (iz efektleri için kare hafızası),
  `imageMinSize`, `imageWidth`, `imageHeight`
- **Yaşam döngüsü:** `abort()` — efektin durması gerektiğini öğrenmesinin
  **tek yolu**, kooperatif iptal
- `getImage(source, crop…, grayscale)` — kaynak/dosya/**URL**'den görsel
- `lowestUpdateInterval()` — 200 Hz tavan

Bir güvenlik notu: sandbox **yok**. Efekt script'i `QNetworkAccessManager` ile
ağa çıkabiliyor. TS'e taşırken bu yüzden efektler Worker'da ve ağ erişimi
olmadan koşmalı.

Bir de bağımlılık tuzağı: LED yerleşimi değişince **çalışan tüm efektler
durdurulup yeniden başlatılıyor**, çünkü *"effects depend heavily on
LED-layout"*.

---

## 14. Kaynak

Klon: `hyperion-project/hyperion.ng`, sürüm 2.2.2-beta.1, sığ klon.
Bu doküman yazılırken inceleme scratchpad'de yapıldı; depoya kopyalanmadı.
