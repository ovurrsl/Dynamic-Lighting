# AmbiFlux arayüz tasarım brief'i

Bu dosya, uygulamanın **bütün ekranlarını dışarıda tasarlatmak** için yazıldı
(Claude Design ya da başka bir araç). Amacı, tasarımcının koda bakmadan doğru
şeyi çizebilmesi: her ekranda ne var, hangi durumlara giriyor, hangi bileşenle
kuruluyor, ve neye dokunulamaz.

Son güncelleme: 2026-09-14 · HeroUI v3.2.5 · Next.js 16 · Tailwind 4

---

## 0. Hangi araçlar kullanılabilir — dürüst cevap

Bu oturumda etkin olan tasarım becerileri incelendi ve **hiçbiri bu uygulamaya
uymuyor**; bunu sayıp geçmek yerine sebebiyle yazıyorum:

| Beceri | Neden uymuyor |
|---|---|
| `web-artifacts-builder` | claude.ai artifact'leri için, ve **shadcn/ui** öneriyor — "UI kit HeroUI kalacak" kuralıyla doğrudan çelişiyor |
| `theme-factory` | artifact temaları; bizim temamız HeroUI token'ları |
| `canvas-design`, `algorithmic-art` | statik görsel/afiş |
| `brand-guidelines` | Anthropic'in marka kimliği, bizimki değil |

**Kullanılan tek şey `heroui-react` MCP'si** — üreticinin kendi sunucusu, yani
"Next.js/React/Tailwind için üçüncü parti MCP kullanma" kuralına uyuyor. Bu
dosyadaki bileşen listesi ve token'lar oradan, tahminden değil.

Tasarım dışarıda yapılacaksa doğru teslim biçimi **ekran mockup'ı + token
eşlemesi**, kod değil: kod HeroUI'nin compound API'siyle yazılmak zorunda ve
onu burada üretmek daha hızlı.

---

## 1. Ürün tek cümlede

Ekranı gerçek zamanlı örnekleyip monitör arkasındaki LED şeridine basan, açık
kaynak, **kurulum istemeyen** bir ambilight. Motor bir tarayıcı eklentisinde
(ya da sayfanın kendisinde), arayüz bir web paneli, şeridi süren firmware
ESP32-S3'te.

**Kullanıcının üç hali var ve arayüz üçünü de karşılamak zorunda:**

1. **Hiçbir şeyi yok.** Eklenti kurulu değil, kart yok, şerit yok. Panel yine
   de açılıyor ve ona ne yapacağını söylüyor.
2. **Kurulumda.** Şerit masada, kaç LED olduğunu ve nereden başladığını
   anlatmaya çalışıyor. Arayüzün en zor kısmı burası.
3. **Çalışıyor.** Günlerce açıp bakmıyor; açtığında "çalışıyor mu, kaç fps"
   sorusunun cevabını bir bakışta istiyor.

---

## 2. Yapı: kenar çubuğu + tek bölüm

Panel bir **kenar çubuğu** (≥1024 px) ve aynı anda **tek bölüm**. Dar ekranda
kenar çubuğu bir menü düğmesine dönüşüyor ve açıldığında sayfanın parçası
oluyor (üstüne binen bir çekmece değil — focus trap, escape ve scroll kilidi
istemesin diye).

Gezinme **veri**: `lib/sections.ts`. Yeni bir özellik bir tablo satırı ve bir
bileşen. Tasarım bunu varsaymalı: **bölüm sayısı büyüyecek.**

### Bölümler, gruplarıyla

| Grup | Bölüm | Hash | Ne için |
|---|---|---|---|
| **Kontrol** | Genel bakış | `#/overview` | motor ne yapıyor + başlat/durdur |
| | Renk | `#/colour` | ekranı takip eden bir şey yokken sabit renk |
| **Kurulum** | LED donanımı | `#/layout` | geometri, kanal sırası, tel formatı |
| | Yakalama | `#/capture` | ızgara, hız, kırpma |
| | Kalibrasyon | `#/calibration` | test desenleri + kanal sırası sihirbazı |
| **Sistem** | Profiller | `#/profiles` | adlandırılmış düzenekler |
| | Cihaz | `#/device` | sayaçlar + tarayıcı yetenek tablosu |
| **Yardım** | Kılavuz | `#/guide` | kurulum, kablolama, sorun giderme |
| | Yol haritası | `#/roadmap` | ne eksik, ne gelmeyecek |

