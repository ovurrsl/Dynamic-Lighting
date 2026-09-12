> **ARŞİV — 2026-09.** Bu doküman WinUI 3 uygulamasının yerine ne
> konabileceğini araştırıyordu. Ürün kararları o zamandan beri değişti, yani
> **olduğu gibi okunmamalı.** Geçmiş kaydı olarak duruyor.
>
> **Geçersiz olanlar:**
> - **§1 ve §4 — ASUS Aura ve Corsair iCUE Link port haritası: kapsam dışı.**
>   Ürün yalnızca kendi Arduino cihazını sürüyor.
> - **§4 — HID feature-report yolu: gitti.** Windows Dynamic Lighting /
>   LampArray desteği tamamen kaldırıldı; firmware ESP32-S3 üzerinde yalnızca
>   seri protokol konuşacak.
> - **§6'daki "tarayıcı yakalaması 60 FPS'e kapalı" ifadesi yanlıştı.**
>   Chromium'da `kMaxScreenCastFrameRate = 120.0`; gerçek kısıt her yakalamanın
>   ≤4.17 ms bitmesini şart koşan %50 CPU valfi.
> - Dokümanın LampArray yolunun korunacağını varsayan her yeri.
>
> **Hâlâ geçerli olanlar:**
> - **§6** ekran yakalama uyarıları ve ölçümleri.
> - **§9** barındırma analizi: barındırılan bir sayfanın neden kalıcı bağlantı
>   tutamayacağı, ve korsanlığın barındırmayla engellenemeyeceği.
>
> Güncel mimari: [`../deploy-hostinger.md`](../deploy-hostinger.md) ve depo kökündeki
> `README.md`.

---

# Node.js / web tabanlı mimariye geçiş analizi

Bu doküman, WinUI 3 masaüstü uygulamasının yerine tarayıcıdan kullanılan bir
Node.js uygulamasının konabilir mi sorusunu inceler. Kısa cevap: **evet, ve
cihaz katmanının tamamı bire bir taşınabiliyor.** Tek gerçek boşluk WinRT'ye
bağlı olan `Windows.Devices.Lights.LampArray` çağrısı; onun da doğrudan HID
üzerinden daha iyi bir karşılığı var.

Aşağıdaki "doğrulandı" işaretli maddeler bu depoda fiilen test edilmiştir,
tahmin değildir.

---

## 1. Özet ve karar

| Katman | Bugün | Node.js'te | Durum |
|---|---|---|---|
| ASUS Aura (HID, 0x0B05) | HidLibrary | `node-hid` | Bire bir taşınır |
| Corsair iCUE Link (HID, 1B1C:0C3F) | HidLibrary | `node-hid` | Bire bir taşınır |
| Arduino LampArray | `Windows.Devices.Lights.LampArray` (WinRT) | `node-hid` feature report *veya* CDC seri | WinRT gider, yerine daha doğrudan yol gelir |
| Animasyon motoru | `AnimationManager` (Task + 33 ms) | Node zamanlayıcı döngüsü | Bire bir taşınır |
| Ses tepkimeli mod | NAudio `MasterPeakValue` | Tarayıcıda Web Audio | Yaklaşım değişir, sonuç aynı |
| Arayüz | WinUI 3 / XAML | HTML + WebSocket | Yeniden yazılır |
| Ayarlar | `settings.json` | Aynı dosya, aynı şema | Değişiklik yok |

Sonuç: geçiş teknik olarak engelsiz. En büyük kazanç ekran-ambilight ve ses
yakalamanın *kolaylaşması*; en büyük kayıp uygulamanın Windows Dynamic
Lighting ekosistemine sağlayıcı olarak katılamaması (ki bu bugün de
çalışmıyor, aşağıda açıklanıyor).

Framework tercihi: **Fastify** (yerel ajan) + **SvelteKit** (arayüz). İkisi de
Hostinger'ın desteklediği listede; ancak cihaz katmanı fiziksel olarak yerel
makinede kalmak zorunda — ayrıntısı bölüm 9'da.

---

## 2. Doğrulanan gerçekler

`node-hid@3.4.0` bu oturumda kurulup incelendi:

- **Windows prebuild'leri hazır: `win32-x64`, `win32-ia32`, `win32-arm64`** —
  yani projenin bugün desteklediği üç platformun tamamı. Ayrıca
  `darwin-arm64/x64` ve `linux-*`. Kullanıcıda Visual Studio / node-gyp
  gerekmiyor.
- Prebuild tek bir dosya: `node-napi-v4.node` (413 KB). **N-API v4** olduğu
  için Node sürümleri arasında ABI kararlı; Node güncellemesinde yeniden
  derleme gerekmiyor.
- Windows arka ucu `hidapi/windows/hid.c` ve yalnızca `setupapi.lib`'e
  bağlanıyor. **libusb gibi harici DLL yok** (Linux'ta libusb/libudev gerekir,
  Windows'ta gerekmez).
- Gereken API'lerin tamamı var: `write()`, `readTimeout()`,
  **`sendFeatureReport()`**, **`getFeatureReport()`** — LampArray protokolü
  tamamen feature report üzerinden çalıştığı için son ikisi şart.
- `HIDAsync` sınıfı ile tüm cihaz G/Ç'si Promise tabanlı yapılabiliyor; olay
  döngüsü bloklanmıyor. (Senkron `HID` sınıfı da duruyor.)
- Cihaz listesi `interface`, `usagePage` ve `usage` alanlarını veriyor. Bu,
  C# tarafındaki `DevicePath.Contains("mi_02")` / `"mi_00"` dizgi eşlemesinin
  **temiz karşılığıdır**: `mi_02` → `interface === 2`, `mi_00` →
  `interface === 0`.
- `nonExclusive` seçeneği **yalnızca macOS'ta** etkili; Windows ve Linux'ta
  no-op. Ancak Windows'ta hidapi cihazı zaten her zaman
  `FILE_SHARE_READ | FILE_SHARE_WRITE` ile açıyor — yani Armoury Crate, iCUE
  veya Windows Dynamic Lighting servisi ile **aynı anda handle tutmak
  mümkün**. Çakışma handle düzeyinde değil, mantık düzeyinde olur (iki yazılım
  aynı şeride farklı renk yazar). Bu bugün C# tarafında da böyle.
- hidapi önce okuma-yazma açmayı dener, başarısız olursa **salt okunur** handle
  ile devam eder. Bu durumda enumerasyon başarılı görünür ama yazmalar sessizce
  başarısız olur — teşhis mesajı yazarken bu ayrımı gözetmek gerekir.

Ayrıca Arduino firmware'inden ölçülen rapor boyutları (bu depodaki test
koşumundan): `LampArrayAttributes` 27 bayt, `LampAttributesResponse` 29,
`LampMultiUpdate` 51, `LampRangeUpdate` 10, `LampArrayControl` 2.

---

## 3. Hedef mimari

```
┌──────────────────────────── Tarayıcı (Chrome/Edge) ────────────────────────────┐
│  Arayüz: renk seçici, mod/hız, cihaz listesi, canlı önizleme                   │
│  getDisplayMedia(video) → canvas → kenar örnekleme  → per-LED kare             │
│  getDisplayMedia(audio) → AnalyserNode            → ses seviyesi               │
└──────────────────────────────── WebSocket ─────────────────────────────────────┘
                                      │
┌─────────────────────── Node.js sunucusu (localhost / LAN) ─────────────────────┐
│  HTTP (statik arayüz) + WebSocket (durum & kare akışı)                          │
│  Animasyon motoru: Static / Breathing / Rainbow / AudioReactive / Ambilight     │
│  Cihaz yöneticisi + ayar kalıcılığı (settings.json)                             │
├────────────────┬───────────────────────┬───────────────────────────────────────┤
│  node-hid      │  node-hid             │  node-hid (feature report)            │
│  ASUS Aura     │  Corsair iCUE Link    │  ─ veya ─ serialport (CDC, hızlı yol) │
└────────────────┴───────────────────────┴───────────────────────────────────────┘
```

Önemli: bu bir **yerel sunucu**, bulut uygulaması değil. Donanımın bağlı olduğu
makinede çalışmak zorunda. Kazanç, arayüzün aynı ağdaki telefondan/tabletten
de açılabilmesi.

