# AmbiFlux firmware — Arduino Nano ESP32 (ESP32-S3)

Konuştuğu tek şey seri port. Windows Dynamic Lighting / HID LampArray desteği
yok ve olmayacak — eski sketch (`AmbiFluxNanoR4LampArray/`) onu yapıyordu ve
bu onun yerine geçiyor.

```bash
pio run -e nano_esp32            # derle
pio run -e nano_esp32 -t upload  # yükle
pio device monitor -b 921600     # telemetri
```

Tasarımın gerekçeleri `../docs/hyperion-port-plan.md`'de. Kısaca:

- **Yerleşim firmware'de değil.** `AMBIFLUX_MAX_LEDS` bir derleme tavanı;
  gerçek LED sayısı kareyle birlikte geliyor. Firmware "üst kenar"ın ne
  olduğunu hiç bilmiyor.
- **WiFi ve BT derlemeden çıkarıldı.** ESP32'de RMT/I2S LED bozulmasının en
  yaygın sebebi core 0'daki WiFi ISR'leri.
- **Kare hızı `esp_timer` ile.** FreeRTOS tick'i 1000 Hz olduğu için yalnız tam
  milisaniye ifade edebiliyor; 120 Hz = 8.333 ms, yani 8 ms (125 Hz) ya da
  9 ms (111 Hz) ve aralarında duyulur bir vuruş deseni.
