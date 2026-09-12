# Dağıtım

Depo kökü tek bir Next.js uygulaması, ve aynı kod iki hedefte de çalışıyor.
**Birincil hedef Vercel.**

## Vercel (birincil)

Git entegrasyonu ile bağlanıyor, yani **her push otomatik deploy.** `master`'a
giden push üretime, diğer dallar preview deployment'a gidiyor.

| Ayar | Değer |
|---|---|
| Framework preset | Next.js (otomatik algılanıyor) |
| Install command | `npm install` (varsayılan) |
| Build command | `next build` (varsayılan) |
| Output | `.next` (varsayılan) |
| Root directory | `/` |

Hiçbirini elle ayarlamak gerekmiyor — `next.config.ts` kasten minimal, tam da bu
yüzden.

### Ortam değişkenleri

Project → Settings → Environment Variables:

```
LICENCE_SIGNING_KEY=<npm run keygen çıktısındaki özel anahtar>
SUPABASE_URL=https://qiyaoirwggsegfmjajmi.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<Supabase → Settings → API → service_role>
```

`NODE_ENV`'i Vercel veriyor. `PORT` serverless'te anlamsız.

**`NEXT_PUBLIC_` ön eki kullanma.** Next o ön eke sahip her şeyi tarayıcı
paketine gömüyor; `LICENCE_SIGNING_KEY` lisans üretebilen bir özel anahtar.
`lib/config.ts` bu hatayı yakalayıp açılışı reddediyor, ama en baştan yapmamak
daha iyi.

### Ticari kullanım: Hobby planı yetmiyor

Vercel'in kendi [fair use](https://vercel.com/docs/limits/fair-use-guidelines)
sayfasından, birebir:

> **Hobby teams** are restricted to non-commercial personal use only. All
> commercial usage of the platform requires either a Pro or Enterprise plan.

Tanım geniş — *"Advertising the sale of a product or service"* bile ticari
sayılıyor. AmbiFlux'ın indirme/satış sayfası bunu yapıyor, yani **Pro gerekiyor.**
Bu teknik bir kısıt değil, sözleşme kısıtı; ihlal edilirse hesap askıya alınıyor.

### Soğuk başlatma

Vercel'de statik panel CDN'den geliyor, yani arka uç uykuda olsa bile arayüz
anında açılıyor. Fonksiyon soğuk başlatması yalnız API çağrısını etkiliyor.

Bu, Hostinger'a göre gerçek bir iyileşme: orada tüm Node süreci uyanana kadar
HTML dahil tek bayt çıkmıyor.

## Hostinger (alternatif)

Next.js Hostinger'ın desteklediği listede, hem frontend hem backend tarafında.

| Alan | Değer |
|---|---|
| Root directory | `/` |
| Node version | 22 |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Start command | `npm start` |

Ortam değişkenleri Vercel ile aynı.

**Daha önce burada patlamıştı ve sebebi yapısaldı.** Fastify + Vite kurulumunda
build şu hatayla düşüyordu:

```
ERROR: No output directory found after build
```

Vite çıktısı bir npm workspace'inin içindeki `web/dist`'e iniyordu; host'un
framework algılaması ise kökte bir çıktı dizini arıyor ve bulamıyordu. Next kökte
`.next/` üretiyor. Bu yüzden depo tek bir kök seviye Next projesi, workspace
değil — tercih değil, gereklilik.

Bilinmesi gereken üç Hostinger davranışı:

1. **Süreç boşta durduruluyor.** Bu yüzden mimaride kalıcı bağlantı yok; tüm uç
   noktalar istek/yanıt. `NODE_ENV=production` ile `STORAGE=memory` birlikte
   verilirse uygulama açılmayı **reddediyor** — kasıtlı koruma, çünkü süreç
   durduğunda tüm aktivasyonlar ve profiller silinirdi.
2. **TLS önde sonlanıyor.** İstemci adresi yalnız `x-forwarded-for` ile geliyor;
   `lib/http.ts` bunu okuyor. Olmadan hız sınırlayıcı herkesi tek istemci sanar.
