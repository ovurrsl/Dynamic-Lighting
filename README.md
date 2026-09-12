# AmbiFlux

Monitör arkası ekran-takipli ambilight. 108 LED'lik şerit, ESP32-S3 üzerinde
seri protokol konuşan firmware, Windows'ta ekranı yakalayıp per-LED kare üreten
yerel motor, ve barındırılan bir kontrol düzlemi.

## Depo yapısı

| Dizin | Ne | Durum |
|---|---|---|
| `server/` | Fastify kontrol düzlemi: lisans, profiller, güncelleme manifest'i | **çalışıyor** |
| `web/` | Kontrol paneli: Vite 8 + React 19 + HeroUI v3 + Tailwind 4 | **iskelet çalışıyor** |
| `docs/` | Mimari ve dağıtım notları | |
| `AmbiFluxNanoR4LampArray/` | Eski HID LampArray firmware'i (Nano R4) | değiştirilecek |

WinUI 3 masaüstü uygulaması (`Dynamic Lighting/`, `Dynamic Lighting (Package)/`,
`Dynamic Lighting.slnx`) **silindi.** Windows Dynamic Lighting desteği kapsamdan
çıktı ve o ağaçtaki hiçbir şey yeni mimariye girmiyor; git geçmişinde duruyor
(`fa622c5` ve öncesi). Yerine ne geleceği: ekranı yakalayıp seri porta yazan
tarayıcı eklentisi.

Kökteki `package.json` Hostinger'ın dağıttığı uygulamayı tanımlıyor ve `web`'i
bir npm workspace olarak içeriyor. Fastify API'yi ve derlenmiş frontend'i aynı
süreçten servis ediyor, yani Hostinger'ın kuracağı ve derleyeceği tek bir şey var.

Backend Fastify. Host süreci boşta durdurup sonraki istekte yeniden
başlattığı için kullanıcının hissettiği tek gecikme soğuk başlatma; bu yığında
ölçülen **~265 ms**. Yalnız uykudan sonraki ilk isteği etkiliyor. Ayrıntı ve
korunan optimizasyonlar `docs/deploy-hostinger.md`'de.

## Hızlı başlangıç

```bash
npm install
npm test              # 27 test; ağ ya da veritabanı gerekmez
npm run build         # web/ -> web/dist, Fastify onu servis eder
npm run dev           # API, http://localhost:3000
npm run dev:web       # arayüz, Vite dev sunucusu (API'ye proxy'ler)
```

`npm run dev` kalıcı imza anahtarı olmadan çalışır: geçici bir anahtar üretip
yüksek sesle uyarır, ve bellek içi depolamayı bir geliştirme lisansıyla
(`AF-DEV-0000-0000`) tohumlar. Üretimde ikisi de reddedilir.

```bash
curl -X POST localhost:3000/v1/licence/activate \
  -H 'content-type: application/json' \
  -d '{"licenceKey":"AF-DEV-0000-0000","fingerprint":"fingerprint-demo12345678"}'
```

## API

| Uç nokta | Ne yapar |
|---|---|
| `GET /healthz` | Canlılık. Veritabanına **dokunmaz** — soğuk başlatma pingi olarak kullanılır |
| `GET /readyz` | Hazırlık. Veritabanını kontrol eder |
| `GET /v1/version` | Sürüm + lisans **açık anahtarı** (istemci çevrimdışı doğrulama için alır) |
| `POST /v1/licence/activate` | Lisans anahtarı + makine parmak izi → imzalı token |
| `POST /v1/licence/refresh` | Token yenileme. Süresi geçmiş token'ı **kabul eder** |
| `GET/PUT/DELETE /v1/presets[/:id]` | Monitör profilleri. Token'ın kendisi kimlik bilgisi |
| `GET /v1/updates/manifest` | Yerel motor ve firmware sürüm bilgisi |

### Lisans tasarımının iki kasıtlı kararı

**Token'lar çevrimdışı doğrulanıyor.** Ed25519 imzalı, istemci gömülü açık
anahtarla kendi başına doğruluyor. Sunucu yalnızca sıradaki token'ı üretmek
için gerekiyor — bu, motorun **fail-open** olmasını mümkün kılan şey: yenileme
gecikirse çalışmaya devam ediyor.

**Yetkiler imzanın içinde.** `features` dizisi imzalanan payload'da; istemci
haklarını yerel bir boolean'dan değil doğrulanmış veriden okuyor. Böylece lisans
kontrolünü yamalamak premium özellikleri **kapalı** bırakıyor, açık değil.

Dürüst olmak gerekirse: bu korsan kullanımı **engellemiyor**. Yerelde çalışan
bir ikili her zaman yamalanabilir. Barındırmanın gerçekten kazandırdığı şeyler
iptal edebilme, merkezi güncelleme ve sunucuda kalan kodun korunması.

## Dağıtım

Bkz. [`docs/deploy-hostinger.md`](docs/deploy-hostinger.md).

## Lisans

Apache-2.0, bkz. `LICENSE.txt`.
