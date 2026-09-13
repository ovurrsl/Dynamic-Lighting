# AmbiFlux Chrome eklentisi — devir dokümanı

Bu dosya eklentiyi başka bir ortamda (Antigravity 2.0) geliştirecek olan için
yazıldı. Amacı tek: **kodu okumadan önce neyin neden böyle olduğunu bilmek**,
ve daha önce ölçülmüş şeyleri yeniden ölçmemek.

Depoda bu dosyanın kardeşleri: `docs/hyperion-port-plan.md` (motor
algoritmalarının kaynağı ve Hyperion.NG'den kopyalanmayacak 10 kusur),
`docs/deploy.md`, `docs/tooling.md`, ve kök `README.md`.

Son güncelleme: 2026-09-13. Durum: **motor çalışıyor ve ölçüldü** (§9.1), ama
**ekran yakalama kullanıcının makinesinde başlamıyor** (§9.2).

---

## 1. Ürün ne

108 LED'lik bir WS2812B şerit, 27" 1440p 144 Hz monitörün arkasında bias light.
Ekranın kenarlarını gerçek zamanlı örnekleyip şeride basan bir ambilight
yazılımı satılacak. Rakipler (Hyperion, HyperHDR, WLED) ücretsiz ve açık kaynak,
dolayısıyla ürünün farkı kolaylık ve kalite olmak zorunda.

Üç parça var ve **yalnız ikincisi bu dokümanın konusu**:

| Parça | Nerede | Durum |
|---|---|---|
| Kontrol paneli | Next.js 16, Vercel, `ambiflux-revor.vercel.app` | canlı |
| **Motor** | **Chrome eklentisi, `extension/`** | **derleniyor, ölçülmedi** |
| Firmware | ESP32-S3 (Arduino Nano ESP32) | **henüz yazılmadı** |

Firmware yok, o yüzden eklenti bugün **loopback** modunda çalışır: kareler
çerçevelenir, referans ayrıştırıcıyla doğrulanır, sayılır, atılır. Bu bilinçli
— yakalama ve hat performansı kart gelmeden ölçülebilsin diye.

---

## 2. Neden eklenti — bu ölçüldü, varsayılmadı

Soru "Chrome eklentisi mi en mantıklı" idi ve doküman okumakla çözülmedi:
Chrome'un kendi dokümanı ile MDN çelişiyordu. Kurulu **Chromium 141**'e
doğrudan soruldu.

| Ölçüm | Sonuç | Sonucu ne belirliyor |
|---|---|---|
| `MediaStreamTrackProcessor` in `window` | **var** | motor bir **doküman**ta yaşayabilir |
| `MediaStreamTrackProcessor` in DedicatedWorker | **yok** | MDN yanlış; worker'a taşınamaz |
| `navigator.serial`, `getDisplayMedia`, `VideoFrame`, `OffscreenCanvas`, WebGPU, WebCodecs | var | hepsi elimizde |
| offscreen `DISPLAY_MEDIA` ömür limiti | **yok** (yalnız `AUDIO_PLAYBACK` 30 s) | oturum süresiz yaşar |
| `chrome.desktopCapture` streamId yeniden kullanımı | **hayır**, tek kullanımlık, saniyelerde sona eriyor | ekran seçimi kalıcı yapılamaz |

**Karar:** zincir bir *doküman* gerektiriyor (MSTP worker'da yok), ve eklentideki
offscreen document hem doküman olan hem **hiç render edilmeyen** tek yer. Bu
ikisinin kesişimi başka hiçbir yerde yok. Sekme arka plana düşünce Chromium
render'ı durdurup `requestAnimationFrame`'i kısıtlıyor; kullanıcı tek monitörde
oyun oynarken sekmeyi önde tutamaz.

Elenen alternatifler: kurulabilir PWA (penceresi kapanınca ölüyor), düz sekme
(en kötüsü), WebUSB (Arduino CDC olarak görünüyor, Web Serial doğru API),
yerel yardımcı uygulama (Hyperion'un ta kendisi; tarayıcı sınırları kabul
edilemez çıkarsa kaçış yolu olarak duruyor).

### Tarayıcıda kaçınılamayan iki kısıt

1. **Oturum başına bir kez ekran seçimi.** `streamId` kalıcı yapılamıyor.
   Offscreen'in ömür limiti olmadığı için seçim Chrome oturumu boyunca geçerli
   — kare başına değil, gün başına bir tık. Ama "OS ile başlar ve hiç sormaz"
   tarayıcıda mümkün değil.
2. **DRM korumalı içerik siyah yakalanıyor.** Netflix/Prime/Disney+. İşletim
   sistemi içinde yazılımsal çözümü yok. Arayüzde ve destek dokümanında
   yazmalı; 3. müşterinin keşfetmesi gereken bir şey değil.

### Tasarım kuralı

**Motorun hiçbir yerinde `requestAnimationFrame` yok.** Görünmez bir dokümanda
rAF durur. WebGL/2D komutları ise verildiğinde çalışıyor. Tüm iş MSTP kare
callback'i içinde ve sabit bir timer tick'inde yapılır.

---

## 3. Dosya haritası

```
extension/
  manifest.json          MV3. `key` ile eklenti kimliği SABİT (§4).
  src/
    sw.ts                service worker — offscreen ömrü + yapılandırma sahibi
    offscreen.html/.ts   motorun tamamı
    popup.ts/.html       kullanıcı hareketi isteyen iki şey: ekran seçimi, seri port
    webcodecs.d.ts       MediaStreamTrackProcessor tipleri (lib.dom'da yok)
  tsconfig.json          include: src/**/*.ts, types: chrome + w3c-web-serial
  dist/                  DERLEME ÇIKTISI, .gitignore'da — yüklenen klasör bu

lib/engine/              saf TypeScript motor, tarayıcı API'si yok, node --test ile koşar
  types.ts     ortak vocabulary: LedRect, LinearGrid, LedColors, Border, Clock
  layout.ts    klasik çerçeve + matris yerleşimi, kara liste, keystone
  order.ts     kanal sırası (rgb…bgr), LED başına istisna
  config.ts    tek EngineConfig, parseEngineConfig, resolveLayout
  decode.ts    RGBA → doğrusal ışık (256 girişli LUT)
  border.ts    siyah kenar algılama, 4 mod, ms tabanlı histerezis
  sample.ts    bölge → LED, 7 mod, tam ızgara adresleme
  adjust.ts    8 aşamalı renk düzeltme, Oklab
  smooth.ts    linear / decay / asimetrik yumuşatma
  dither.ts    zamansal hata yayılımı (8-bit yol için)
  priority.ts  kaynak arbitrajı
  protocol.ts  Ada / Awa / Afx çerçeveleme + akış ayrıştırıcı
  serial.ts    latest-wins yazıcı + loopback
  stats.ts     varış ölçer, p50/p99/max

lib/extension/messages.ts   panel ↔ sw ↔ offscreen mesaj sözleşmesi (iki taraf da derler)
lib/config-store.ts         panelin localStorage kopyası
lib/extension-client.ts     panelin eklenti tarafı
data/extension.ts           EXTENSION_ID
components/LayoutCard.tsx   yerleşim editörü
components/LedFrame.tsx     önizleme geometrisi (iki kart da bunu çiziyor)
scripts/build-extension.mjs esbuild
scripts/pack-extension.mjs  yüklenebilir zip
```

**Motorun `lib/engine/` altında olması bilinçli:** panel de aynı kodu import
ediyor. Yerleşim önizlemesini motorun kendi `resolveLayout`'u çiziyor, yani
önizlemenin gösterdiği şey motorun örneklediği şey. Kendi çizim koduna sahip
bir önizleme, motor yanlışken doğru olabilir.

### Komutlar

```bash
npm install
npm run typecheck            # panel + kütüphane
npm run typecheck:extension  # DOM + chrome + Web Serial tipleriyle
npm test                     # 381 test, node --test, DERLEME YOK
npm run build:extension      # esbuild → extension/dist
npm run pack:extension       # + yüklenebilir zip
npm run dev                  # panel
```

**Test düzeneği hakkında bilinmesi gereken:** Node 22'nin yerel tip soyucusu
kullanılıyor, derleme adımı yok. İki sonucu var: (a) **parametre özellikleri
(`constructor(private x)`) reddediliyor** — `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`;
(b) **JSX soyulamıyor**, o yüzden `.tsx` içindeki hiçbir şey test edilemez —
test edilmeye değer saf fonksiyonlar `.ts` modüllere çıkarılır
(`lib/preview.ts` bunun için var).

---

## 4. Eklenti kimliği — değiştirme

`manifest.json`'daki `key` alanı açık anahtar. Eklenti kimliği ondan türüyor ve
bu yüzden paketlenmemiş yüklemede bile her makinede aynı:

```
klgpcmbfjpkeodnfphjlbehkgdmomdlb
```

`data/extension.ts` bu değeri taşıyor; panel eklentiyi **bu kimlikle** arıyor.
`key` değişirse kimlik değişir ve panel eklentiyi bulamaz — ikisi birlikte
güncellenir. `extension/.key.json` yalnızca **açık** anahtarı tutuyor; özel
anahtar depoda değil ve olmamalı.

`externally_connectable.matches` panelin origin'ini beyan ediyor. Listede
olmayan bir çağıranı **tarayıcı** reddediyor, dinleyici hiç çalışmadan —
güvenlik bizim kodumuza bırakılmıyor. Yeni bir panel adresi eklenirse buraya
da eklenmeli.

---

## 5. Mesaj sözleşmesi

Üç sınır var ve birbirinin yerine geçmiyor:

```
panel  -> sw         chrome.runtime.sendMessage(EXTENSION_ID, msg)   (externally_connectable)
popup  -> sw         chrome.runtime.sendMessage(msg)
sw    <-> offscreen  chrome.runtime.sendMessage(msg) + `target` alanı
```

`target` alanı var çünkü service worker ile offscreen doküman **tek bir runtime
mesaj yolunu** paylaşıyor; onsuz her biri diğerinin trafiğine cevap verir.

Tüm mesajlar `lib/extension/messages.ts`'te tek bir ayrık birleşim. Dosya
`extension/` altında değil `lib/` altında, çünkü panel de aynı tipleri derliyor:
iki tarafın karşı derlediği tek sözleşme.

| Mesaj | Yön | Ne |
|---|---|---|
| `ambiflux/ping` → `pong` | panel/popup → sw | eklenti var mı, sürüm, motor durumu |
| `ambiflux/prepare` | popup → sw | **offscreen dokümanı ŞİMDİ kur** (§9) |
| `ambiflux/start` | popup → sw → offscreen | `streamId` ile yakalamayı başlat |
| `ambiflux/stop` | → sw → offscreen | durdur (doküman yoksa yaratma) |
| `ambiflux/serial` | popup → sw → offscreen | port eşleşti, `getPorts()` ile devral |
| `ambiflux/status` → `status-reply` | panel → sw | durum + son istatistikler |
| `ambiflux/config` → `config-reply` | panel → sw → offscreen | yapılandırmayı değiştir |
| `ambiflux/config-get` → `config-reply` | → sw | yürürlükteki yapılandırma |
| `ambiflux/stats`, `ambiflux/state` | offscreen → sw | yukarı rapor; sw sonuncuyu tutar |

**`config` alanı bilinçli olarak `unknown`.** Panelden ya da
`chrome.storage`'dan geliyor; worker onu `parseEngineConfig` ile ayrıştırıyor
ve hatayla cevap veriyor, güvenmiyor.

---

## 6. Hat — aşama aşama

`extension/src/offscreen.ts`, sabitler dosyanın başında:

```
GRID_W=128  GRID_H=72  OUTPUT_HZ=120  TICK_MS=4  REPORT_MS=1000
BAUD_RATE=921600  RECONNECT_MS=3000
```

**Kare geldiğinde** (`pump` → `processFrame`):

1. `MediaStreamTrackProcessor({ track, maxBufferSize: 1 })` — akış bizim için
   en fazla bir kare tutuyor, eskisini kaynak düşürüyor.
2. Hat meşgulse kare **düşürülür ve sayılır** (`pipelineDrops`). Kuyruk yok.
3. `createImageBitmap(frame, { resizeWidth: 128, resizeHeight: 72, resizeQuality: 'high' })`
   — **tek çağrılık küçültme.** Plan iki aşamalı WebGL küçültme öngörüyordu;
   ölçüldü ve gerek kalmadı: 1280×720 tek-piksel dama deseni → 128×72'de
   sonuç **127, yayılım 0** (doğru alan ortalaması). `'pixelated'` ise saf
   siyah veriyor — aliasing hatası. Bu ölçüm GPU'suz headless'ta yapıldı;
   gerçek GPU'da ve NV12/I420 kaynakta tekrar bakılmalı.
4. RGBA → **doğrusal ışık** (256 girişli `srgbToLinear` LUT). Ortalama
   doğrusalda alınır. En büyük tek kalite kazancı; Hyperion sRGB'de ortalıyor
   ve luminans pompalaması tam bundan.
5. Siyah kenar algılama (`border.ts`) → örnekleyiciye inset.
6. Örnekleme (`sample.ts`, `mean`) → LED başına doğrusal renk.
7. Renk düzeltme (`adjust.ts`).
8. Yumuşatıcıya **hedef** yazılır. Kare varışı yalnız hedefi günceller.

**Sabit tick'te** (`tick`, `setInterval(TICK_MS)`):

9. `smoother.tick(now)` — asimetrik IIR, attack 15 ms / release 90 ms, algısal
   ölü bant, sahne kesmesi bypass'ı. **Kare varışına bağlanmaz**: durağan
   ekranda yarı yolda donardı.
10. Kanal sırası (`order.apply`) — LED'e giden değil, **kabloya çıkan** sıra.
11. `encodeLinear16` → `Afx` yükü.
12. Seri yazıcı: **latest-wins, asla kuyruk yok.** Önceki `write()`
    çözülmediyse yeni kare düşürülür ve sayılır. Bunu yanlış yapmak 200 ms'lik
    bir USB tıkanmasını kalıcı büyüyen gecikmeye çevirir — bu sınıfın en yaygın
    hatası.

**Yapılandırma takası** (`build(config)` → `Stages`): `processFrame` `stages`'i
**bir kez** okur. İki satır arasındaki bir config takası bir örnekleyiciyi
başka bir yerleşimin tamponuyla karıştırırdı.

---

## 7. Seri protokol

Tek durum makinesi, üç baytlık magic ile dağıtım. `lib/engine/protocol.ts`.

| Magic | Yük | Trailer | Amaç |
|---|---|---|---|
| `Ada` | `n×3` 8-bit | — | Adalight geriye dönük |
| `Awa`/`AwA` | `n×3` 8-bit | 3 bayt Fletcher | AWA uyumu |
| **`Afx`** | `n×6` **16-bit BE doğrusal** | 3 bayt Fletcher | **ürün yolu** |
| `AxC` | TLV | 3 bayt Fletcher | config, sürüm, NVS (henüz yok) |

Başlık hepsinde aynı: `hi`, `lo`, `chk`; `ledCount = (hi<<8|lo) + 1`,
`chk = hi ^ lo ^ 0x55`. `HEADER_SIZE=6`, `TRAILER_SIZE=3`, `MAX_LEDS=65536`.

**Resync kuralı — her zaman yanlış yapılan yer.** Uyumsuzlukta mevcut baytı
yeni bir magic başlangıcı olarak *yeniden değerlendir*, atma: `MAGIC2`'de bayt
`'A'` ise `MAGIC2`'de kal. Yoksa `AAda…` içeren bir akış kalıcı olarak
desenkronize olur. Her geri dönüş `resyncs` sayacında sayılır.

**Fletcher escape — ezberden yazma, referanstan kopyala.** Hesaplanan checksum
baytı `0x41` (`'A'`) olabilir ve kare başlangıcı sanılır:

```c
fletcherExt = (fletcherExt + (*hasher ^ (position++))) % 255;
fletcher1   = (fletcher1 + *hasher++) % 255;
fletcher2   = (fletcher2 + fletcher1) % 255;
...
*writer++ = (fletcherExt != 0x41) ? fletcherExt : 0xaa;   // 'A' üretmeyi engelle
```

`position` bilinçli olarak her 256 baytta sarıyor (uint8). Bu kuralı ezberden
yazmak %99.6 çalışan ve birkaç saniyede bir kare düşüren bir cihaz üretir.

**Baud: 921600. Asla 1200'de açma** — bazı çekirdeklerde bootloader/DFU reset
tetikliyor.

---

## 8. Yapılandırma modeli

`lib/engine/config.ts`. Tek tip: `EngineConfig = { layout, blacklist, colorOrder }`.

**Doğrulama inşa ederek yapılıyor.** `parseEngineConfig` alan tiplerini ve
aralıklarını yerel kontrol ediyor, gerisini `classicLayout`/`matrixLayout`/
`applyBlacklist`'i **çağırarak**: üreticiler kendi kurallarını zaten belirli
hatalarla reddediyor, burada tekrar yazmak ikinci bir doğruluk kaynağı olurdu.
(Hyperion'da tam olarak bu yüzden oluşan iki kusur `hyperion-port-plan.md`'de.)

**Sahibi service worker.** Offscreen doküman yakalama durunca yok oluyor ve
worker'ın kendisi ~30 s boştalıkta öldürülüyor; ikisi de durum tutamaz.
`chrome.storage.local` ikisinden de uzun yaşıyor. Depodan geleni de
ayrıştırıyor: **eski bir sürümün yazdığı değer de bir güven sınırı.**

`resolveLayout(config)` — motorun ve panelin ikisinin de çağırdığı tek fonksiyon.

Yerleşim knob'ları: kenar sayıları, `depthTopBottom`/`depthLeftRight`, `start`
köşesi, `clockwise`, `offset`, `gap`, `overlap`, `edgeGap`, `aspectRatio`,
`keystone`. Matris için: `columns`, `rows`, `cabling`, `direction`, `start`.

---

## 9. Ölçüm ve açık hata

### 9.1 Motorun kendisi çalışıyor — ölçüldü

Uzantı bu depoda, başsız Chromium'a `--load-extension` ile yüklenip **sentetik
kaynakla** sürüldü (`ambiflux/selftest`: offscreen dokümanda bir canvas
`captureStream`). Ekran, seçici ve kart olmadan tüm hat koştu.

```
durum running · LED 108 · yakalanan 605 · teslim fps 57.3
varış p50 17.0 ms · p99 28.5 ms · boşluk 0 · hat düşen 0
işleme p50 1.70 ms · p99 24.90 ms · çıkış fps 114.7
link loopback yazılan 1107 · kabul 1107 · RED 0
kenar 0/0 · kaynak 640x360
```

**Bunun kanıtladıkları:**

- **`MediaStreamTrackProcessor` offscreen dokümanda kare teslim ediyor.** Bu
  E6'nın çekirdeği ve mimarinin dayandığı varsayımdı; artık varsayım değil.
- Hat uçtan uca koşuyor: küçültme, decode, kenar algılama, örnekleme, düzeltme,
  yumuşatma, kanal sırası, `Afx` çerçeveleme.
- **Çerçeveleme doğru: 1107 karede RED 0.** Loopback'in referans ayrıştırıcısı
  hepsini kabul etti — Fletcher escape'i ve başlık aritmetiği tutuyor.
- Kuyruk yok: `pipelineDrops` 0, `captureGaps` 0.
- Kenar algılayıcı sınama resminin **ortasındaki** siyah kareyi letterbox
  sanmadı (0/0) — aradığı bantlar kenarlarda.
- İşleme p50 **1.70 ms**, 120 Hz'in 8.33 ms bütçesinde rahat.

**Kanıtlamadıkları — bunları iddia etme:**

- Kaynak bir **canvas**, masaüstü yakalaması değil. Gerçek yakalamanın kare
  biçimi (NV12/I420), çözünürlüğü (1440p) ve maliyeti farklı.
- **Arka plan kısıtlaması denenmedi.** Offscreen dokümanın hiç render
  edilmediği için kısıtlanmadığı tezi hâlâ sınanmadı.
- İşleme **p99 24.90 ms**, bütçenin üç katı. Tek tük; muhtemelen GC ya da ilk
  karelerin ısınması, ama 1440p'de bakılmalı. Sayaç zaten yerinde.
- Çıkış fps 114.7, hedef 120. Sentetik kaynak 60 Hz boyandığı için teslim 57
  fps; yumuşatıcı aradaki kareleri üretiyor.

Tekrarlamak için: uzantı popup'ında **"Ekransız sına"**. Bu düğme kalıcı ve
ürünün parçası — şerit karanlık kaldığında "motor bozuk" ile "yakalama hiç
başlamadı"yı ayıran tek şey, ve ikisi dışarıdan aynı görünüyor.

### 9.2 AÇIK HATA — ekran yakalama başlamıyor

**Belirti** (kullanıcının makinesinde, 2026-09-13):

```
Başlatıldı: {"state":"error","error":"Error starting tab capture"}
```

Yani uzantı yükleniyor, popup çalışıyor, service worker cevap veriyor, offscreen
doküman kuruluyor — ama `getUserMedia` reddediyor.

**Bu ortamda üretilemiyor**: ekran yok, Arduino yok. Aşağısı teşhis.

`Error starting tab capture` Chromium'un yakalama yığınından gelen bir dize ve
adı yanıltıcı: `chromeMediaSourceId` geçersiz ya da **sona ermiş** olduğunda da
bu çıkabiliyor, çünkü tanınmayan bir masaüstü medya kimliği tab-capture yoluna
düşüyor.

**En olası sebep ve uygulanan düzeltme.** `chooseDesktopMedia`'nın verdiği
`streamId` **saniyeler içinde sönüyor**. Eski akışta id üretildikten sonra
`ambiflux/start` service worker'a gidiyor, worker `chrome.offscreen.createDocument`
çağırıyor, doküman yükleniyor, modül değerlendiriliyor — ve id bunların hepsini
bekliyor. Düzeltme: popup açılır açılmaz `ambiflux/prepare` gönderiyor, worker
dokümanı o anda kuruyor. Kullanıcı ekranı seçtiğinde doküman çoktan var.

**İkinci düzeltme — iki nedeni ayırt etmek için.** `mandatory` bloğu
hep-ya-hiç: Chrome bir üyesini onurlandırmazsa tüm isteği reddediyor ve verdiği
hata kısıt hakkında değil yakalama hakkında oluyor. `openCapture` artık önce
`maxFrameRate` ile, sonra onsuz deniyor, ve iki hatayı da `name` ile birlikte
bildiriyor — `DOMException.name` faydalı yarısını taşıyor, `message` tek başına
ne olursa olsun aynı şeyi diyor.

**Bu ikisi yetmezse sıradaki hipotezler**, sırayla:

1. **`streamId` çağıran bağlamına bağlı.** `chooseDesktopMedia` popup'tan
   çağrılıyor, id offscreen dokümanda tüketiliyor. Chrome'un kendi örneği
   (`sample.tabcapture-recorder`) **tab** yakalama için `getMediaStreamId`'yi
   service worker'dan çağırıyor. Denenecek: `chooseDesktopMedia`'yı service
   worker'dan çağırmak (kullanıcı hareketi gerektirmiyor, SW'de mevcut).
2. **Popup picker açılınca yok ediliyor.** Popup odak kaybedince Chrome
   dokümanı kapatıyor; callback bağlamı ölürse id iptal olabilir. Kullanıcının
   raporunda callback çalışmış görünüyor (yanıt geldi), ama `prepare`'in yan
   faydası bu riski de azaltıyor.
3. **Track transferi.** Chrome 111+'ta `MediaStreamTrack` transfer edilebilir:
   `getUserMedia` popup'ta çağrılır, track `postMessage` ile offscreen'e
   geçirilir. Daha büyük bir değişiklik, ama 1 ve 2'nin ikisini birden
   kökünden çözer.

**Teşhis için gereken** (kullanıcıdan istenecek): `chrome://extensions` →
AmbiFlux → **"service worker"** bağlantısı ve **offscreen.html** bağlamının
konsolu. `getUserMedia`'nın attığı `DOMException`'ın **`name`**'i belirleyici:
`NotAllowedError` izin/bağlam, `InvalidStateError` ölü id, `NotReadableError`
kaynak meşgul. Yeni popup metni bu adı zaten gösteriyor, ayrıca seçimin kaç ms
sürdüğünü de yazıyor.

---

## 10. Ölçülmemiş olanlar

Bu ortamda ekran ve Arduino yok. Aşağıdakiler **gerçek makinede** ölçülecek ve
bir kısmı mimariyi değiştirebilir.

| # | Ne | Neden önemli |
|---|---|---|
| ~~E6~~ | Offscreen'de MSTP kare teslim ediyor mu | **KAPANDI, §9.1.** Sentetik kaynakla 605 kare, 57 fps, 0 düşen. Yedek mimariye (kareleri worker'a geçirmek) gerek yok. Arka plan kısıtlaması hâlâ sınanmadı. |
| **E4** | Teslim edilen FPS: istenen 60 ve 120'de, ön planda **ve** arka planda | Kareleri say, `getSettings().frameRate`'i yok say. p50/p1/p99 varış aralığı bildir — ortalama tam da önemsenen duraklamaları saklıyor. |
| **E7** | Aliasing: 1 piksel dama deseni + ince metin | Tek aşamalı küçültme headless'ta doğru çıktı; gerçek GPU'da ve NV12 kaynakta tekrar. |
| **E8** | İçerik matrisi (DRM): Netflix tarayıcı vs Store, Prime, Disney+, YouTube HDR | Test sonucu değil, **ürün destek dokümanı**. Ne reklam edilebileceğini değiştirebilir. |
| **E10** | Uçtan uca gecikme: 240 fps telefon kamerası, siyah→beyaz flaş | 4.17 ms çözünürlük, bedava, ve **ekran gecikmesi dahil tüm zinciri** ölçüyor. |

