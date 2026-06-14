using System;
using System.Threading;

namespace Dynamic_Lighting
{
    /// <summary>
    /// Controller for ASUS Aura Mainboard devices (PID 0x18F3, 0x1939, 0x19AF, 0x1AA6, 0x1BED).
    /// Implements the exact protocol OpenRGB uses in AsusAuraMainboardController.
    /// Controls both onboard mainboard LEDs and addressable ARGB headers through a single HID device.
    /// </summary>
    public class AuraMainboardController : AuraBaseController
    {
        // Number of addressable headers detected from config table
        private int _numAddressableHeaders = 0;
        private int _numMainboardLeds = 0;

        protected override void InitializeDevice()
        {
            // ── Step 1: Read firmware version ──
            ReadFirmwareVersion();
            Thread.Sleep(20);

            // ── Step 2: Read config table ──
            bool hasConfigTable = ReadConfigTable();
            Thread.Sleep(20);

            // ── Step 3: Parse config table and build channel list ──
            _channels.Clear();
            byte effectChannel = 0;

            if (hasConfigTable)
            {
                // OpenRGB: config_table[0x1B] = total mainboard LEDs
                //          config_table[0x1D] = RGB header count
                //          config_table[0x02] = addressable header count
                _numMainboardLeds      = _configTable[0x1B];
                byte numRgbHeaders     = _configTable[0x1D];
                _numAddressableHeaders = _configTable[0x02];

                if (_numMainboardLeds < numRgbHeaders)
                    numRgbHeaders = 0;

                // Add mainboard fixed LED channel (direct_channel = 0x04)
                if (_numMainboardLeds > 0)
                {
                    _channels.Add(new AuraChannelInfo
                    {
                        EffectChannel = effectChannel,
                        DirectChannel = 0x04,
                        NumLeds = _numMainboardLeds,
                        NumHeaders = numRgbHeaders,
                        DeviceType = AuraDeviceType.Fixed
                    });
                    effectChannel++;
                }

                // Add addressable header channels (direct_channel = header index: 0, 1, 2, ...)
                for (int i = 0; i < _numAddressableHeaders; i++)
                {
                    _channels.Add(new AuraChannelInfo
                    {
                        EffectChannel = effectChannel,
                        DirectChannel = (byte)i,
                        NumLeds = 1, // Will be set by user via SetColor ledCount parameter
                        NumHeaders = 0,
                        DeviceType = AuraDeviceType.Addressable
                    });
                    effectChannel++;
                }
            }
            else
            {
                // Fallback: if config table read fails, assume typical layout
                // Channel 0 = mainboard (direct_channel 0x04)
                _channels.Add(new AuraChannelInfo
                {
                    EffectChannel = 0,
                    DirectChannel = 0x04,
                    NumLeds = 4,
                    NumHeaders = 0,
                    DeviceType = AuraDeviceType.Fixed
                });

                // Channel 1, 2 = addressable headers (direct_channel 0, 1)
                _channels.Add(new AuraChannelInfo
                {
                    EffectChannel = 1,
                    DirectChannel = 0,
                    NumLeds = 1,
                    NumHeaders = 0,
                    DeviceType = AuraDeviceType.Addressable
                });
                _channels.Add(new AuraChannelInfo
                {
                    EffectChannel = 2,
                    DirectChannel = 1,
                    NumLeds = 1,
                    NumHeaders = 0,
                    DeviceType = AuraDeviceType.Addressable
                });

                _numAddressableHeaders = 2;
                _numMainboardLeds = 4;
            }

            // ── Step 4: SetGen1 ──
            SendSetGen1();
            Thread.Sleep(20);

            // ── Step 5: Set all channels to Direct Mode (0xFF) ──
            foreach (var ch in _channels)
            {
                SendEffect(ch.EffectChannel, AURA_MODE_DIRECT);
                Thread.Sleep(10);
            }
        }

        public override void SetColor(byte red, byte green, byte blue, int ledCount = 120)
        {
            if (!IsConnected || _channels.Count == 0) return;

            foreach (var ch in _channels)
            {
                if (ch.DeviceType == AuraDeviceType.Fixed)
                {
                    // Mainboard LEDs: use the actual LED count from config table
                    SendDirect(ch.DirectChannel, red, green, blue, ch.NumLeds);
                }
                else
                {
                    // Addressable headers: use the user-specified LED count and pad the rest with black up to 120
                    int maxLeds = 120;
                    byte[] rgbData = new byte[maxLeds * 3];
                    for (int i = 0; i < maxLeds; i++)
                    {
                        if (i < ledCount)
                        {
                            rgbData[i * 3] = red;
                            rgbData[i * 3 + 1] = green;
                            rgbData[i * 3 + 2] = blue;
                        }
                        else
                        {
                            rgbData[i * 3] = 0;
                            rgbData[i * 3 + 1] = 0;
                            rgbData[i * 3 + 2] = 0;
                        }
                    }
                    SendDirectPerLed(ch.DirectChannel, rgbData, maxLeds);
                }
            }
        }

        /// <summary>
        /// Sets color on a specific addressable header only.
        /// headerIndex: 0 = first addressable header, 1 = second, etc.
        /// </summary>
        public void SetAddressableColor(int headerIndex, byte red, byte green, byte blue, int ledCount)
        {
            if (!IsConnected) return;

            int addrIdx = 0;
            foreach (var ch in _channels)
            {
                if (ch.DeviceType == AuraDeviceType.Addressable)
                {
                    if (addrIdx == headerIndex)
                    {
                        int maxLeds = 120;
                        byte[] rgbData = new byte[maxLeds * 3];
                        for (int i = 0; i < maxLeds; i++)
                        {
                            if (i < ledCount)
                            {
                                rgbData[i * 3] = red;
                                rgbData[i * 3 + 1] = green;
                                rgbData[i * 3 + 2] = blue;
                            }
                            else
                            {
                                rgbData[i * 3] = 0;
                                rgbData[i * 3 + 1] = 0;
                                rgbData[i * 3 + 2] = 0;
                            }
                        }
                        SendDirectPerLed(ch.DirectChannel, rgbData, maxLeds);
                        return;
                    }
                    addrIdx++;
                }
            }
        }

        /// <summary>
        /// Sets color on the mainboard onboard LEDs only.
        /// </summary>
        public void SetMainboardColor(byte red, byte green, byte blue)
        {
            if (!IsConnected) return;

            foreach (var ch in _channels)
            {
                if (ch.DeviceType == AuraDeviceType.Fixed)
                {
                    SendDirect(ch.DirectChannel, red, green, blue, ch.NumLeds);
                }
            }
        }

        /// <summary>
        /// Gets device info summary for UI display.
        /// </summary>
        public string GetDeviceInfo()
        {
            string info = $"Firmware: {FirmwareVersion}\n";
            info += $"Mainboard LEDs: {_numMainboardLeds}\n";
            info += $"Addressable Headers: {_numAddressableHeaders}\n";
            info += $"Total Channels: {_channels.Count}\n";
            for (int i = 0; i < _channels.Count; i++)
            {
                var ch = _channels[i];
                info += $"  Ch{i}: type={ch.DeviceType}, effect={ch.EffectChannel}, direct={ch.DirectChannel}, leds={ch.NumLeds}\n";
            }
            return info;
        }
    }
}
