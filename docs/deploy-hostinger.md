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

`npm run build` şu an frontend olmadığı için `--if-present` sayesinde
**başarıyla no-op**. UI kiti seçilip `web/` eklendiğinde `build:web` scripti
tanımlanır ve aynı komut onu derler — build ayarlarını bir daha değiştirmen
gerekmez.

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

Hostinger'ın MySQL'ini oluştur, bilgilerini `DB_*` değişkenlerine yaz. Şema
ilk açılışta otomatik kuruluyor (`CREATE TABLE IF NOT EXISTS`), ayrı bir
migration adımı yok.

İlk lisansı elle ekle:

```sql
INSERT INTO licences (licence_key, tier, max_seats, status, features)
VALUES ('AF-XXXX-XXXX-XXXX', 'pro', 3, 'active', '["ambilight","hdr","presets"]');
```

Ödeme sağlayıcısı (Lemon Squeezy / Paddle) bağlandığında bu satırı webhook
oluşturacak.

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
npm test          # 23 test, ağ ve veritabanı gerektirmez
npm run dev       # geçici anahtar üretir ve uyarır, bellek içi depolama kullanır
```
