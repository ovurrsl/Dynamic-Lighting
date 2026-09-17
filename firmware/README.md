# AmbiFlux firmware — Arduino Nano ESP32 (ESP32-S3)

Konuştuğu tek şey seri port. Windows Dynamic Lighting / HID LampArray desteği
yok ve olmayacak — eski sketch (`AmbiFluxNanoR4LampArray/`) onu yapıyordu ve
bu onun yerine geçiyor.

```bash
pio test -e native               # 76 test, karta gerek yok
pio run -e nano_esp32            # derle
pio run -e nano_esp32 -t upload  # yükle
pio device monitor -b 921600     # telemetri
```

Derleme doğrulandı (2026-09-17, üç env de `-Wall -Wformat=2 -Werror=format`
ile): `nano_esp32` **RAM %26.0 (85 332 / 327 680), Flash %30.0
(944 046 / 3 145 728)**; `nano_esp32_net` RAM %28.0, Flash %31.1. Davranış
doğrulanmadı — burada kart yok.

> **Derleme tuzağı.** `esptool` güncel `click` ile kırılıyor:
> `TypeError: ParamType.get_metavar() missing 1 required positional argument`.
> Çözüm `pip install rich_click "click<8.2"`. Kodla ilgisi yok, ama hata
> mesajı bunu hiç söylemiyor ve bootloader adımında çıktığı için sanki
> firmware derlenmemiş gibi görünüyor.

## Ne nerede

`lib/afx/` — algoritmaların tamamı, header-only, Arduino bağımlılığı yok.
Host'ta koşuyor, o yüzden test ediliyor:

| Dosya | Ne | Test |
|---|---|---|
| `afx_protocol.h` | Ada/Awa/Afx/AxC ayrıştırıcı, Fletcher, resync | 15 |
| `afx_render.h` | interpolasyon, sigma-delta dither, güç sınırlayıcı | 20 |
| `afx_idle.h` | host var/yok, çapraz geçişler, boşta gökkuşağı | 8 |
| `afx_patterns.h` | tezgâh koşumu: yürüyüş, kanallar, rampa, beyaz, flaş | 8 |
| `afx_config.h` | cihaz yapılandırması: TLV ayrıştırma, doğrulama, NVS blob'u | 11 |
| `afx_net.h` | ağ yapılandırması: SSID/parola TLV'leri, doğrulama, NVS blob'u | 10 |
| `afx_buffer.h` | seri/ağ görevi ile çıkış görevi arasındaki kilitsiz üçlü tampon | 4 |

`src/main.cpp` — yalnız kablolama. Test edilemediği için mümkün olduğunca
karar içermiyor. Kalan kararlar orada yazılı ve gerekçeli: yapılandırma
değişikliği çıkış görevinin kare başında **yerinde** uygulanıyor (sınırlayıcı
ve boşta durumu bayrakla devralınıyor, başka bir görevden yeniden kurulmuyor);
ağ değişikliği ana döngüde uygulanıyor (soketin kendi işleyicisinden
`httpd_stop` çağırmak sonsuza kadar beklerdi); `AxC` cevabı hem seri porta hem
soket istemcisine (metin çerçevesi) gidiyor.

Denetimde bulunup düzeltilen ve artık testte olan üç aritmetik hata: dither'ın
`0xFF01…0xFFFF` girişinde baytı 0/1'e sararak tam beyazı siyaha kırpması,
`glide`'ın tam aralıklı geçişin ikinci yarısında 32 bit taşması, ve telemetri
`printf`'inin bir eksik belirteci (`-Werror=format` bunu artık derlemede
reddediyor).

Tasarımın gerekçeleri `../docs/hyperion-port-plan.md`'de. Kısaca:

- **Yerleşim firmware'de değil.** `AMBIFLUX_MAX_LEDS` bir derleme tavanı;
  gerçek LED sayısı kareyle birlikte geliyor. Firmware "üst kenar"ın ne
  olduğunu hiç bilmiyor.
- **WiFi ve BT derlemeden çıkarıldı.** ESP32'de RMT/I2S LED bozulmasının en
  yaygın sebebi core 0'daki WiFi ISR'leri.
- **Kare hızı `esp_timer` ile.** FreeRTOS tick'i 1000 Hz olduğu için yalnız tam
  milisaniye ifade edebiliyor; 120 Hz = 8.333 ms, yani 8 ms (125 Hz) ya da
  9 ms (111 Hz) ve aralarında duyulur bir vuruş deseni.