### Proje iskeleti önerisi

Fastify (sunucu) + SvelteKit (arayüz) varsayımıyla:

```
server/
  index.js            # Fastify: statik arayüz + WebSocket
  devices/
    manager.js        # DeviceManager karşılığı
    aura.js           # AuraBaseController + AuraMainboardController karşılığı
    corsair.js        # CorsairICueLinkController karşılığı
    lampArrayHid.js   # LampArray'i doğrudan HID ile süren istemci
    lampArraySerial.js# (opsiyonel) CDC hızlı yol
  engine/
    animation.js      # AnimationManager karşılığı
    color.js          # HSV, gama
  settings.js         # SettingsManager karşılığı, aynı JSON şeması
web/                  # SvelteKit projesi (adapter-static ile build edilir)
  src/routes/+page.svelte
  src/lib/socket.js
  src/lib/capture/ambilight.js
  src/lib/capture/audio.js
```

---

## 4. Cihaz katmanı: C# → Node port haritası

### 4.1 ASUS Aura

Protokol katmanı doğrudan çevrilir; `HidLibrary`'nin `Write(byte[65])`
çağrısında ilk bayt report ID'dir ve `node-hid` de aynı kuralı kullanır.

```js
import HID from 'node-hid';

const AURA_VID = 0x0b05;
const AURA_PIDS = [0x1867, 0x1872, 0x18a3, 0x18a5,
                   0x18f3, 0x1939, 0x19af, 0x1aa6, 0x1bed];

export function findAura() {
  const candidates = HID.devices().filter(
    (d) => d.vendorId === AURA_VID && AURA_PIDS.includes(d.productId));
  // C# tarafındaki "mi_02" yol eşlemesinin karşılığı
  return candidates.find((d) => d.interface === 2) ?? candidates[0];
}

const LEDS_PER_PACKET = 20;

export async function sendDirect(dev, directChannel, r, g, b, ledCount) {
  for (let offset = 0; offset < ledCount; offset += LEDS_PER_PACKET) {
    const n = Math.min(LEDS_PER_PACKET, ledCount - offset);
    const apply = offset + n === ledCount;

    const buf = Buffer.alloc(65);
    buf[0] = 0xec;                                   // report ID
    buf[1] = 0x40;                                   // AURA_CONTROL_MODE_DIRECT
    buf[2] = (apply ? 0x80 : 0x00) | directChannel;
    buf[3] = offset;
    buf[4] = n;
    for (let i = 0; i < n; i++) {
      buf[5 + i * 3] = r; buf[6 + i * 3] = g; buf[7 + i * 3] = b;
    }
    await dev.write(buf);
  }
}
```

Firmware sürümü ve config table okuması (`0x82` / `0xB0`) için
`dev.write(...)` + `dev.read(timeout)` aynı sırayla çalışır. C# kodundaki
"report ID Data'da var mı yok mu" belirsizliği node-hid'de de geçerlidir;
mevcut iki-offset deneme mantığı korunmalı.

### 4.2 Corsair iCUE Link

```js
export async function sendCommand(dev, command, data, waitForResponse = true) {
  const buf = Buffer.alloc(513);
  buf[0] = 0x00;  // HID report ID
  buf[1] = 0x00;
  buf[2] = 0x01;
  command.copy ? command.copy(buf, 3) : Buffer.from(command).copy(buf, 3);
  if (data?.length) Buffer.from(data).copy(buf, 3 + command.length);
  await dev.write(buf);
  return waitForResponse ? dev.read(1000) : null;
}
```

C# tarafındaki `_usbLock` yerine Node'da tek bir seri kuyruk (promise zinciri)
kullanılır; tek iş parçacığı olduğu için kilit gerekmez ama **çağrıların
sıralanması şarttır** — `UpdateLights` içindeki close/open/chunk/close dizisi
araya girecek başka bir komutla bozulur.

Not: mevcut C# kodundaki `writeBuf` 513 baytlık tampon, 2 baytlık komut +
508 baytlık chunk ile tam sınırda doluyor. Port ederken chunk boyutunu
`513 - 3 - command.length` olarak hesaplamak bu kırılganlığı ortadan kaldırır.

