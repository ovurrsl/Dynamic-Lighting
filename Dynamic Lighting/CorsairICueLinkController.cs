using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using HidLibrary;

namespace Dynamic_Lighting
{
    public class CorsairICueLinkEndpoint
    {
        public byte Type { get; set; }
        public byte Model { get; set; }
        public string DisplayName { get; set; } = string.Empty;
        public int LedChannels { get; set; }
        public bool Internal { get; set; }
        public byte[] EndpointId { get; set; } = Array.Empty<byte>();
    }

    public class CorsairICueLinkController
    {
        private const int CORSAIR_VID = 0x1B1C;
        private const int CORSAIR_ICUE_LINK_SYSTEM_HUB_PID = 0x0C3F;

        private HidDevice? _device;
        private List<CorsairICueLinkEndpoint> _endpoints = new List<CorsairICueLinkEndpoint>();

        public bool IsConnected => _device != null && _device.IsOpen;
        public IReadOnlyList<CorsairICueLinkEndpoint> Endpoints => _endpoints.AsReadOnly();

        private byte[] _colorBuffer = new byte[0];
        private CancellationTokenSource? _keepAliveCts;
        private DateTime _lastCommitTime = DateTime.MinValue;
        private readonly object _usbLock = new object();
        private byte[]? _lastSentColorBuffer;

        // Cihaz veri listesi (Önceki başarılı versiyondan korunmuştur)
        private static readonly List<CorsairICueLinkEndpoint> KnownDevices = new List<CorsairICueLinkEndpoint>
        {
            new CorsairICueLinkEndpoint { Type = 0x05, Model = 0x02, DisplayName = "iCUE LINK 5000T RGB", LedChannels = 160 },
            new CorsairICueLinkEndpoint { Type = 0x05, Model = 0x01, DisplayName = "iCUE LINK 9000D RGB AIRFLOW", LedChannels = 22 },
            new CorsairICueLinkEndpoint { Type = 0x06, Model = 0x00, DisplayName = "iCUE LINK COOLER PUMP LCD", LedChannels = 24 },
            new CorsairICueLinkEndpoint { Type = 0x11, Model = 0x00, DisplayName = "iCUE LINK TITAN 240", LedChannels = 20 },
            new CorsairICueLinkEndpoint { Type = 0x11, Model = 0x04, DisplayName = "iCUE LINK TITAN 240", LedChannels = 20 },
            new CorsairICueLinkEndpoint { Type = 0x07, Model = 0x00, DisplayName = "iCUE LINK H100i RGB", LedChannels = 20 },
            new CorsairICueLinkEndpoint { Type = 0x07, Model = 0x04, DisplayName = "iCUE LINK H100i RGB", LedChannels = 20 },
            new CorsairICueLinkEndpoint { Type = 0x11, Model = 0x01, DisplayName = "iCUE LINK TITAN 280", LedChannels = 20 },
            new CorsairICueLinkEndpoint { Type = 0x07, Model = 0x01, DisplayName = "iCUE LINK H115i RGB", LedChannels = 20 },
            new CorsairICueLinkEndpoint { Type = 0x11, Model = 0x02, DisplayName = "iCUE LINK TITAN 360", LedChannels = 20 },
            new CorsairICueLinkEndpoint { Type = 0x11, Model = 0x05, DisplayName = "iCUE LINK TITAN 360", LedChannels = 20 },
            new CorsairICueLinkEndpoint { Type = 0x07, Model = 0x02, DisplayName = "iCUE LINK H150i RGB", LedChannels = 20 },
            new CorsairICueLinkEndpoint { Type = 0x07, Model = 0x05, DisplayName = "iCUE LINK H150i RGB", LedChannels = 20 },
            new CorsairICueLinkEndpoint { Type = 0x11, Model = 0x03, DisplayName = "iCUE LINK TITAN 420", LedChannels = 20 },
            new CorsairICueLinkEndpoint { Type = 0x07, Model = 0x03, DisplayName = "iCUE LINK H170i RGB", LedChannels = 20 },
            new CorsairICueLinkEndpoint { Type = 0x02, Model = 0x00, DisplayName = "iCUE LINK LX RGB", LedChannels = 18 },
            new CorsairICueLinkEndpoint { Type = 0x01, Model = 0x00, DisplayName = "iCUE LINK QX RGB", LedChannels = 34 },
            new CorsairICueLinkEndpoint { Type = 0x0F, Model = 0x00, DisplayName = "iCUE LINK RX RGB", LedChannels = 8 },
            new CorsairICueLinkEndpoint { Type = 0x03, Model = 0x00, DisplayName = "iCUE LINK RX RGB MAX", LedChannels = 8 },
            new CorsairICueLinkEndpoint { Type = 0x09, Model = 0x00, DisplayName = "iCUE LINK XC7 ELITE", LedChannels = 24 },
            new CorsairICueLinkEndpoint { Type = 0x0C, Model = 0x00, DisplayName = "iCUE LINK XD5 ELITE", LedChannels = 22 },
            new CorsairICueLinkEndpoint { Type = 0x0E, Model = 0x00, DisplayName = "iCUE LINK XD5 ELITE LCD", LedChannels = 22, Internal = true },
            new CorsairICueLinkEndpoint { Type = 0x19, Model = 0x00, DisplayName = "iCUE LINK XD6 ELITE", LedChannels = 22 },
            new CorsairICueLinkEndpoint { Type = 0x0D, Model = 0x00, DisplayName = "iCUE LINK XG7 RGB", LedChannels = 16 }
        };