### Dört ayrı sayaç, çünkü farklı şekillerde bozuluyorlar

- `captureGaps` — yakalamanın teslim ettiği karelerdeki varış boşlukları
- `pipelineDrops` — önceki kare hâlâ işlenirken gelenler (latest wins)
- `link.dropped` — seri yazma uçuştayken düşenler (latest wins)
- `link.rejected` — loopback'in referans ayrıştırıcısının reddettikleri;
  **sağlıklı = tam olarak 0**, çerçeveleme hatası demek

Tek bir "FPS" sayısı bu dördünü birbirine karıştırır ve hangi aşamanın
bozulduğunu saklar. Paneldeki Cihaz kartı dördünü ayrı gösteriyor.

---

## 11. Yapılmayacaklar

Bunlar daha önce düşünülüp elenmiş ya da başkasının kodunda görülmüş hatalar.

**Hyperion.NG'den kopyalanmayacaklar** (tamamı `hyperion-port-plan.md`'de):

- `latchTime` varsayılanı 30 ms Adalight çıkışını sessizce ~33 Hz'e kapıyor.
  120 Hz için **0 şart**. Ayrıca kapı milisaniye hassasiyetinde — monoton
  mikrosaniye saat kullan.
- Bilinear `DrawBitmap` 8× küçültmede piksellerin %94'ünü atıyor; zamansal
  olarak kararsız kenar rengi, yani durağan ekranda LED titremesi.
