# Hostinger dağıtımı

Depo, Hostinger'ın **tek seferde okuyup derleyeceği** şekilde kurulmuş: kökteki
`package.json` dağıtılabilir uygulamayı tanımlıyor, Fastify hem JSON API'yi hem
(derlendiğinde) frontend'i aynı süreçten servis ediyor. Firmware ve yerel motor
alt dizinlerde duruyor ve Hostinger'ın derlemesine hiç karışmıyor.

## Build ayarları

Hostinger panelinde → uygulaman → Build settings:

| Alan | Değer |
|---|---|
| Root directory | `/` (depo kökü) |
| Node version | 22 |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Start command | `npm start` |

`npm ci` kökte çalışır ve `web` workspace'ini de kurar; `npm run build` onu
`web/dist`'e derler ve Fastify aynı süreçten servis eder. Tek kurulum, tek build,
tek başlatma komutu — build ayarlarını bir daha değiştirmen gerekmiyor.

Frontend yığını: **Vite 8 + React 19 + HeroUI v3 + Tailwind 4**. HeroUI'nin
kendi CSS'i derlenmiş değil kaynak (`@apply`, `@utility`, `@custom-variant`
kullanıyor), o yüzden Tailwind'i PostCSS değil **`@tailwindcss/vite` eklentisi**
ile çalıştırmak zorunlu. Bir tuzak: Vite 8 esbuild'den Oxc'ye geçti, yani
`build.minify: 'esbuild'` istemek esbuild'i ayrı bağımlılık olarak gerektiriyor
ve hiçbir fayda vermiyor — varsayılanı kullan.

## Ortam değişkenleri

`.env.example` tam listeyi ve her birinin neden gerektiğini içeriyor. Asgari
üretim seti:

```
NODE_ENV=production
LICENCE_SIGNING_KEY=<npm run keygen çıktısı>
DB_HOST=...
DB_USER=...
DB_PASSWORD=...
DB_NAME=...
```

`PORT`'u Hostinger veriyor, sen ayarlamıyorsun.

İmza anahtarını üret:

```bash
npm run keygen
```

Özel anahtarı Hostinger'ın ortam değişkenlerine koy, **asla commit'leme**.
Çıktıdaki açık anahtar gizli değil — yerel motora gömülecek ve ayrıca
`/v1/version` uç noktasından da yayınlanıyor.

## Veritabanı

Hostinger'ın MySQL'ini oluştur, bilgilerini `DB_*` değişkenlerine yaz. Sonra
şemayı **bir kez** kur:

```bash
npm run migrate
```

Bu, `CREATE TABLE IF NOT EXISTS` çalıştırıyor, yani tekrar çalıştırmak zararsız.
Şema değişince tekrar çalıştır.

**Neden boot'ta değil:** şema kurulumu eskiden açılışta çalışıyordu. Ölçtüm — bu,
her soğuk başlatmanın MySQL sürücüsünü yüklemesi (**78 ms**) ve hiçbir şey
sunmadan önce üç veritabanı gidiş-dönüşü harcaması demekti; veritabanına hiç
dokunmayan bir istek için bile. Süreci boşta durduran bir hostta bu bedel sürekli
ödeniyordu. Şimdi soğuk başlatma veritabanına hiç bağlanmıyor.

İlk lisansı elle ekle:

```sql
INSERT INTO licences (licence_key, tier, max_seats, status, features)
VALUES ('AF-XXXX-XXXX-XXXX', 'pro', 3, 'active', '["ambilight","hdr","presets"]');
```

Ödeme sağlayıcısı (Lemon Squeezy / Paddle) bağlandığında bu satırı webhook
oluşturacak.

## Soğuk başlatma: bilinen bedel

Hostinger süreci boşta durdurup sonraki istekte yeniden başlattığı için
**kullanıcının hissettiği tek gecikme soğuk başlatma.** Saniyede istek sayısı bu
üründe hiç bağlayıcı değil (günde birkaç lisans yenilemesi).

Backend **Fastify** — proje kararı. Bu makinede ölçülen açılış süreleri, karar
görünür kalsın diye kayıtta:

| Yığın | Soğuk başlatma |
|---|---|
| Çıplak `node:http` (taban) | ~75 ms |
| Hono + elle doğrulama | ~105 ms |
| **Fastify + AJV + rate-limit** (kullanılan) | **~265 ms** |

Yani uygulama uyuduktan sonraki ilk isteğe ~190 ms ekleniyor. Sonraki istekler
etkilenmiyor. Bunun karşılığında Fastify'ın olgun eklenti ekosistemi, yerleşik
AJV şema doğrulaması ve pino günlüklemesi geliyor — hepsi kutudan.

Framework'ten bağımsız olan ve **korunan** optimizasyonlar:

- **Şema kurulumu boot'ta değil** → `npm run migrate`. Eskiden açılışta
  çalışıyordu, yani her soğuk başlatma MySQL sürücüsünü yüklüyor (**78 ms**) ve
  veritabanına dokunmayan istekler için bile üç DDL gidiş-dönüşü harcıyordu.
- **`node:module` derleme önbelleği açık** — bu yığında ~35 ms değerinde.
- **`mysql2` tembel yükleniyor** — `/healthz`, `/v1/version` ve statik dosyalar
  sürücüye hiç dokunmuyor. `/healthz` bu yüzden en ucuz ısıtma pingi.

## Bilmen gereken üç Hostinger davranışı

**1. Süreç boşta durduruluyor.** Hostinger'ın dokümanından: *"After a period
without incoming traffic, your app's process is stopped automatically."*
Sonuçları:

- **Kalıcı WebSocket tutamazsın.** Bu yüzden mimaride röle yok; tüm uç noktalar
  istek/yanıt. Uzaktan kontrol istenirse VPS gerekir, bu ürün değil.
- **Boştan sonraki ilk istek soğuk başlatma bekler** (saniyeler sürebilir).
  Yerel motor bu yüzden açılışını lisans çağrısına bağlamıyor ve `/healthz`
  veritabanına hiç dokunmuyor — en ucuz ısıtma pingi o.
- **Bellek içi durum kaybolur.** `NODE_ENV=production` ile `STORAGE=memory`
  birlikte verilirse uygulama **açılmayı reddediyor**; bu kasıtlı bir koruma.

**2. TLS önde sonlanıyor.** İstemci adresi yalnızca `X-Forwarded-For` ile
geliyor, o yüzden `TRUST_PROXY=true` varsayılan. Bu olmadan hız sınırlayıcı
herkesi tek istemci sanar ve hiçbir şeyi korumaz.

**3. Ücretsiz SSL var ve gerekli.** Tarayıcı tarafındaki Web Serial ve
`getDisplayMedia` **secure context** şart koşuyor, yani HTTPS olmadan
kurulumsuz istemci hiç çalışmaz.

## Doğrulama

Dağıtımdan sonra:

```bash
curl https://<alan-adın>/healthz
curl https://<alan-adın>/readyz          # veritabanını da kontrol eder
curl https://<alan-adın>/v1/version      # lisans açık anahtarını döner
```

`/readyz` 503 dönüyorsa veritabanı bağlantısı yanlış; `/healthz` yine 200
döner, çünkü bilinçli olarak veritabanına dokunmuyor.

Yerel olarak aynı şeyi çalıştırmak için:

```bash
npm install
npm test          # 27 test, ağ ve veritabanı gerektirmez
npm run dev       # geçici anahtar üretir ve uyarır, bellek içi depolama kullanır
```