        public bool Connect()
        {
            var devices = HidDevices.Enumerate(CORSAIR_VID, CORSAIR_ICUE_LINK_SYSTEM_HUB_PID).ToList();
            if (devices.Count == 0) return false;

            // Interface 0 (mi_00) = iCUE LINK protocol
            _device = devices.FirstOrDefault(d => d.DevicePath != null && d.DevicePath.Contains("mi_00", StringComparison.OrdinalIgnoreCase)) ?? devices.FirstOrDefault();
            _device?.OpenDevice();

            if (!IsConnected) return false;

            SetSoftwareMode();
            GetDevices();

            _keepAliveCts = new CancellationTokenSource();
            var token = _keepAliveCts.Token;
            Task.Run(() => KeepaliveLoopAsync(token));

            return true;
        }

        public void Disconnect()
        {
            _keepAliveCts?.Cancel();
            _keepAliveCts?.Dispose();
            _keepAliveCts = null;

            if (_device != null && _device.IsOpen)
            {
                SetHardwareMode();
                _device.CloseDevice();
                _device = null;
            }
        }

        private async Task KeepaliveLoopAsync(CancellationToken token)
        {
            try
            {
                while (!token.IsCancellationRequested)
                {
                    if (IsConnected && _endpoints.Count > 0 && _colorBuffer.Length > 0 && _lastSentColorBuffer != null)
                    {
                        if ((DateTime.Now - _lastCommitTime).TotalSeconds > 4.0)
                        {
                            UpdateLights(_colorBuffer);
                        }
                    }
                    await Task.Delay(1000, token);
                }
            }
            catch (TaskCanceledException)
            {
                // Graceful cancellation exit
            }
            catch (Exception)
            {
                // Safety catch
            }
        }

        private byte[]? SendCommand(byte[] command, byte[]? data, bool waitForResponse = true)
        {
            lock (_usbLock)
            {
                // Cihaza gönderilecek paket boyutu her zaman 513 olmalı (0x00 Report ID + 512 payload)
                byte[] writeBuf = new byte[513];
                
                writeBuf[0] = 0x00; // HID Report ID
                writeBuf[1] = 0x00; // Kullanıcının belirttiği OpenRGB yapısı
                writeBuf[2] = 0x01; // Sabit iCUE işaretçisi

                int idx = 3;
                
                // Komut ve datayı pakete yerleştir
                for (int i = 0; i < command.Length; i++) 
                    writeBuf[idx++] = command[i];
                    
                if (data != null)
                {
                    for (int i = 0; i < data.Length; i++) 
                        writeBuf[idx++] = data[i];
                }

                _device?.Write(writeBuf);

                if (!waitForResponse)
                {
                    return null;
                }

                // Wait 10ms for processing
                Thread.Sleep(10);

                var readReport = _device?.Read(1000);
                return readReport?.Data;
            }
        }

        private byte[]? ReadData(byte[] endpoint, byte[] dataType)
        {
            SendCommand(new byte[] { 0x05, 0x01, 0x01 }, endpoint); // CLOSE_ENDPOINT
            SendCommand(new byte[] { 0x0d, 0x01 }, endpoint); // OPEN_ENDPOINT
            
            // Wait for response logic included in the read (simplified for init)
            byte[]? res = SendCommand(new byte[] { 0x08, 0x01 }, Array.Empty<byte>()); // READ
            
            SendCommand(new byte[] { 0x05, 0x01, 0x01 }, endpoint); // CLOSE_ENDPOINT
            return res;
        }

        public void SetSoftwareMode()
        {
            // Hub'ı yazılım kontrolüne alma komutu: 0x01, 0x03, 0x00, 0x02
            SendCommand(new byte[] { 0x01, 0x03, 0x00, 0x02 }, Array.Empty<byte>());
        }

        public void SetHardwareMode()
        {
            // Uygulama kapanırken donanım kontrolüne geri döndürme
            SendCommand(new byte[] { 0x01, 0x03, 0x00, 0x01 }, Array.Empty<byte>());
        }