**Gelecek bölümler** (yol haritasından, tasarımın yer ayırması gerekenler):
Efektler, Ses, Görüntü işleme (renk düzeltme + yumuşatma + kenar modu),
Ağ cihazları, Öncelik katmanları, Olaylar, Çoklu örnek.

Bu **dokuzdan on altıya** demek. Kenar çubuğu buna dayanmalı: gruplar
katlanabilir mi, ikincil bölümler bir "Gelişmiş" altına mı giriyor — tasarımın
cevaplaması gereken ilk soru bu.

### Başlık çubuğu

Her sayfada: bölüm başlığı + tek satır açıklama · dil seçici · tema seçici ·
ana aç/kapa anahtarı. Kenar çubuğunun altında **canlı motor rozeti** (nokta +
durum + fps).

---

## 3. Ekran ekran: içerik ve durumlar

Her ekran için "boş / bekleyen / hatalı / dolu" hallerinin **hepsi** tasarlanmalı.
Bu üründe boş hal istisna değil, ilk deneyimin ta kendisi.

### 3.1 Genel bakış

| | |
|---|---|
| **Veri** | motor durumu (`idle`/`starting`/`running`/`error`), teslim fps, çıkış fps, LED sayısı, bağlantı türü |
| **Eylemler** | Yakalamayı başlat · Durdur · Ekransız sına |
| **Durumlar** | eklenti aranıyor · eklenti yok (→ Kılavuz'a yönlendirme) · boşta · başlıyor · çalışıyor · **yakalama kendiliğinden bitti** (hata değil: çözünürlük/HDR/uyku; tek tıkla yeniden seç) |
| **Ayrıca** | şeridin kablo sırasındaki çizimi (LED 0 beyaz çerçeveli) |

En önemli tasarım kararı: **"yakalama kendiliğinden bitti" bir hata gibi
görünmemeli.** Gerçek masalarda her gün oluyor.

### 3.2 Renk

Renk seçici (ColorPicker + alan + ton kaydırağı + hex) · parlaklık kaydırağı ·
şerit önizlemesi · tele giden değerler (seçilen / sRGB 8-bit / doğrusal 16-bit).

Bu, hiçbir şeyi çalışmayan kullanıcının şeridi ilk kez yakabildiği yer.

### 3.3 LED donanımı — **en zor ekran**

| | |
|---|---|
| **Üst** | canlı önizleme: yakalanan ekran arkada, her LED motorun oradan okuduğu renkle dolu |
| **Kontroller** | Ekranı göster/bırak · Köşeleri düzenle · Köşeleri sıfırla |
| **Yerleşim türü** | Kenar çerçevesi / Matris |
| **Klasik** | üst/sağ/alt/sol LED sayısı · bant derinlikleri · başlangıç köşesi · ofset · saat yönü |
| **Gelişmiş** | bant örtüşmesi · köşe boşluğu · en/boy oranı · eksik bölüm (başlangıç + uzunluk) |
| **Matris** | kolon · satır · kablolama (yılan/paralel) · tarama yönü |
| **Cihaz** | kanal sırası (6 seçenek) · **tel formatı** (Afx/Awa/Ada) |
| **Alt** | Uygula · Varsayılana dön + "Uygula'ya kadar hiçbir şey şeride gitmez" |

Burada **16 ayrı kontrol** var ve hepsi aynı anda görünüyor. Tasarımın asıl
işi bu: neyin her zaman görünmesi, neyin "Gelişmiş" altına girmesi, ve canlı
önizlemenin kontrollerle nasıl birlikte durması gerektiği.

### 3.4 Yakalama

Analiz ızgarası (genişlik/yükseklik + "LED başına kaç hücre" canlı geri
bildirimi) · yakalama hızı · dört kenar kırpma + "ekranın %X'i kalıyor".

Kırpmanın **görsel** bir editörü olmalı — dört kaydırak, kırptığı şeyi
göstermeyen dört sayı demek. Tasarımın en net kazanç fırsatı burada.

### 3.5 Kalibrasyon

Test desenleri (Yürüyüş · Gri rampa · Tam beyaz · Flaş · Kapat) + her birinin
ne kanıtladığı · kanal sırası sihirbazı (2 soru → 6 cevaptan biri → uygula).

Sihirbaz bir **adım akışı**: başlat → "kırmızı gönderdik, ne gördün?" →
"yeşil gönderdik, ne gördün?" → sonuç + uygula. Çelişkili cevabın kendi hali
var.

### 3.6 Profiller

Ad girişi + kaydet · profil listesi (ad + yerleşim özeti + kanal sırası ·
Yükle/Sil) · dosyaya aktar/al · boş hal.

### 3.7 Cihaz

Dört sayaç grubu + aşama kırılımı (küçültme/geri okuma/çözme/örnekleme) +
**tarayıcı yetenek tablosu** (10 satır, var/yok, her birinin ne demek olduğu).

Bu sayfa bir **teşhis** sayfası: "şunun fotoğrafını gönder" destek
konuşmasının ilk adımı. Yoğun bilgi kabul edilebilir; okunamaz olması değil.

### 3.8 Kılavuz

5 numaralı adım + kablolama + 5 maddelik sorun giderme + iki kaçınılmaz kısıt.
Uzun metin: tipografi ekranı.

### 3.9 Yol haritası

10 madde, üç durum rozeti (sıradaki / planlı / **gelmeyecek**).

---

## 4. HeroUI: ne kullanılıyor, ne kullanılmıyor

HeroUI v3.2.5'te **71 bileşen** var. Panel şu an **14** tanesini kullanıyor.
Aradaki fark, tasarımın somut malzemesi.

**Kullanılanlar:** Button · Card · ColorArea · ColorField · ColorPicker ·
ColorSlider · ColorSwatch · ColorSwatchPicker · Input · Label · ListBox ·
NumberField · Select · Slider · Surface · Switch · TextField · Toast

**Kullanılmayan ama bu ürüne doğrudan uyanlar — tasarım borcu:**

| Bileşen | Şu an elle yapılan | Nerede |
|---|---|---|
| **Alert** | `Surface` içinde düz metin bildirim | her ekranın uygula/hata mesajı |
| **Table** | `Surface` + grid + `font-mono` | Cihaz sayfasının sayaçları |
| **Chip** / **Badge** | elle `rounded-full border px-2` | yol haritası durumları, yetenek var/yok |
| **Meter** / **ProgressBar** | yok | fps, güç bütçesi, ızgara doluluğu |
| **Tabs** | yok | LED donanımındaki klasik/matris ayrımı |
| **Disclosure** | `Switch` ile "Gelişmiş" | gelişmiş yerleşim ayarları |
| **Description** / **ErrorMessage** | `<p className="text-xs text-muted">` | her alanın altındaki açıklama |
| **Form** / **Fieldset** | düz `div` | Yakalama ve LED donanımı sayfaları |
| **Tooltip** | yok | kısa açıklamalar uzun paragraf olmasın diye |
| **Separator** | `border-default/30` | kenar çubuğu, kart içi ayrımlar |
| **Skeleton** | `null` döndürme | eklenti yoklanırken |
| **Typography** | elle `text-*` sınıfları | kılavuz ve yol haritası |
| **Drawer** / **Modal** | elle inline menü | dar ekran menüsü (bilinçli tercih; yeniden değerlendirilebilir) |

**Tasarımın çıktısı bu tabloyu kapatmalı.** Elle yapılan her şey, kit'in
erişilebilirlik ve tema desteğini kaçırıyor demek.

---

## 5. Token'lar — renk elle yazılmayacak

HeroUI'nin kendi CSS değişkenleri (üretici MCP'sinden alındı). Tasarım bunlarla
konuşmalı, hex ile değil.