- **Üçlü tampon, kilitsiz, `noInterrupts()` yok.** Seri görevin yazacağı,
  çıkış görevinin okumadığı bir tampon her zaman var; host çıkışı geçerse
  bayat kareyi kendiliğinden düşürüyor, yırtmıyor.
- **LED görevi core 1'de yalnız.** ESP32'de RMT/I2S bozulmasının klasik
  sebebi aynı çekirdeğe düşen başka iş.

## Yapılandırma — `AxC` kontrol kanalı

Kart tek bir monitöre çivili değil. LED sayısı, güç bütçesi, boşta parlaklığı ve
açılışta tezgâh koşumu çalışıp çalışmayacağı çalışma zamanında ayarlanıyor ve
NVS'te saklanıyor. **Yerleşim burada değil ve hiç olmayacak**: kenar sayıları,
bant derinlikleri, yön ve ofset host'ta. Firmware'in "üst kenar"ın ne olduğunu
bilmesi gerekmiyor, ve bildiği an bir sonraki müşterinin monitörüne uymuyor.

`AxC` karesinin gövdesi TLV: `[tip][uzunluk][değer…]`, big-endian.

| Tip | Uzunluk | Ne |
|---|---|---|
| `0x01` | 0 | Sürüm sor |
| `0x02` | 0 | Tezgâh koşumunu çalıştır |
| `0x03` | 2 | LED sayısı (1…512) |
| `0x04` | 2 | Güç bütçesi, mA (100…20000) |
| `0x05` | 1 | Boşta parlaklığı (0…255) |
| `0x06` | 1 | Açılışta tezgâh koşumu (0/1) |
| `0x07` | 0 | Yapılandırmayı sor |
| `0x08` | 0 | NVS'e kaydet |
| `0x09` | 0 | Varsayılanlara dön ve kaydet |
| `0x0a` | 0…32 | WiFi ağ adı (yalnız ağ derlemesi) |
| `0x0b` | 0 veya 8…63 | WiFi parolası (yalnız ağ derlemesi) |
| `0x0c` | 1 | Telsizi aç/kapat (0/1) |
| `0x0d` | 0 | Ağ durumunu sor |

İki kural test edilmiş durumda ve ikisi de bilinçli:

- **Bilinmeyen tip atlanıyor, reddedilmiyor.** Yeni bir host eski bir kartla
  çalışmaya devam ediyor: duymadığı bir alanı gönderiyor ve mesajın geri kalanı
  yine de iniyor.
- **Bilinen tipin bozuk değeri REDDEDİLİYOR, kırpılmıyor.** 5000 LED'i sessizce
  512'ye kırpmak host ile kartı şerit konusunda anlaşmazlıkta bırakır ve hiçbir
  şey bunu söylemez.

NVS'ten okunan blob da tel üzerinden gelenle **aynı doğrulamadan** geçiyor:
sürüm baytı, checksum ve aralık kontrolü. Farklı bir derlemeyle yazılmış bir
blob reddediliyor ve varsayılanlar ayakta kalıyor — yarısı anlaşılmış bir
yapılandırma, hiç yapılandırma olmamasından kötü, çünkü uzunluğunda kimsenin
anlaşmadığı bir şeridi yakıyor.

## Ağ derlemesi — `pio run -e nano_esp32_net`

Ayrı bir env, çalışma zamanı anahtarı değil, ve bunun sebebi fiziksel: USB
derlemesi WiFi yığınını bilerek linklemiyor, çünkü ESP32'de RMT/I2S bozulmasının
en yaygın sebebi LED'in çekirdeğine düşen WiFi kesme işi. Kabloyla sürülen bir
kartın hiç kullanmayacağı bir telsizin bedelini ödemesi için sebep yok.

Neden var olduğu bir tercih değil, bir platform gerçeği: iOS'ta Web Serial,
WebUSB, WebHID ve Web Bluetooth'un dördü de yok — dördü de yalnız Chromium'da ve
Apple WebKit şartı koyuyor. Bir iPhone ekranını yakalayabiliyor; şeride
ulaşmanın orada kalan tek yolu ağ.

- Uç nokta: `ws://<adres>/afx`. Panel bu yolu kendisi ekliyor
  (`afxUrl`, `lib/engine/net.ts`).