- sRGB'de ortalama + sonra gama: luminans pompalamasının tam nedeni.
- Letterbox histerezisi **kare** sayıyor, zaman değil (`borderFrameCnt = 50`).
  Hyperion'un 10 FPS'inde 5 saniye, bizim 120 FPS'imizde 0.42 saniye — 12 kat
  daha seğirgen. Bizde **ms tabanlı**.
- Tam sayı bölmesi: 120 Hz → 8 ms → aslında 125 Hz.

**Bu kod tabanının kuralları:**

- Sıcak yolda tahsis yok. Renkler düz `Float32Array`, LED başına nesne yok —
  108 LED × 120 Hz saniyede on üç bin üçlü demek.
- Renkler **doğrusal ışık, 0..1 float**. uint8 sRGB taşımak Hyperion'un
  kusurlarının yarısının kaynağı.
- Zaman her yerde **enjekte edilen monoton `Clock`**. Asla `Date.now`: NTP
  adımı ya da DST değişimi kayar.
- Motor modülleri tarayıcı API'si bilmez; `lib/engine/` altındaki hiçbir şey
  `chrome.*`, `document` ya da `navigator` görmez. Testler bu yüzden var.
- Her bilinçli sapmanın Hyperion davranışında **başarısız olan** bir testi var.
- Panele giden hiçbir şey "bağlandı" numarası yapmaz: eklenti yoksa **yok**
  yazar.

