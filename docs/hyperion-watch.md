# Hyperion.NG takibi

AmbiFlux'ın yol haritası Hyperion.NG. Yol haritası duran bir hedef değil: biz
port ederken onlar da geliştiriyor. Bu dosya, onların yaptığı her değişikliğin
bizde ne olduğuna dair **karar defteri**.

## Nasıl işliyor

```bash
npm run hyperion:watch        # son incelenen commit'ten beri ne değişti
npm run hyperion:watch -- --mark   # işareti şu anki master'a ilerlet
```

`scripts/hyperion-watch.mjs`, hyperion.ng'i blobsuz klonlayıp
(`--filter=blob:none`: tüm geçmiş, hiç dosya içeriği yok) işaretten beri gelen
commit'leri **değiştirdikleri yollara göre** bizim modüllerimize eşliyor. Son
incelenen commit `docs/hyperion-watch.json`'da.

`.github/workflows/hyperion-watch.yml` bunu haftada bir pazartesi çalıştırıp
**tek bir issue**'yu güncelliyor — her hafta yeni issue değil; aynı özetin on
iki bayat kopyası bir takipçinin okunmayı bırakma şekli.

### Betik neden karar vermiyor

Yola göre sınıflamak mekanik ve güvenilir. "Bu değişiklik port edilmeli mi"
sorusu değil — cevabı bizim mimarimize, tarayıcı sınırlarına ve önceliklere
bağlı. Tahmin eden bir betik, kimsenin güvenmediği bir liste üretir. O yüzden
betik yalnızca **ne değişti ve nerede** diyor; karar buraya elle yazılıyor.

### Neyin dışarıda bırakıldığı

Derleme sistemi, paketleme, CI, doküman ve **onların çeviri dosyaları**.
Sonuncusu bilinçli: bizim `lib/i18n`'imiz Hyperion'un string setini paylaşmıyor,
dolayısıyla POEditor trafiği bize hiçbir şey söylemiyor — ve deponun tek en
büyük commit kaynağı o. İçeride bırakıldığında her özette en büyük başlık
"Çeviriler" oluyordu ve gerçek özellik çalışması oraya düşüyordu, çünkü büyük
bir commit string'lere de dokunuyor.

## Karar defteri

Sütunlar: yukarı akıştaki değişiklik · bizdeki karşılığı · karar · gerekçe.

Kararlar dört tane: **port** (alacağız), **var** (bizde zaten karşılığı var),
**kapsam dışı** (tarayıcıda imkânsız ya da ürün kapsamı değil), **sonra**
(alacağız ama yol haritasında sırası var).

### 2026-09-13 — başlangıç noktası

İşaret [`c9f12db`](https://github.com/hyperion-project/hyperion.ng/commit/c9f12db503bbe461eaa599a4dae309700dfe0119).
Bu noktaya kadarki envanterin tamamı `docs/hyperion-gap-analysis.md`'de; burada
tekrarlanmıyor. Özeti:

| Alan | Hyperion | Bizde | Karar |
|---|---|---|---|
| Piksel hattı (örnekleme, kenar, düzeltme, yumuşatma, dither) | var | **var** | var — doğrusal ışıkta çalıştığımız için bazı yerlerde daha doğru |
| Seri protokol (Adalight/AWA + Fletcher) | var | **var** | var |
| Efekt motoru (41 efekt, CPython gömülü) | var | yok | sonra — yol haritası 1, CPython'suz |
| Ağ LED cihazları (18 sürücü) | var | yok | sonra — yol haritası 3 (WLED); ham UDP olanlar kapsam dışı |
| HID / FTDI LED cihazları | var | yok | sonra — `navigator.hid`/`usb` ile mümkün, ölçüldü |
| SPI LED cihazları | var | yok | kapsam dışı — tarayıcıda SPI yok |
| Sese duyarlı çalışma | yok | yok | sonra — yol haritası 4 |
| Öncelik katmanları | var | **var** | var |
| Olaylar (suspend/resume vb.) | var | yok | sonra — yol haritası 7 |
| Çoklu örnek (instance) | var | yok | sonra — yol haritası 8 |
| Güç/akım sınırlama | **yok** | var (firmware) | bizde fazladan |
| Asimetrik attack/release | **yok** | var | bizde fazladan |
| HDR tone mapping (ekran yakalamada) | **yok** | planlı | bizde fazladan olacak |

Sonraki özet ilk pazartesi çalıştığında bu başlığın altına yeni bir tarih
bölümü eklenecek.