**Zemin ve yüzey:** `--background` · `--foreground` · `--surface` ·
`--surface-secondary` · `--surface-tertiary` · `--overlay` · `--muted`

**Durum:** `--accent` (mavi, oklch 0.6204 0.195 253.83) · `--success` ·
`--warning` · `--danger` — her birinin `-foreground` eşi var

**Form:** `--field-background` · `--field-border` · `--field-placeholder` ·
`--field-radius` (= `--radius` × 1.5)

**Çizgi:** `--border` · `--separator` · `--focus` (= accent) · `--ring-offset-width`

**Ölçü:** `--radius` 0.5rem · `--spacing` 0.25rem · `--disabled-opacity` 0.5

Tema üç durumlu: **sistemi izle** (varsayılan) · açık · koyu. Her ekran
ikisinde de tasarlanmalı, ve koyu varsayılan sayılmamalı — bu panel gündüz de
açılıyor.

---

## 6. Dokunulamazlar

Tasarımın uyması gereken, tartışmaya kapalı kısıtlar:

1. **UI kit HeroUI v3.** Başka kit, başka ikon kütüphanesi yok. İkonlar şu an
   tek karakterlik glif (`◉ ◆ ▦ ▣ ◈ ▤ ⚡ ⓘ ↗`) — yirmi küçük resim için sonsuza
   kadar güncellenecek bir bağımlılık istemiyoruz. Tasarım ikon seti öneriyorsa
   gerekçesiyle önermeli.