**Ticari taraf:** `LICENCE_SIGNING_KEY` asla depoya girmez. Lisans **fail
open** — sunucu erişilemezse `notAfter`'a kadar çalış, sonra *yine de çalış*
ama uyar. Bir aydınlatma ürününü barındırma faturası yüzünden sert durdurmak
chargeback ve tek yıldız üretir.

---

## 12. Sıradaki iş

1. **§9'daki yakalama hatasını kapat.** Her şey buna bağlı; motor bir kare
   görmeden hiçbir ölçüm yapılamaz.
2. **E6'yı kapat** — kare geliyorsa mimari doğrulanmış olur, gelmiyorsa worker
   yedeğine geçilir.
3. **E4 ve E10'u ölç**, sayaçlarla ve telefon kamerasıyla.
4. **Firmware** (ESP32-S3, `Afx`, RMT DMA, `esp_timer` pacing, interpolasyon,
   dither, güç sınırlayıcı). Plan `hyperion-port-plan.md`'de tam.
5. **Kalibrasyon sihirbazı**: şeridi yürüt, kullanıcı köşeleri tıklasın,
   yerleşimi çıkar. Farklı monitörü olan birine satılabilir yapan şey bu.
   Kanal sırası sihirbazı (`deriveColorOrder`) yazıldı ve test edildi ama
   arayüzü yok: şeridi düz renkle yakacak bir kaynak gerekiyor, `PriorityMuxer`
   var ama onu besleyen yok.
6. **Web Store yayını.** `desktopCapture` izni incelemeyi uzatır; gerekçe
   metni hazırlanmalı.