### 4.3 Arduino LampArray — iki yol

**Yol A: doğrudan HID feature report (WinRT'ye gerek yok)**

Arduino'nun kendisi bir HID LampArray cihazı. Windows'un aracılığına gerek
olmadan doğrudan konuşulabilir. Cihazı bulmak için usage page 0x59 / usage
0x01 (firmware'deki report descriptor'ın ilk baytları: `0x05 0x59 0x09 0x01`):

```js
const lamp = HID.devices().find((d) => d.usagePage === 0x59 && d.usage === 0x01);
const dev = await HID.HIDAsync.open(lamp.path);

// 1) Kontrolü devral: LampArrayControl, AutonomousMode = 0
await dev.sendFeatureReport(Buffer.from([6, 0]));

// 2) Tüm şeridi tek raporla boya: LampRangeUpdate (10 bayt)
function rangeUpdate(start, end, r, g, b, intensity = 255) {
  const buf = Buffer.alloc(10);
  buf[0] = 5;                       // LAMP_RANGE_UPDATE_REPORT_ID
  buf[1] = 0x01;                    // UPDATE_COMPLETE
  buf.writeUInt16LE(start, 2);
  buf.writeUInt16LE(end, 4);
  buf[6] = r; buf[7] = g; buf[8] = b; buf[9] = intensity;
  return dev.sendFeatureReport(buf);
}
await rangeUpdate(0, 107, 255, 0, 0);
```

Per-LED kare için `LampMultiUpdate` (report 4, 51 bayt) kullanılır ama rapor
başına yalnızca 8 lamba taşır. 108 LED = kare başına 14 feature report.
Feature report'lar control transfer üzerinden gittiği için gerçekçi olarak
1–3 ms sürer: 30 FPS'de saniyede 420 rapor, yani saniyenin 0.4–1.3'ü kadar
bus zamanı. **Düz renk için sorunsuz (kare başına 1 rapor), gerçek ambilight
için yetersiz.**

İki uyarı:
- Windows Dynamic Lighting servisi (Ayarlar → Kişiselleştirme → Dinamik
  Aydınlatma) açıkken aynı cihaza o da yazar. Node uygulaması devralacaksa bu
  ayar kapatılmalı, yoksa iki taraf `AutonomousMode`'u karşılıklı değiştirip
  titreme yaratır.
- Firmware'de otonom mod artık şeridi söndürmüyor, kısık gökkuşağı gösteriyor;
  yani "kimse sürmüyor" durumu artık görsel olarak ayırt edilebilir.

**Yol B: CDC seri hızlı yol (ambilight için önerilen)**

Nano R4 çekirdeği TinyUSB kompozit cihaz kurduğu için `Serial` (CDC) ile HID
aynı anda çalışır. Firmware'e küçük bir çerçeve protokolü eklenirse:

```
[0xAB 0xCD][uint16 ledCount][R G B] × ledCount [uint16 CRC16]
```

108 LED = 330 bayt/kare. 30 FPS'de ~10 KB/s — CDC için önemsiz. `serialport`
paketi (v13, Node ≥ 20) bunun için yeterli.

**Öneri:** ikisini birlikte tut. LampArray/HID yolu Windows Dynamic Lighting
uyumluluğunu ve düz renkleri korur; seri yol per-LED efektleri taşır. Bu
protokol henüz firmware'de yok, ayrı bir iş kalemi.

---

## 5. Animasyon motoru

`AnimationManager`'ın Node karşılığı daha basit: tek iş parçacığı olduğu için
C# tarafındaki kilitsiz alan okuma sorunu (`_speed` torn read) kendiliğinden
ortadan kalkar.

```js
const FRAME_MS = 33;
let acc = 0, last = process.hrtime.bigint();

async function tick() {
  const now = process.hrtime.bigint();
  const dt = Number(now - last) / 1e9;
  last = now;
  acc += dt * state.speed;                 // sürüklenmeye dayanıklı

  const color = renderFrame(state.mode, acc, state.baseColor);
  await Promise.allSettled(devices.map((d) => d.setColor(color)));
  broadcast(color);                        // WebSocket ile canlı önizleme
}
setInterval(tick, FRAME_MS);
```

Dikkat edilecekler:
- `setInterval` + `await` iç içe geçerse kareler üst üste biner. Ya
  `setTimeout` ile kendi kendini zincirleyen bir döngü, ya da "önceki kare
  bitmediyse bu kareyi atla" bayrağı kullanılmalı.
- `HIDAsync` kullanılsa bile hidapi yazmaları arka planda iş parçacığı
  havuzunda çalışır; yavaş bir cihaz diğerlerini geciktirmesin diye
  `Promise.allSettled` ile paralel sürülmeli (C# kodunda bunlar sıralı).
- Cihaz başına bir `worker_thread` gerekmez; ancak Corsair'in 1 saniyelik
  keepalive döngüsü aynı kuyruğa girmeli.

---

## 6. Ses tepkimeli mod ve ekran ambilight

Bu iki özellik, geçişin en net kazancı.

**Ses:** Node'da sistem sesi yakalamak zor. `naudiodon` (PortAudio) Windows'ta
WASAPI loopback'i güvenilir biçimde açmaz; "Stereo Mix" veya VB-Cable gibi
sanal aygıtlara bağımlı kalır. Bunun yerine tarayıcıda:

```js
const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true });
const ctx = new AudioContext();
const analyser = ctx.createAnalyser();
ctx.createMediaStreamSource(stream).connect(analyser);
// her karede peak/RMS hesapla, WebSocket ile sunucuya yolla
```

Kullanıcının paylaşım diyaloğunda "sistem sesini paylaş" kutusunu işaretlemesi
gerekir. Yerel bağımlılık sıfır, sonuç NAudio'nun `MasterPeakValue`'suna denk
(hatta frekans bandı ayrımı da mümkün, NAudio'daki tek tepe değerinden daha
iyi).

**Ekran ambilight:** Donanım zaten bir monitör arkası ambilight kurulumu
(firmware 35/19/35/19 kenar dağılımını tanımlıyor) ama mevcut uygulamada ekran
örnekleme özelliği **hiç yok**. Tarayıcıda:

```js
const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
// video → offscreen canvas → kenar şeritlerinin ortalamasını al
```

LED sırası firmware'de şöyle tanımlı, örnekleme bu sıraya uymalı:

| Aralık | Kenar | Yön |
|---|---|---|
| 0–34 | Üst | sol → sağ |
| 35–53 | Sağ | üst → alt |
| 54–88 | Alt | sağ → sol |
| 89–107 | Sol | alt → üst |

Uyarı: Bu iki özellik tarayıcı sekmesi açıkken çalışır. Arka planda sürekli
ambilight isteniyorsa sunucu tarafında headless Chrome ya da yerel bir yakalama
yardımcısı gerekir. **Mimarinin en zayıf noktası budur** ve dürüstçe kabul
edilmeli.

---

## 7. Ne kazanılır, ne kaybedilir

**Kazanılır**
- Aynı ağdaki telefon/tabletten kontrol.
- Visual Studio, MSIX, imzalama, XAML derleyicisi yok; `npm install` + `node`.
- Windows/Linux/macOS aynı kod (node-hid üç platformda da prebuild'li).
- Ekran ambilight ve ses analizi tarayıcı API'leriyle WinUI'dan daha kolay.
- Mevcut C# kodundaki bazı sorunlar yapısal olarak ortadan kalkar: tek iş
  parçacığı sayesinde kilitsiz alan okuma ve aynı HID cihazına iki iş
  parçacığından paralel yazma sorunları oluşmaz.

**Kaybedilir**
- `Windows.Devices.Lights.LampArray` WinRT entegrasyonu. Node'dan WinRT'ye
  köprü kurmak için bakımlı bir paket yok (NodeRT terk edilmiş durumda);
  gerekirse C++/WinRT ile özel bir addon yazmak gerekir. Yol A/B bunu
  gereksiz kılıyor.
- Uygulamanın Windows Dynamic Lighting'e **sağlayıcı** olarak kaydolması
  (`Package.appxmanifest` içindeki `com.microsoft.windows.lighting`
  AppExtension). Bu bugün de gerçek bir kayıp değil: bildirim
  `PublicFolder="Public"` diyor ama pakette öyle bir klasör ve arka plan
  denetleyici implementasyonu yok, yani beyan zaten işlevsiz.
- Mica arka plan, yerel WinUI görünümü, Store dağıtım yolu.
- Windows'un uygulama-başına aydınlatma efektlerini sürmesi.

---

## 8. Riskler ve azaltmalar

| Risk | Etki | Azaltma |
|---|---|---|
| Armoury Crate / iCUE aynı cihaza yazıyor | Titreme, renk çakışması | Bugünkü durumla aynı; ilgili servisleri kapatmayı arayüzde uyarı olarak belirt |
| Windows Dynamic Lighting Arduino'yu sürüyor | `AutonomousMode` savaşı | Ayarı kapat, ya da CDC seri yolu kullan |
| hidapi salt okunur handle'a düşüyor | Yazmalar sessizce başarısız | Açılıştan sonra bir test yazması yapıp sonucu arayüzde göster |
| Feature report per-LED için yavaş | 30 FPS ambilight tutmaz | Düz renk için HID, per-LED için seri yol |
| Tarayıcı kapanınca yakalama durur | Ambilight/ses kesilir | Sekmeyi açık tut; kalıcı çözüm için headless yakalama yardımcısı |
| Native addon dağıtımı | Kurulum zorluğu | N-API v4 prebuild'leri hazır; Node SEA native addon'ı gömemediği için taşınabilir klasör + `.cmd` ya da Electron/Tauri kabuğu |
| Otomatik başlatma | Kullanıcı deneyimi | Görev Zamanlayıcı (oturum açılışında) veya `node-windows` servisi |

---

## 9. Barındırma senaryoları (Hostinger ve benzeri)

Hostinger'ın desteklediği framework listesi (Express, Fastify, Hono, NestJS,
Next.js, Nuxt, SvelteKit, Astro, Nitro, React Router…) bu proje için
kullanılabilir — **ama yalnızca arayüz katmanı için.**

Temel kısıt: RGB donanımı USB ile kullanıcının kendi bilgisayarına bağlı.
`node-hid` işletim sisteminin HID yığınına konuşur; Hostinger'da çalışan bir
Node süreci fiziksel olarak başka bir makinededir ve o cihazları göremez. Yani
**cihaz katmanı her koşulda yerel makinede çalışmak zorunda.** Bu, mimari bir
tercih değil, fiziksel bir sınır.

Bu sınır içinde üç dağıtım biçimi var:

### A. Tamamen yerel (başlangıç için önerilen)

Yerel ajan hem cihazları sürer hem arayüzü servis eder. Tarayıcıdan
`http://localhost:3000`, aynı ağdaki telefondan `http://<pc-ip>:3000`.

- **Backend:** Fastify (doğrulandı: v5 mevcut, Node ≥ 20)
- **Frontend:** SvelteKit + `adapter-static` (build çıktısı Fastify'ın statik
  klasöründen servis edilir) — SvelteKit Hostinger'ın hem frontend hem backend
  listesinde olduğu için aynı seçim B/C senaryolarında da geçerli kalır.
- Hostinger'a ihtiyaç yok. Kurulum ve gizlilik açısından en temiz seçenek.

### B. Arayüz Hostinger'da, cihaz katmanı yerel ajanda — önerilmez

Statik arayüz Hostinger'dan (HTTPS) servis edilir, tarayıcı doğrudan
`ws://localhost:3000` üzerinden yerel ajana bağlanmaya çalışır. İki tarayıcı
kuralı bunu kırılgan yapıyor:

- **Mixed content:** HTTPS sayfadan şifresiz `ws://` bağlantısı tarayıcılar
  tarafından engellenir. Loopback adresleri "potentially trustworthy" sayıldığı
  için bazı tarayıcı sürümlerinde geçer, garantisi yoktur.
- **Private Network Access:** Genel bir kaynaktan (public site) özel ağa /
  localhost'a yapılan isteklere Chrome ek preflight şartı getiriyor.

Yerel ajana sertifika koymak gerekir ki bu, localhost için güvenilir sertifika
üretmek demek — kullanıcıya kurulum yükü bindirir. Bu yolu seçmeyin.

### C. Hostinger'da röle, uzaktan erişim isteniyorsa

Uzaktan (ev ağı dışından) kontrol gerçekten isteniyorsa doğru desen budur:

```
Tarayıcı (herhangi bir yerde)
      │  HTTPS + WSS
      ▼
Hostinger: SvelteKit arayüzü + Fastify/Hono röle sunucusu
      ▲
      │  yerel ajanın DIŞARI doğru açtığı kalıcı WSS bağlantısı
      ▼
Yerel ajan (PC): node-hid + serialport + animasyon motoru
```

Yerel ajan bağlantıyı kendisi dışarıya açtığı için port yönlendirme, güvenlik
duvarı kuralı ve mixed-content sorunu yok.

Dikkat edilmesi gerekenler:

- **Kimlik doğrulama zorunlu.** Röle, internete açık bir yüzeyden bilgisayarına
  bağlı donanımı kontrol ediyor. Ajan başına paylaşılan gizli anahtar, arayüz
  için oturum/şifre. Bu olmadan yayına alınmamalı.
- **WebSocket kalıcılığı.** Hostinger planının uzun ömürlü WebSocket
  bağlantılarına izin verdiğini doğrulaman gerekir; paylaşımlı Node
  çalıştırmalarında idle timeout ile bağlantı düşebilir. Düşerse ajan tarafında
  exponential backoff ile yeniden bağlanma şart. Alternatif olarak komut yönü
  için SSE + kısa POST'lar da yeterli olur (kare akışı röleden geçmiyor).
- **Ekran ambilight ve ses yakalama röleden geçirilmemeli.** Bunlar tarayıcıda
  üretilip 30 FPS'de per-LED kare üretir; internet üzerinden röleye taşımak
  hem gecikme hem bant genişliği açısından anlamsız. Bu iki özellik yalnızca
  arayüz PC'nin kendisinde açıkken, ajana doğrudan (yerel) bağlanarak
  çalışmalı. Röle, düşük frekanslı kontrol komutları için (mod, renk, hız,
  aç/kapat).

### Özet tavsiye

A ile başla; arayüzü SvelteKit ile yaz ve Fastify'dan servis et. Uzaktan
erişim gerçekten gerekiyorsa aynı SvelteKit arayüzünü `adapter-node` ile
Hostinger'a alıp C desenindeki röleyi ekle. Cihaz katmanı hiçbir senaryoda
Hostinger'a taşınamaz.

---

## 10. Aşamalı yol haritası

1. **Kanıt (1–2 gün).** Üç cihazı da `node-hid` ile listele ve her birine düz
   bir renk yaz. Riskin tamamı burada ortaya çıkar: cihaz açılıyor mu, yazma
   başarılı mı, hangi arayüz doğru.
2. **Cihaz katmanı portu.** `aura.js`, `corsair.js`, `lampArrayHid.js` +
   `manager.js`. Kapanışta `disconnectAll` (C# tarafında eksik olan iş) ve
   Corsair için `SetHardwareMode`.
3. **Animasyon motoru + WebSocket API.** Static/Breathing/Rainbow eşdeğerliği,
   `settings.json` aynı şema ile okunup yazılır.
4. **Arayüz.** Renk seçici, mod/hız, cihaz durumu, canlı önizleme.
5. **Yeni özellikler.** Tarayıcıdan ses analizi, ardından ekran ambilight
   (bunun için firmware'e CDC çerçeve protokolü eklenir).
6. **Paketleme.** Taşınabilir klasör + oturum açılışında otomatik başlatma,
   isteğe bağlı tepsi simgesi.

1–3. adımlar mevcut WinUI uygulaması durmaya devam ederken yapılabilir; iki
uygulama aynı `settings.json`'ı paylaşabilir (aynı anda çalışmamaları kaydıyla).

Uzaktan erişim (Hostinger rölesi, bölüm 9/C) 6. adımdan sonra, kimlik
doğrulama tamamlandıktan sonra eklenmeli.