        private void GetDevices()
        {
            _endpoints.Clear();
            var endpointData = ReadData(new byte[] { 0x36 }, new byte[] { 0x21, 0x00 });
            if (endpointData == null || endpointData.Length < 7) return;

            int offset = (endpointData.Length > 512 && endpointData[0] == 0) ? 1 : 0;
            byte channel = endpointData[offset + 6];
            int pos = offset + 7;

            for (int channelIdx = 1; channelIdx < (channel + 1); channelIdx++)
            {
                if (pos >= endpointData.Length) break;

                int deviceIdLength = endpointData[pos + 7];
                if (deviceIdLength == 0)
                {
                    pos += 8;
                    continue;
                }

                byte type = endpointData[pos + 2];
                byte model = endpointData[pos + 3];

                var device = KnownDevices.FirstOrDefault(d => d.Type == type && d.Model == model);

                if (device != null && !device.Internal && device.LedChannels > 0)
                {
                    byte[] endpointId = new byte[deviceIdLength];
                    Array.Copy(endpointData, pos + 8, endpointId, 0, deviceIdLength);

                    var newEp = new CorsairICueLinkEndpoint
                    {
                        Type = device.Type,
                        Model = device.Model,
                        DisplayName = device.DisplayName,
                        LedChannels = device.LedChannels,
                        Internal = device.Internal,
                        EndpointId = endpointId
                    };
                    _endpoints.Add(newEp);
                }

                pos += 8 + deviceIdLength;
            }

            // Toplam LED sayısına göre buffer oluştur
            int totalLeds = _endpoints.Sum(e => e.LedChannels);
            _colorBuffer = new byte[totalLeds * 3];
        }

        /// <summary>
        /// Hub'a bağlı tüm cihazların LED'lerini tek seferde günceller.
        /// </summary>
        public void UpdateLights(byte[] rgbData)
        {
            // USB Write Throttling Optimization
            bool isIdentical = _lastSentColorBuffer != null && _lastSentColorBuffer.Length == rgbData.Length;
            if (isIdentical)
            {
                for (int i = 0; i < rgbData.Length; i++)
                {
                    if (_lastSentColorBuffer![i] != rgbData[i])
                    {
                        isIdentical = false;
                        break;
                    }
                }
            }

            // Skip updating if data is identical and we are well within the 4-second keepalive timeout
            if (isIdentical && (DateTime.Now - _lastCommitTime).TotalSeconds < 3.5)
            {
                return;
            }

            byte[] endpoint = new byte[] { 0x22 }; // Renk kontrol endpoint ID'si
            byte[] dataType = new byte[] { 0x12, 0x00 }; // Renk ayarlama (Set Color) komut tipi
            
            // 1. Endpoint'i kapat (0x05, 0x01, 0x01)
            SendCommand(new byte[] { 0x05, 0x01, 0x01 }, endpoint, waitForResponse: false);
            
            // 2. Renk Endpoint'ini aç (0x0d, 0x00)
            SendCommand(new byte[] { 0x0d, 0x00 }, endpoint, waitForResponse: false);
            
            // 3. Payload Wrapper (Başlık) verisini hazırla
            ushort dataLen = (ushort)(rgbData.Length + 2); // Uzunluk byte sayısı + 2
            
            List<byte> buf = new List<byte>();
            buf.Add((byte)(dataLen & 0xFF));        // Length_LSB
            buf.Add((byte)((dataLen >> 8) & 0xFF)); // Length_MSB
            buf.Add(0x00);                          // Header boşluğu
            buf.Add(0x00);                          // Header boşluğu
            buf.AddRange(dataType);                 // Veri tipi: 0x12, 0x00
            buf.AddRange(rgbData);                  // RGB Verisi
            
            // 4. Veriyi maksimum 508 byte'lık chunk'lar halinde gönder
            int maxChunkSize = 508;
            for (int offset = 0; offset < buf.Count; offset += maxChunkSize)
            {
                int chunkSize = Math.Min(maxChunkSize, buf.Count - offset);
                byte[] chunk = buf.Skip(offset).Take(chunkSize).ToArray();
                
                if (offset == 0)
                {
                    // İlk chunk için komut başlığı: 0x06, 0x00
                    SendCommand(new byte[] { 0x06, 0x00 }, chunk, waitForResponse: false);
                }
                else
                {
                    // Sonraki chunk'lar için komut başlığı: 0x07, 0x00
                    SendCommand(new byte[] { 0x07, 0x00 }, chunk, waitForResponse: false);
                }
            }
            
            // 5. Endpoint'i geri kapat (0x05, 0x01, 0x01)
            SendCommand(new byte[] { 0x05, 0x01, 0x01 }, endpoint, waitForResponse: false);

            // Maintain cache
            if (_lastSentColorBuffer == null || _lastSentColorBuffer.Length != rgbData.Length)
            {
                _lastSentColorBuffer = new byte[rgbData.Length];
            }
            Array.Copy(rgbData, _lastSentColorBuffer, rgbData.Length);

            _lastCommitTime = DateTime.Now;
        }

        public void SetColor(byte r, byte g, byte b)
        {
            if (!IsConnected || _endpoints.Count == 0 || _colorBuffer.Length == 0) return;

            for (int i = 0; i < _colorBuffer.Length / 3; i++)
            {
                _colorBuffer[i * 3] = r;
                _colorBuffer[(i * 3) + 1] = g;
                _colorBuffer[(i * 3) + 2] = b;
            }

            UpdateLights(_colorBuffer);
        }
    }
}