2. **12 dil ve Türkçe birinci.** Metin uzunluğu sabit değil: Almanca %30 daha
   uzun, Japonca çok daha kısa. **Sabit genişlikli düğme ve tek satıra sığması
   varsayılan etiket olmaz.** Kırpma yerine sarma.

3. **Üç tema durumu**, ve seçim ilk boyamadan önce uygulanıyor.

4. **400 px genişlikte çalışmalı.** Yatay kaydırma yok. Tablolar, diyagramlar
   ve kod blokları kendi `overflow-x: auto` kabında.

5. **Sahte veri yok.** Eklenti yoksa "bağlandı" gösterilmez; sayaç yoksa sıfır
   uydurulmaz. Bu ürünün tek gerçek güven kaynağı sayıların doğru olması.

6. **Erişilebilirlik pazarlık dışı.** HeroUI React Aria üstünde; klavyeyle
   sürüklenebilen keystone köşeleri gibi elle yazılan her etkileşim, klavye
   yolunu da taşımak zorunda.

7. **Uygula'ya kadar hiçbir şey şeride gitmez.** Yerleşim ve yakalama
   sayfalarında yarısı yazılmış bir değer motora ulaşmamalı. Tasarım bu ayrımı
   görünür kılmalı (kirli taslak hali).

---

## 7. Tasarımdan istenen, öncelik sırasıyla

1. **Kenar çubuğu 16 bölüme ölçeklensin.** Gruplar, katlanma, aktif hal.
2. **LED donanımı ekranı yeniden düzenlensin.** 16 kontrol + canlı önizleme.
3. **Kırpma için görsel editör.** Dört kaydırak yerine ekranın üstünde tutamak.
4. **Boş ve hata halleri.** Özellikle "eklenti yok" ve "yakalama bitti".
5. **Cihaz sayfası okunabilir olsun.** Yoğun ama okunur.
6. **§4'teki tasarım borcu kapansın.** Elle yapılanlar kit bileşenlerine.
7. **Kılavuz ve yol haritası için tipografi ölçeği.**

Mockup'lar geldiğinde uygulama HeroUI'nin compound API'siyle bu depoda
yazılacak; `components/` altındaki her kart bugün zaten bağımsız, yani ekran
ekran değiştirilebilir.
