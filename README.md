# AmbiFlux

Monitör arkası, ekranı takip eden ambilight. 108 LED'lik WS2812B şerit, ESP32-S3
üzerinde seri protokol konuşan firmware, ekranı yakalayıp per-LED kare üreten
tarayıcı eklentisi, ve barındırılan bir kontrol düzlemi.

## Depo yapısı

Depo kökü **tek bir Next.js uygulaması.** Workspace yok, alt paket yok.

| Yol | Ne | Durum |
|---|---|---|
| `app/` | Route handler'lar (API) + kontrol paneli sayfası | **çalışıyor** |
| `lib/` | Lisans kriptosu, doğrulama, depolama, hız sınırı | **çalışıyor** |
| `lib/api/` | HTTP mantığı, framework'ten bağımsız | **çalışıyor** |
| `lib/engine/` | Motor: yerleşim, örnekleme, kenar, düzeltme, yumuşatma, dither, protokol, seri yazıcı — saf TypeScript, tarayıcı API'si yok | **çalışıyor**, testli |
| `lib/extension/` | Panel ile eklentinin ortak mesaj sözleşmesi | **çalışıyor** |
| `extension/` | Chrome eklentisi (MV3): yakalama + hat + seri port, offscreen document'ta | **derleniyor**, gerçek ekranda henüz ölçülmedi |
| `components/` | HeroUI v3 ekranları | **çalışıyor** |
| `supabase/migrations/` | Şema SQL'i, tek doğru kaynak | **çalışıyor** |
| `test/` | 334 test, ağ ve veritabanı gerektirmez | **çalışıyor** |
| `docs/hyperion-port-plan.md` | Hyperion.NG'den ne, nasıl, neden aktarılıyor | plan |
| `docs/extension-handoff.md` | Eklentiyi devralacak için tam brifing: mimari, protokol, ölçülenler, açık hata | devir |
| `AmbiFluxNanoR4LampArray/` | Eski HID LampArray firmware'i | ESP32-S3'e yeniden yazılacak |

WinUI 3 masaüstü uygulaması **silindi** — Windows Dynamic Lighting kapsamdan
çıktı. Git geçmişinde duruyor (`fa622c5` ve öncesi).

## Yığın

**Next.js 16 · React 19 · HeroUI v3 · Tailwind 4 · Zod · Supabase (Postgres)**

Neden Next.js: aynı kod **hem Vercel'de hem Hostinger'da** çalışıyor. Önceki
Fastify + Vite kurulumu yalnız uzun ömürlü bir Node sürecinde çalışabiliyordu,
yani Vercel'e geçmek yeniden yazım olurdu.

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
npm test          # 334 test; ağ, veritabanı ya da build gerekmez
npm run typecheck
npm run dev       # http://localhost:3000
npm run build
```

`npm run dev` kalıcı imza anahtarı olmadan çalışır: geçici bir anahtar üretip
yüksek sesle uyarır ve bellek içi depolamayı bir geliştirme lisansıyla
(`AF-DEV-0000-0000`) tohumlar. Üretimde ikisi de reddedilir.

```bash
curl -X POST localhost:3000/v1/licence/activate \
  -H 'content-type: application/json' \
  -d '{"licenceKey":"AF-DEV-0000-0000","fingerprint":"fingerprint-demo12345678"}'
```

> **Tuzak:** `next start` kendisi `NODE_ENV=production` set ediyor, yani
> derlenmiş bir build'i `STORAGE=memory` ile çalıştıramazsın — config bunu
> bilerek reddediyor. Bellek içi depolama `npm run dev` içindir.

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

> **`extension/dist` depoda yok** — derleme çıktısı, `.gitignore`'da. Yeni bir
> klonda önce `npm install && npm run build:extension` çalıştırmak gerekiyor;
> aksi halde yüklenecek bir şey olmaz. Doğrudan `extension/` klasörünü
> seçersen Chrome **"Could not load background script 'sw.js'"** der — orada
> yalnız TypeScript kaynağı var, derlenmiş `sw.js` `dist/` içinde. Başka birine
> göndermek için `npm run pack:extension`: kaynak haritası içermeyen, açılıp
> doğrudan yüklenebilen bir zip üretir.

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

| Uç nokta | Ne yapar |
|---|---|
| `GET /healthz` | Canlılık. Veritabanına **dokunmaz** — en ucuz ısıtma pingi |
| `GET /readyz` | Hazırlık. Veritabanını *ve* yapılandırmayı kontrol eder |
| `GET /v1/version` | Sürüm + lisans **açık anahtarı** |
| `POST /v1/licence/activate` | Lisans anahtarı + makine parmak izi → imzalı token |
| `POST /v1/licence/refresh` | Token yenileme. Süresi geçmiş token'ı **kabul eder** |
| `GET/PUT/DELETE /v1/presets[/:id]` | Monitör profilleri. Token'ın kendisi kimlik bilgisi |
| `GET /v1/updates/manifest` | Motor ve firmware sürüm bilgisi |
| `* /v1/*` (eşleşmeyen) | JSON 404 — API istemcisi HTML hata sayfası almamalı |

### Lisans tasarımının iki kasıtlı kararı

**Token'lar çevrimdışı doğrulanıyor.** Ed25519 imzalı; istemci gömülü açık
anahtarla kendi başına doğruluyor. Sunucu yalnızca sıradaki token'ı üretmek için
gerekiyor — motorun **fail-open** olmasını mümkün kılan şey bu.

**Yetkiler imzanın içinde.** `features` dizisi imzalanan payload'da; istemci
haklarını yerel bir boolean'dan değil doğrulanmış veriden okuyor. Böylece lisans
kontrolünü yamalamak premium özellikleri **kapalı** bırakıyor, açık değil.

Dürüst olmak gerekirse: bu korsan kullanımı **engellemiyor.** Yerelde çalışan bir
ikili her zaman yamalanabilir. Barındırmanın kazandırdığı şeyler iptal edebilme,
merkezi güncelleme ve sunucuda kalan kodun korunması.

## Veritabanı

Supabase (Postgres 17), `eu-central-1`. Şema `supabase/migrations/` altında.

**Row Level Security açık ve politikası yok.** Bu isteğe bağlı değil: Supabase
`public` şemasındaki her tabloyu anon anahtarıyla PostgREST üzerinden yayınlıyor
ve anon anahtarı tasarımı gereği herkese açık. RLS kapalıyken o anahtarı tutan
herkes `select * from licences` çekip bugüne kadar ürettiğimiz **tüm lisans
anahtarlarını** alabilirdi. API servis rolüyle bağlandığı için RLS'i atlıyor;
anon anahtarı sızarsa hiçbir şey okuyamıyor. İki yönden de doğrulandı.

`npm run migrate` şema **oluşturmuyor**, şemayı **doğruluyor** — PostgREST DDL
çalıştıramıyor, o yüzden şema değişiklikleri migration dosyalarına ait. Script'in
yaptığı iş asıl faydalı olan yarısı: işaret ettiğin veritabanının kodun beklediği
şemaya sahip olup olmadığını söylüyor ve olmadığında sıfırdan farklı çıkıyor.

## Dağıtım

Bkz. [`docs/deploy.md`](docs/deploy.md).

## Lisans

Apache-2.0, bkz. `LICENSE.txt`.
