# AmbiFlux Chrome eklentisi — mimari ve plan

> **2026-09-13, güncelleme: eklenti geri alındı.** Bu dosya bir süre devir
> dokümanıydı (Antigravity 2.0'a); eklenti tekrar bu depoda geliştiriliyor.
> İçerik aynen geçerli — asıl değeri zaten devretmek değil, **neyin neden böyle
> olduğunu ve daha önce neyin ölçüldüğünü** kayda geçirmekti. §12'nin durumu
> aşağıda işaretli.
>
> Ayrıca: §1'deki "satılacak" ifadesi geçersiz. Uygulama **açık kaynak**;
> lisans, aktivasyon ve koltuk limiti silindi (bkz. kök `README.md`).

Depoda bu dosyanın kardeşleri: `docs/hyperion-port-plan.md` (motor
algoritmalarının kaynağı ve Hyperion.NG'den kopyalanmayacak 10 kusur),
`docs/deploy.md`, `docs/tooling.md`, ve kök `README.md`.

Son güncelleme: 2026-09-13. Durum: **motor gerçek ekran yakalamasıyla uçtan uca
çalışıyor ve ölçüldü** (§9). Bilinen tek performans sorunu 1440p'de işleme
süresi (§9.3). Bundan sonrası §12'deki plan.

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

## 9. Ölçüm

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

### 9.2 Ekran yakalama — neden bir kez bozuktu, ve çözümü

Bu bölüm çözülmüş bir hatayı anlatıyor, çünkü **cevabı Chrome'un dokümanından
okunmuyor** ve aynı yanlışa tekrar düşmek kolay.

**Belirti:** yakalama `AbortError: Error starting tab capture` ile düşüyordu
(bazı derlemelerde `AbortError: Invalid state`). İsim yanıltıcı: ortada tab
capture yok.

**İlk hipotez yanlıştı.** `chooseDesktopMedia`'nın verdiği streamId saniyeler
içinde söner, ve o sırada offscreen doküman sıfırdan yaratılıyordu — makul bir
şüpheli. Ölçüldü: seçici **9 ms**'de dönüyor, kullanıcının makinesinde 2344 ms.
Süre değil.

**Yer belirlendi.** Aynı oturumda, aynı id türüyle, sırayla:

```
POPUP     ✅ 1280x720
OFFSCREEN ❌ AbortError: Invalid state
POPUP     ✅ 1280x720
```

Aynı uzantı, aynı origin, deterministik. Sebep **bağlam**.

**Offscreen dokümanın gerçekte sahip oldukları** (yoklandı):

```
chrome.* yüzeyi   : csi, loadTimes, runtime
chrome.desktopCapture : undefined
chrome.tabCapture     : undefined
navigator.mediaDevices.getDisplayMedia : function → 1920x1080 akış verdi
kullanıcı hareketi : GEREKMİYOR (bayraksız denemede seçici açılıp bekledi)
```

**Sonuç: baştan yanlış API kurulmuştu.** `chrome.desktopCapture` streamId'si
onu isteyen bağlama bağlı; offscreen doküman o API'yi hiç görmüyor; ve
`MediaStreamTrack` elden de verilemiyor, çünkü `chrome.runtime` mesajlaşması
transferable taşımıyor. Offscreen dokümanın **`DISPLAY_MEDIA` gerekçesi tam
olarak `getDisplayMedia` için var.**

**Düzeltme:** popup hiçbir şey seçmiyor, yalnız istiyor; seçiciyi motor
dokümanı `navigator.mediaDevices.getDisplayMedia()` ile kendisi açıyor.
`desktopCapture` izni manifest'ten kalktı.

> Bunu değiştirmeyi düşünen için: popup'tan seçip id'yi göndermek **çalışmıyor**,
> ve nedeni yukarıda. Kod yorumunda da yazıyor.

### 9.3 Gerçek yakalamayla ölçüm — ve tek gerçek darboğaz

1920×1080 masaüstü kaynağı, offscreen doküman, loopback:

```
yakalanan 1020 · teslim fps 108.3 · kaynak 1920x1080@120
varış p50 9.1 ms · düşen 0 · loopback kabul 1018 · RED 0 · kenar 0/2
işleme p50 9.00 ms · p99 14.10 ms · çıkış fps 108.3
```

Teslim 108 fps, düşen kare yok, çerçeveleme 1018 karede kusursuz.

**Ama işleme p50 9.00 ms**, 120 Hz'in 8.33 ms bütçesinin üstünde. Sentetik
640×360 kaynakta 1.70 ms'ti; aradaki fark **küçültmenin maliyeti**. Bu gerçek
bir darboğaz ve §12'nin ilk maddesi.

Şu an düşen kare üretmiyor çünkü kaynak 108 fps veriyor ve hat latest-wins —
ama 120 Hz'de her karenin işlenmesi isteniyorsa buraya bakılmalı. Ölçüm için
gereken sayaç (`processMs` p50/p99) zaten raporda.

## 10. Ölçülmemiş olanlar

Bu ortamda ekran ve Arduino yok. Aşağıdakiler **gerçek makinede** ölçülecek ve
bir kısmı mimariyi değiştirebilir.

| # | Ne | Neden önemli |
|---|---|---|
| ~~E6~~ | Offscreen'de MSTP kare teslim ediyor mu | **KAPANDI, §9.1.** Sentetik kaynakla 605 kare, 57 fps, 0 düşen. Yedek mimariye (kareleri worker'a geçirmek) gerek yok. Arka plan kısıtlaması hâlâ sınanmadı. |
| **E4** | Teslim edilen FPS **arka planda** — ön planda 108 fps ölçüldü (§9.3) | Offscreen dokümanın hiç render edilmediği için kısıtlanmadığı tezi hâlâ sınanmadı. Mimarinin tamamı buna dayanıyor. Kareleri say, `getSettings().frameRate`'i yok say. |
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

## 12. Eklenti için plan — devredilen iş

Aşağıdakiler benim eklenti için yapmayı planladığım işin tamamı, yapılış
sırasıyla. Her madde **neden** yapıldığını taşıyor, çünkü sırayı değiştirmek
isteyen bunu bilmeden karar veremez.

### 12.1 Önce bunlar — ölçüm mimariyi değiştirebilir

**(a) E4: arka plan kısıtlaması.** *Bütün mimari buna dayanıyor* ve hâlâ
sınanmadı. Offscreen doküman hiç render edilmediği için kısıtlanmıyor olmalı;
"olmalı" yeterli değil. Ölçüm: yakalamayı başlat, Chrome'u tamamen arka plana
al (tam ekran başka uygulama), 60 s bekle, `capturedFrames` farkını al. Ön plan
108 fps ölçüldü (§9.3). Arka planda düşerse ürün tarayıcıda olamaz ve plandaki
yerel yardımcı uygulamaya dönülür — o yüzden **ilk bu**.

**(b) §9.3'teki işleme süresi.** 1080p'de p50 9.00 ms, bütçe 8.33 ms. Sıra:

1. Önce **nerede geçtiğini ölç**, tahmin etme. **✅ YAPILDI:** `processFrame`
   artık dört parçada ölçülüyor ve `stats.stageMs` ile panele geliyor —
   `downscale` (`createImageBitmap`), `readback` (`drawImage` + `getImageData`),
   `decode`, `sample`. Cihaz sayfasında ayrı bir kutuda. **Sayıyı gerçek bir
   makinede okumak kaldı**; buradaki headless ölçüm GPU'suz ve yanıltıcı olur.
   Dördü işin kendisini toplar; toplamları ile `processMs` p50 arasındaki fark
   kuyruklama gecikmesi, yani motorun ne kadar geride koştuğu.
2. Küçültme ise: `createImageBitmap` yerine `OffscreenCanvas` + `drawImage`
   (ikisi de ölçüldü, ikisi de doğru alan ortalaması yapıyor — hangisinin daha
   ucuz olduğu ölçülmedi), ya da WebGPU ile tek geçişte.
3. Izgara 128×72; LED başına ~3.7 yatay hücre. 96×54'e inmek maliyeti üçte bir
   azaltır ve LED başına hâlâ 2.7 hücre bırakır. **Kalite kaybı ölçülmeden
   yapılmaz** (E7'nin dama deseni bunun için).

**(c) E7: aliasing.** Tek aşamalı küçültme headless'ta matematiksel olarak
doğru çıktı (1 piksel dama → düz 127). Gerçek GPU'da ve NV12/I420 kaynakta
tekrar. Bozuksa iki aşamalı küçültmeye dönülür — plan onu zaten anlatıyor.

**(d) E8: DRM içerik matrisi.** Netflix tarayıcı vs Store uygulaması, Prime,
Disney+, YouTube HDR, mpv, tam ekran oyun, kenarsız oyun, letterbox'lı film.
Bu bir test değil **ürün destek dokümanı**, ve ne reklam edilebileceğini
değiştirebilir.

### 12.2 Arayüz ve kullanım — bunlar ürünü satılabilir yapan kısım

**(e) Yakalamanın kalıcılığı. ✅ YAPILDI.** `streamId` kalıcı yapılamıyor ama
`getDisplayMedia` seçimi Chrome oturumu boyunca yaşıyor. Yapılacak: Chrome
açılışında motor kendini kurmalı ve **tek bir tıkla** devam edebilmeli.
`chrome.runtime.onStartup` ile offscreen dokümanı kur, kullanıcıya bildirimle
"devam et" sun. "OS ile başlar ve hiç sormaz" tarayıcıda mümkün değil — bunu
arayüzde dürüstçe söyle, gizleme.

**(f) Yakalama koptuğunda kendine gelme. ✅ YAPILDI.** Çözünürlük değişimi, monitör
uyku/uyanma, HDR aç/kapa yakalamayı öldürüyor. Şu an `ended` dinleniyor ve
duruluyor; yapılması gereken **kullanıcıya haber verip tek tıkla yeniden
başlatmak**. Gerçek makinelerde bu her gün olacak.

**(g) Panelden kontrol. ✅ YAPILDI.** Bugün panel yalnız durum okuyor ve yapılandırma
gönderiyor. Başlat/durdur da panelden yapılabilmeli — ama ekran seçici
kullanıcı tarafında açılacağı için akış: panel → sw → offscreen → seçici.

**(h) Kalibrasyon sihirbazı.** *Farklı monitörü olan birine satılabilir yapan
şey bu.* Şeridi yürüt (tek LED 0→107), kullanıcı köşeleri tıklasın, yerleşimi
çıkar. Panel tarafında yerleşim editörü ve keystone köşeleri hazır; eksik olan
şeridi yürüten kaynak.

**(i) Kanal sırası sihirbazı. ✅ YAPILDI.** `deriveColorOrder` yazıldı ve test edildi ama
arayüzü yok: şeridi düz kırmızı/yeşil ile yakıp kullanıcıya "ne gördün" diye
sormak gerekiyor. (h) ile aynı eksiği paylaşıyor.

**(j) (h) ve (i)'nin ortak önkoşulu: bir test deseni kaynağı. ✅ YAPILDI.** `PriorityMuxer`
var ama onu besleyen yok. `ambiflux/selftest` zaten motoru sentetik bir
kaynakla besliyor — aynı yol düz renk ve tek-LED yürüyüşü için kullanılmalı.
**Bu üçünü birlikte yap**, ayrı ayrı değil.

### 12.3 Kalite — hat zaten çalışırken

**(k) Yumuşatma sabitleri arayüzde.** Üç profil: Cinema 30/120 Hz 40/200 ms,
Balanced 60/120 Hz 15/90 ms, Competitive 120/120 Hz 6/30 ms. Motor zaten
asimetrik yumuşatmayı destekliyor; eksik olan yapılandırma ve arayüz.
`EngineConfig` bu yüzden yumuşatmayı henüz taşımıyor — okunmayan bir alan
ürünün tutmadığı bir söz olurdu.

**(l) Renk düzeltme arayüzü.** `adjust.ts` 8 aşamalı düzeltme yapıyor
(beyaz dengesi, doygunluk, parlaklık, Kelvin, taper) ve hiçbiri panelden
ayarlanamıyor. LED şeritleri yeşil ağırlıklı; beyaz dengesi müşterilerin ilk
isteyeceği şey.

**(m) Kenar algılama modu.** `border.ts` dört mod destekliyor;
yapılandırılabilir değil. 2.39:1 film izlerken üst/alt LED'lerin ölmemesi bu
modülün işi ve ürünün en çok fark edilecek özelliklerinden biri.

**(n) Telemetri paneli.** Dört sayaç panelde gösteriliyor ama grafik yok.
p50/p99 zaman serisi, hangi aşamanın bozulduğunu anlık gösterir.

### 12.4 Dağıtım

**(o) Web Store yayını.** `desktopCapture` izni kalktı (§9.2), geriye
`offscreen` ve `storage` kaldı — inceleme için iyi bir yer. Gerekçe metni
`getDisplayMedia` kullanımını ve **ekran görüntüsünün hiçbir yere
gönderilmediğini** açıkça söylemeli.

**(p) Sürüm ve güncelleme.** `manifest.json` sürümü `data/version.ts` ile
elle eşleşiyor; tek kaynaktan türetilmeli. Web Store dışı dağıtım için
`update_url` gerekir.

**(q) Gizlilik metni.** Ekranını izleyen bir ürün için "ekranını hiç
görmüyoruz" gerçek bir satış argümanı — ve doğru: kareler yalnız offscreen
dokümanda yaşıyor, hiçbir ağ isteği yapılmıyor. Bunu ölçülebilir şekilde
söyle (ağ izinleri manifest'te yok).

### 12.5 Eklentinin dışında ama ona bağlı

**(r) Firmware** (ESP32-S3, `Afx`, RMT DMA, `esp_timer` pacing, interpolasyon,
dither, güç sınırlayıcı). Tam plan `hyperion-port-plan.md`'de. Eklenti tarafı
hazır: `Afx` çerçeveleme 1018 karede sıfır redle doğrulandı.

**(s) E10: uçtan uca gecikme.** 240 fps telefon kamerası, monitör ve LED'ler
aynı karede, siyah→beyaz flaş. Firmware gelince, ve **ekran gecikmesi dahil
tüm zinciri** ölçen tek yöntem bu.

### Durum, 2026-09-14

| | Madde | Durum |
|---|---|---|
| (a) | E4 arka plan kısıtlaması | **açık** — senin makinen gerekiyor, mimarinin dayanağı |
| (b) | İşleme süresi | ölçüm **yapıldı**, optimizasyon gerçek makinede okunacak sayıya bağlı |
| (c) | E7 aliasing | açık — gerçek GPU gerekiyor |
| (d) | E8 DRM matrisi | açık — ürün destek dokümanı |
| (e) | Yakalamanın kalıcılığı | **yapıldı** |
| (f) | Yakalama koptuğunda | **yapıldı** |
| (g) | Panelden kontrol | **yapıldı** |
| (h) | Kalibrasyon sihirbazı | önkoşulu (j) hazır; köşe tıklama arayüzü kaldı |
| (i) | Kanal sırası sihirbazı | **yapıldı** — panelde Kalibrasyon bölümünde |
| (j) | Test deseni kaynağı | **yapıldı** — `lib/engine/patterns.ts`, 14 test |
| (k) | Yumuşatma profilleri | açık |
| (l) | Renk düzeltme arayüzü | açık |
| (m) | Kenar algılama modu | açık |
| (n) | Telemetri paneli | kısmen — sayaçlar ve aşama kırılımı var, grafik yok |
| (o)-(q) | Dağıtım | açık |
| (r) | Çıkış katmanı (`FrameSink`) | **yapıldı** — `lib/engine/sink.ts`, renk alıyor, bayt değil |
| (s) | Ağ sürücüleri | **yapıldı** — `lib/engine/net.ts` (bizim firmware + WLED), panelde taşıma seçici |
| (t) | Firmware WebSocket sunucusu | **yapıldı** — `nano_esp32_net`, `ws://<adres>/afx`, aynı baytlar aynı ayrıştırıcıya |
| (u) | `AxC` kontrol kanalı, host tarafı | **yapıldı** — `lib/engine/control.ts`; WiFi kimlik bilgileri Cihaz sayfasından |
| (v) | Motoru host'tan ayır | **yapıldı** — `lib/engine/runtime.ts`; offscreen 875 → 199 satır |
| (w) | Sayfa host'u | **yapıldı** — `lib/page-host.ts`; üç kare rotası gerçek tarayıcıda ölçüldü |
| (x) | Efekt motoru | **yapıldı** — `lib/engine/effects.ts`, yedi efekt, kendi paneli, CPython yok |
| (y) | Ses görselleştirici | **yapıldı** — `lib/engine/audio{,-input}.ts`, üç görselleştirici, iki giriş, iOS dahil |

### Sıra değiştirmek isteyen için

(a) her şeyden önce gelir: sonucu olumsuzsa 12.2 ve 12.3'ün tamamı boşa gider.
(b) ondan sonra gelir çünkü ölçülebilir bir bütçe aşımı ve gecikmesi ucuz.
12.2 ürünü satılabilir yapan kısım; 12.3 onu iyi yapan kısım; ikisinin sırası
değiştirilebilir. (j) kendinden sonraki ikisinin önkoşulu, atlanamaz.