- **Taşınan baytlar seri portunkiyle birebir aynı.** Soket handler'ı karenin ne
  olduğunu bilmiyor: aldığı baytları kablonun beslediği `FrameParser`'ın
  ikizine itiyor ve çıkan kare aynı `publish`'e gidiyor. İkinci protokol yok,
  ikinci ayrıştırıcı yok, ikinci test kümesi yok — Fletcher trailer'ı, resync
  kuralı ve magic dağıtımı bir kez kapsanıyor.
- Ayrıştırıcı **ayrı bir örnek**: akış ayrıştırıcısı tek bir akışın durum
  makinesi, iki kaynaktan beslemek ikisini birden desenkronize ederdi.
- **Tek soket, en yeni bağlantı kazanır** (`max_open_sockets = 1`, LRU
  temizleme açık). Tek şerit ve tek ayrıştırıcı var; iki istemci aynı
  ayrıştırıcıya bayt itseydi kareleri iç içe geçerdi. Yeniden bağlanan panel
  bayat bağlantıyı düşürür, ondan reddedilmez; her el sıkışmada ayrıştırıcı
  sıfırlanır. Bir kareden büyük WebSocket çerçevesi bağlantıyı kapatır (okumadan
  bırakmak sonraki alımı çöpten başlatıyordu).
- Üçlü tamponun yazarı ağ derlemesinde bir mutex'le korunuyor. Kilitsiz tampon
  tek yazarlı olduğu için doğru; ikinci bir kaynak onu yırtardı.
- Sunucu IDF'in kendi `esp_http_server`'ı. Üçüncü parti bir kütüphane değil —
  derlemenin tekrarlanabilir olması gereken bir üründe bedava gelmeyen bir şey —
  ve görevi **core 0'a sabitleniyor**, core 1 LED'lerin kalsın diye.
- Kimlik bilgileri panelden, kablo üzerinden `AxC` ile giriliyor (Cihaz
  sayfası). Kart SSID'yi ve adresini bildiriyor, **parolayı asla**: telemetri
  satırına düşen bir kimlik bilgisi panelin ya da bir destek biletinin tuttuğu
  her loga düşer.

Ölçülmemiş: WiFi linklenmişken `shortFrames` yükseliyor mu (N2). Sayacı zaten
var; karta yakıp bir saat soak etmek cevabı veriyor.

## Tezgâh koşumu — kartı yakınca ilk yapılacak şey

Açılışta, herhangi bir host konuşmadan önce şerit beş deseni sırayla gösteriyor.
Gökkuşağından çok daha iyi bir on beş saniye: yalnız "kart canlı" demiyor,
kabloyu doğruluyor. Bilgisayara takmak dışında hiçbir şey gerekmiyor.

| Desen | Ne kanıtlıyor |
|---|---|
| **Yürüyüş** (tek LED, 0→n-1) | İndeks sırası ve **fiziksel köşe indeksleri**. Işık yanlış yerde köşe dönüyorsa kenar sayıları yanlış ve bunu aşağıda hiçbir şey düzeltemez. |
| **Kanallar** (düz kırmızı, yeşil, mavi) | Kanal sırası. Kırmızı denince yeşil yanıyorsa şerit GRB; tahmin etmeden öğrenmenin tek yolu. |
| **Rampa** (21 adım gri) | Ezilmiş alt uç, monoton olmayan eğri, çalışmayan dither. Başka hiçbir yerde görünmüyorlar. |
| **Beyaz** (tam) | Güç sınırlayıcının devreye girdiği, gözle. 108 LED'de ~6.5 A. |
| **Flaş** (1 Hz tüm şerit) | 240 fps telefon kamerasıyla uçtan uca gecikme ölçümünün deseni (E10). |

Desenler dither'dan ve interpolasyondan geçmiyor: bunlar bir ölçüm, ve
yumuşatılmış bir ölçüm yumuşatıcıyı ölçer.

Bir host konuşmaya başladığı an tezgâh koşumu biter. Tekrar çalıştırmak için
`AxC` kontrol karesi, TLV tipi `0x02`.

## Kartta ölçülecekler

Buradan yapılamayanlar: RMT vs I2S jitter'ı (E1), bir saatlik 120 Hz soak —
sıfır checksum hatası, sıfır resync, sıfır reset (E2), seviye çevirici vs
çıplak 3.3 V hata oranı (E3), ve uçtan uca gecikme (E10). Telemetri satırı
bunların hepsini saniyede bir raporluyor.
