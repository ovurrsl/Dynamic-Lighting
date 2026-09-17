# Dağıtım

Depo kökü tek bir Next.js uygulaması. Yapılandırılacak ortam değişkeni,
bağlanacak veritabanı ve saklanacak gizli anahtar **yok** — uygulamanın tamamı
tarayıcıda çalışıyor, sunucu yalnızca statik sayfayı ve iki küçük uç noktayı
veriyor. (Lisans, aktivasyon, Supabase ve `/readyz` PR #6 ile söküldü; bu
dosyanın eski sürümü onları anlatıyordu ve yanlıştı.)

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
| Ortam değişkeni | hiç |

Hiçbirini elle ayarlamak gerekmiyor — `next.config.ts` kasten minimal. İçindeki
tek şey güvenlik başlıkları: `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
`nosniff`, `strict-origin-when-cross-origin` ve kamera/konum/ödeme için
`Permissions-Policy`. Script CSP yok (Next'in inline runtime'ı nonce ister, bu
ayrı bir iş) ve HSTS yok (Vercel kendi alan adlarında zaten ekliyor; özel bir
alan adında düşünülmeli).

### Eklentinin origin listesi

Eklenti, paneli yalnız `extension/manifest.json`'daki `externally_connectable`
origin'lerinden dinler. Panel başka bir alan adına taşınırsa o liste de değişmeli
ve eklenti yeniden paketlenmeli; aksi halde panel eklentiyi "kurulu değil"
görür. Yerelde geliştirmek için `http://localhost:3000/*` listede.

### Ticari kullanım: Hobby planı yetmiyor

Vercel'in kendi [fair use](https://vercel.com/docs/limits/fair-use-guidelines)
sayfasından, birebir:

> **Hobby teams** are restricted to non-commercial personal use only. All
> commercial usage of the platform requires either a Pro or Enterprise plan.

Tanım geniş — *"Advertising the sale of a product or service"* bile ticari
sayılıyor. Uygulama artık açık kaynak ve satış sayfası yok; yine de bir gün
donanım kiti satılırsa bu satır geçerli olur. Teknik bir kısıt değil, sözleşme
kısıtı; ihlal edilirse hesap askıya alınıyor.

### Soğuk başlatma

Statik panel CDN'den geliyor; uç noktalar da statik cevap veriyor ve hiçbir
şeye bağlanmıyor, yani soğuk başlatmanın kullanıcıya görünen bir maliyeti yok.

## Kendi makinende (Safari / Firefox / iOS için de)

```bash
npm ci
npm run build
npm start          # http://localhost:3000
```

Sayfa host'u (motorun eklentisiz, sayfanın içinde çalışan hâli) ekranı yalnız
güvenli bir bağlamda yakalayabiliyor: HTTPS ya da `localhost`. Localhost'ta
çalıştırılan panel yerel ağdaki bir karta `ws://` ile doğrudan ulaşır; HTTPS'te
barındırılan panel ise karta yalnız `wss://` ile (ağındaki, kartın arkasında
durduğu bir TLS köprüsü) ulaşır — bu tarayıcının karışık içerik kuralı.
Ayrıntı: `docs/firmware-and-devices.md` §4 ve paneldeki Cihaz sayfası.

## Doğrulama

```bash
curl https://<alan-adın>/healthz            # {"status":"ok"}
curl https://<alan-adın>/v1/version         # {"name":"ambiflux","version":"…"}
curl https://<alan-adın>/v1/nope            # JSON 404 dönmeli, HTML değil
curl -I https://<alan-adın>/                # güvenlik başlıkları
```

Yerelde tek komut: `npm run verify` — typecheck (panel + eklenti), testler,
`next build` ve `extension/dist`'in kaynakla eşleştiği kontrolü.
