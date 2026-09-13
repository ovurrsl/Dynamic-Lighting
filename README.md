# AmbiFlux

Ekranı takip eden ambilight — **tarayıcıda çalışan**, kurulum istemeyen,
açık kaynak bir Hyperion.NG alternatifi.

Hyperion bir bilgisayara (çoğunlukla bir Raspberry Pi'ye) kurulur. AmbiFlux
kurulmaz: motor bir Chrome eklentisinin offscreen dokümanında koşuyor, arayüz
bir web sayfası, ve şeridi süren firmware ESP32-S3 üzerinde seri protokol
konuşuyor. Yol haritası [hyperion.ng](https://github.com/hyperion-project/hyperion.ng);
aradaki farkın dökümü `docs/hyperion-gap-analysis.md`'de.

## Depo yapısı

Depo kökü **tek bir Next.js uygulaması.** Workspace yok, alt paket yok.

| Yol | Ne | Durum |
|---|---|---|
| `app/` | Route handler'lar (API) + kontrol paneli sayfası | **çalışıyor** |
| `lib/api/` | Kalan iki uç nokta (`/healthz`, `/v1/version`) | **çalışıyor** |
| `lib/engine/` | Motor: yerleşim, örnekleme, kenar, düzeltme, yumuşatma, dither, protokol, seri yazıcı — saf TypeScript, tarayıcı API'si yok | **çalışıyor**, testli |
| `lib/extension/` | Panel ile eklentinin ortak mesaj sözleşmesi | **çalışıyor** |
| `extension/` | Chrome eklentisi (MV3): yakalama + hat + seri port, offscreen document'ta | **derleniyor**, gerçek ekranda henüz ölçülmedi |
| `components/` | HeroUI v3 ekranları, kullanım kılavuzu dahil | **çalışıyor** |
| `lib/i18n/` | 12 dil; Türkçe ve İngilizce tam, diğerleri ortak çekirdek + İngilizce yedek | **çalışıyor**, testli |
| `lib/theme.ts` | Tarayıcı temasını izleyen, kullanıcının ezebildiği açık/koyu | **çalışıyor**, testli |
| `firmware/` | ESP32-S3 firmware'i, PlatformIO; algoritmalar host'ta test ediliyor | **derleniyor**, kartta ölçülmedi |
| `test/` | Panel ve motor testleri; ağ, veritabanı ya da tarayıcı gerektirmez | **çalışıyor** |
| `docs/hyperion-port-plan.md` | Hyperion.NG'den ne, nasıl, neden aktarılıyor | plan |
| `docs/hyperion-gap-analysis.md` | Hyperion'un özellik envanteri ve bizdeki karşılıkları | analiz |
| `docs/extension-handoff.md` | Eklentiyi devralacak için tam brifing: mimari, protokol, ölçülenler, ve §12'de sıradaki işin tamamı | devir |
| `AmbiFluxNanoR4LampArray/` | Eski HID LampArray firmware'i | ESP32-S3'e yeniden yazılacak |

WinUI 3 masaüstü uygulaması **silindi** — Windows Dynamic Lighting kapsamdan
çıktı. Git geçmişinde duruyor (`fa622c5` ve öncesi).

## Dil ve tema

Arayüz **tamamen Türkçe** ve varsayılan dil Türkçe. İlk açılışta tarayıcının
dilinden (`navigator.languages`) en yakını seçiliyor, sonra kullanıcının seçimi
`localStorage`'a yazılıyor. On iki dil listeleniyor — Türkçe, İngilizce,
Almanca, Çince (Basitleştirilmiş), İspanyolca, Fransızca, Rusça, Portekizce
(Brezilya), İtalyanca, Lehçe, Felemenkçe, Japonca — ve seçicide her birinin
**yüzde kaçının çevrildiği yazıyor**: bir dili sunup İngilizce göstermek,
baştan ne kadarının hazır olduğunu söylemekten kötü. Çevrilmemiş bir anahtar
İngilizce'ye düşüyor, anahtar adı asla görünmüyor.

Tema üç durumlu: **sistemi izle** (varsayılan), açık, koyu. "Sistemi izle" ayrı
bir seçim — sabah aydınlanan bir masaüstünde panel de aydınlanıyor. Seçim ilk
boyamadan önce `app/layout.tsx`'teki küçük satır içi betikle uygulanıyor, yani
yanlış renkte bir kare yanıp sönmüyor.

## Yığın

**Next.js 16 · React 19 · HeroUI v3 · Tailwind 4**

Sunucu tarafı bilinçli olarak neredeyse yok: geriye `/healthz` ve `/v1/version`
kaldı. Uygulamanın tamamı tarayıcıda çalışıyor, hiçbir şey bir hesaba ya da bir
veritabanına bağlı değil, ve ekran görüntüsü hiçbir yere gönderilmiyor.

**Vite yok.** Frontend'i Next derliyor (Next 16 kendi içinde Turbopack
kullanıyor), Tailwind'i de `@tailwindcss/vite` değil `@tailwindcss/postcss`
derliyor. Bu, Hostinger'ın `ERROR: No output directory found after build`
hatasının da çözümü: Vite çıktısı bir workspace içindeki `web/dist`'e düşüyordu,
Next ise kökte `.next/` üretiyor — host'un framework algılaması tam olarak bunu
arıyor.

### Mimarideki tek alışılmadık karar

HTTP mantığı `lib/api/`'de, route dosyalarında değil. `app/**/route.ts`
dosyalarının her biri üç satırlık bir adaptör: URL'i, runtime'ı ve method
eşlemesini tanımlıyor, sonra `lib/api`'yi çağırıyor.

Sebebi pratik: `lib/api` yalın web `Request`/`Response` kullanıyor, `next/server`
import etmiyor. Böylece **API testlerinin tamamı derleme olmadan, sunucu açmadan, port
kullanmadan** handler'ları doğrudan çağırıyor. Yan fayda: framework bir daha
değişirse mantık yerinde kalıyor.

## Hızlı başlangıç

```bash
npm install
npm test          # ağ, veritabanı ya da build gerekmez
npm run typecheck
npm run dev       # http://localhost:3000
npm run build
```

Yapılandırılacak ortam değişkeni yok. Panel açılır açılmaz çalışıyor; kaydettiği
her şey tarayıcının kendi deposunda.

## Motor: tarayıcı eklentisi

Ekranı takip eden kısım barındırılan sayfada değil, bir Chrome eklentisinde
çalışıyor. Sebebi tek monitör: sekme arka plana düşünce Chromium render'ı
durduruyor, oysa eklentinin **offscreen document**'ı hiç render edilmiyor,
dolayısıyla hiç kısıtlanmıyor. Ölçümü ve alternatiflerin neden kaybettiği
`docs/hyperion-port-plan.md` §2'de.

```bash
npm run typecheck:extension   # DOM + chrome + Web Serial tipleriyle
npm run build:extension       # esbuild → extension/dist
npm run pack:extension        # derler + extension/ambiflux-extension.zip üretir
```

Sonra Chrome'da `chrome://extensions` → **Geliştirici modu** → **Paketlenmemiş
öğe yükle** → `extension/dist`. Manifest'teki `key` sayesinde eklenti kimliği
her makinede aynıdır (`data/extension.ts`), panel onu bu kimlikle bulur.

> **`extension/dist` depoda**, bilinçli olarak: yüklenecek şey o, ve depoda
> olmaması araç zinciri kurmadan çalışan bir uzantı indirmeyi imkânsız
> kılıyordu. Depoyu klonla (ya da ZIP olarak indir) ve `extension/dist`
> klasörünü yükle. Kaynağa dokunduysan önce `npm run build:extension`, sonra
> commit — çıktı depoda olduğu için güncel tutulması gerekiyor.
>
> Doğrudan `extension/` klasörünü seçersen Chrome **"Could not load background
> script 'sw.js'"** der: orada yalnız TypeScript kaynağı var. Klasör `dist`
> olmalı. Başka birine tek dosya olarak göndermek için `npm run pack:extension`.

Kullanım, eklenti simgesinden:

1. **Seri portu eşleştir** — Web Serial izni bir kullanıcı hareketi ister; bu
   yüzden popup'tan verilir, motor portu `getPorts()` ile devralır.
2. **Yakalamayı başlat** — ekran seçici de aynı sebeple popup'ta. Seçim Chrome
   oturumu boyunca geçerlidir; kalıcı yapılamaz, bu bir tarayıcı sınırıdır.

Port eşleşmemişse motor **cihazsız (loopback) modda** çalışır: kareler
üretilir, firmware'in kullanacağı referans ayrıştırıcıdan geçirilir ve sayılır.
Yani hat, kart gelmeden bugün ölçülebilir. Paneldeki **Cihaz** kartı eklentiden
saniyede bir okur: teslim edilen FPS, varış p50/p99, dört ayrı düşme sayacı.

İki kısıt tarayıcıdan geliyor ve mühendislikle çözülmüyor: ekran seçimi oturum
başına bir kez sorulur, ve DRM korumalı içerik (Netflix, Prime, Disney+) siyah
yakalanır.

Motorun saf kısımları (`lib/engine/`) tarayıcı API'si kullanmaz ve `node --test`
ile koşar; eklenti onları esbuild ile paketler. Hangi Hyperion.NG algoritmasının
nasıl ve hangi kusuru dışarıda bırakılarak aktarıldığı her modülün başındadır.

## API

Neredeyse yok, ve bu bilinçli. Uygulamanın tamamı tarayıcıda çalışıyor.

| Uç nokta | Ne yapar |
|---|---|
| `GET /healthz` | Canlılık |
| `GET /v1/version` | Dağıtılmış sürüm; eklenti kendi derlemesiyle karşılaştırıyor |
| `* /v1/*` (eşleşmeyen) | JSON 404 — API istemcisi HTML hata sayfası almamalı |

Hesap yok, oturum yok, veritabanı yok. Profiller `localStorage`'da duruyor ve
makineler arasında bir **dosyayla** taşınıyor.

## Dağıtım

Bkz. [`docs/deploy.md`](docs/deploy.md).
