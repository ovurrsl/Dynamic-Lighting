# AmbiFlux firmware — Arduino Nano ESP32 (ESP32-S3)

Konuştuğu tek şey seri port. Windows Dynamic Lighting / HID LampArray desteği
yok ve olmayacak — eski sketch (`AmbiFluxNanoR4LampArray/`) onu yapıyordu ve
bu onun yerine geçiyor.

```bash
pio test -e native               # 37 test, karta gerek yok
pio run -e nano_esp32            # derle
pio run -e nano_esp32 -t upload  # yükle
pio device monitor -b 921600     # telemetri
```

Derleme doğrulandı: **RAM %19.1 (62 740 / 327 680), Flash %12.2
(384 586 / 3 145 728)**. Davranış doğrulanmadı — burada kart yok.

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
| `afx_protocol.h` | Ada/Awa/Afx/AxC ayrıştırıcı, Fletcher, resync | 13 |
| `afx_render.h` | interpolasyon, sigma-delta dither, güç sınırlayıcı | 17 |
| `afx_idle.h` | host var/yok, çapraz geçişler, boşta gökkuşağı | 7 |
| `afx_patterns.h` | tezgâh koşumu: yürüyüş, kanallar, rampa, beyaz, flaş | 8 |

`src/main.cpp` — yalnız kablolama. Test edilemediği için mümkün olduğunca
karar içermiyor.

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