3. **Ücretsiz SSL var ve gerekli.** Tarayıcı tarafındaki Web Serial ve
   `getDisplayMedia` **secure context** şart koşuyor.

## Veritabanı kurulumu

Şema `supabase/migrations/` altında ve tek doğru kaynak orası.

```bash
supabase db push          # ya da dosyaları SQL editörüne yapıştır
npm run migrate           # oluşturmaz, DOĞRULAR
```

`npm run migrate` üç şeyi kontrol ediyor: tablolar okunabiliyor mu,
`record_activation` fonksiyonu var mı (bilinmeyen bir lisansı reddederek
kanıtlıyor), ve `SUPABASE_ANON_KEY` verilmişse **anon anahtarının gerçekten
hiçbir şey okuyamadığı.** Sorun varsa sıfırdan farklı çıkıyor.

İlk lisansı ekle:

```sql
insert into licences (licence_key, tier, max_seats, status, features)
values ('AF-XXXX-XXXX-XXXX', 'pro', 3, 'active', '["ambilight","hdr","presets"]'::jsonb);
```

Ödeme sağlayıcısı (Lemon Squeezy / Paddle) bağlandığında bu satırı webhook
oluşturacak.

### Neden MySQL değil Postgres

Karar kapasiteyle ilgili değil — iş yükü günde birkaç lisans çağrısı, ikisi de
fazlasıyla yeter. Belirleyici olan **serverless'ten erişilebilirlik:**

- Serverless fonksiyon çağrılar arasında bağlantı havuzu tutamıyor. Her çağrı
  kendi bağlantısını açardı, ve paylaşımlı barındırmada tavan dar: Hostinger'ın
  yayınladığı limitlere göre MySQL **kullanıcı başına 25-200 eşzamanlı bağlantı**
  (plana göre; giriş paketlerinde 25), global tavan 500. Bir trafik dalgası bunu
  tüketir.
- Uzaktan MySQL erişimi paylaşımlı barındırmada genelde kaynak adres kısıtına
  bağlı, Vercel'in çıkış adresleri ise sabit değil. Bunu kendi panelinde
  doğrulaman gerekir — ama üstteki havuz sorunu tek başına yeterli sebep.

Supabase HTTP üzerinden konuşuyor. Yanlış yapılacak bir havuz yok, yani **aynı
kod** uzun ömürlü bir `next start` sürecinde de, istek başına bir fonksiyonda da
değişmeden çalışıyor. `lib/storage/supabase.ts` istemciyi tembel yüklüyor, tıpkı
`mysql2`'nin yüklendiği gibi — `/healthz` sürücüye hiç dokunmuyor.

## Doğrulama

```bash
curl https://<alan-adın>/healthz            # veritabanına dokunmaz
curl https://<alan-adın>/readyz             # veritabanını ve yapılandırmayı kontrol eder
curl https://<alan-adın>/v1/version         # lisans açık anahtarını döner
curl https://<alan-adın>/v1/nope            # JSON 404 dönmeli, HTML değil
```

`/readyz` üç farklı şey söyleyebiliyor ve ayrımı önemli:

| Yanıt | Anlamı |
|---|---|
| `{"status":"ok"}` | Her şey yerinde |
| `{"status":"misconfigured","problems":[...]}` | Ortam değişkeni eksik/yanlış — hangisi olduğunu söylüyor |
| `{"status":"degraded"}` | Yapılandırma doğru, veritabanına ulaşılamıyor |

Bu ayrım Fastify'dan gelen bir şeyin yerini alıyor: orada yanlış yapılandırılmış
uygulama açılmayı reddediyordu ve operatör bunu açılış log'unda görüyordu.
Serverless'te açılış anı yok, yani bu olmadan eksik bir ortam değişkeninin tek
belirtisi okunacak hiçbir şey olmayan 500'ler olurdu.

Ölçülen davranış: geçerli yapılandırma ama erişilemez veritabanı ile uygulama
açılıyor, `/` paneli sunuyor, `/healthz` ve `/v1/version` 200 dönüyor, `/readyz`
`degraded` bildiriyor. Yanlış yapılandırılmış bir veritabanı siteyi düşürmüyor.
