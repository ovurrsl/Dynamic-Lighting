using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using HidLibrary;

namespace Dynamic_Lighting
{
    /// <summary>
    /// Channel type matching OpenRGB's AuraDeviceType enum.
    /// </summary>
    public enum AuraDeviceType
    {
        Fixed,        // Mainboard onboard LEDs
        Addressable   // Addressable RGB header (ARGB)
    }

    /// <summary>
    /// Holds information about a single LED channel on the device,
    /// matching the OpenRGB AuraDeviceInfo struct.
    /// </summary>
    public class AuraChannelInfo
    {
        /// <summary>Channel index used for SendEffect (0x35) commands.</summary>
        public byte EffectChannel { get; set; }

        /// <summary>Channel index used for SendDirect (0x40) commands.</summary>
        public byte DirectChannel { get; set; }

        /// <summary>Number of LEDs on this channel.</summary>
        public int NumLeds { get; set; }

        /// <summary>Number of RGB headers (only for Fixed type).</summary>
        public byte NumHeaders { get; set; }

        /// <summary>Type of device on this channel.</summary>
        public AuraDeviceType DeviceType { get; set; }
    }

    public abstract class AuraBaseController : IAuraController
    {
        protected const int AURA_USB_VID = 0x0B05;

        protected readonly int[] AURA_PIDS = new int[]
        {
            0x1867, 0x1872, 0x18A3, 0x18A5, // Addressable
            0x18F3, 0x1939, 0x19AF, 0x1AA6, 0x1BED // Motherboard
        };

        // Protocol constants (from OpenRGB AsusAuraUSBController.h)
        protected const byte AURA_REQUEST_FIRMWARE_VERSION = 0x82;
        protected const byte AURA_REQUEST_CONFIG_TABLE     = 0xB0;
        protected const byte AURA_CONTROL_MODE_DIRECT      = 0x40;
        protected const byte AURA_MODE_DIRECT              = 0xFF;

        // Mainboard-specific protocol constants (from OpenRGB AsusAuraMainboardController.h)
        protected const byte AURA_MAINBOARD_CONTROL_MODE_EFFECT       = 0x35;
        protected const byte AURA_MAINBOARD_CONTROL_MODE_EFFECT_COLOR = 0x36;
        protected const byte AURA_MAINBOARD_CONTROL_MODE_COMMIT       = 0x3F;

        protected const int LEDS_PER_PACKET = 20;

        protected HidDevice? _device;
        protected byte[] _configTable = new byte[60];
        protected string _firmwareVersion = "";
        protected List<AuraChannelInfo> _channels = new List<AuraChannelInfo>();

        public virtual bool Connect()
        {
            foreach (var pid in AURA_PIDS)
            {
                var devices = HidDevices.Enumerate(AURA_USB_VID, pid).ToList();
                if (devices.Count > 0)
                {
                    // Prioritize Interface 2 (mi_02) — standard for ASUS motherboard lighting controllers.
                    var device = devices.FirstOrDefault(d => d.DevicePath != null &&
                                                             d.DevicePath.Contains("mi_02", StringComparison.OrdinalIgnoreCase))
                                 ?? devices.FirstOrDefault();

                    if (device != null)
                    {
                        _device = device;
                        _device.OpenDevice();
                        InitializeDevice();
                        return true;
                    }
                }
            }

            return false;
        }

        protected virtual void InitializeDevice()
        {
            // Optional initialization for child classes
        }

        public void Disconnect()
        {
            if (_device != null && _device.IsOpen)
            {
                _device.CloseDevice();
                _device.Dispose();
                _device = null;
            }
        }

        public bool IsConnected => _device != null && _device.IsOpen;

        public string? DevicePath => _device?.DevicePath;

        public string FirmwareVersion => _firmwareVersion;

        public IReadOnlyList<AuraChannelInfo> Channels => _channels.AsReadOnly();

        public abstract void SetColor(byte red, byte green, byte blue, int ledCount = 120);

        // ──────────────────────────────────────────────────────────
        //  Protocol Methods (matching OpenRGB's AsusAuraUSBController)
        // ──────────────────────────────────────────────────────────

        /// <summary>
        /// Reads the firmware version from the device.
        /// OpenRGB: AsusAuraUSBController::GetFirmwareVersion()
        /// TX: [0xEC][0x82][0x00...]  →  RX: [xx][0x02][version_string...]
        /// </summary>
        protected void ReadFirmwareVersion()
        {
            if (!IsConnected) return;

            // OpenRGB buffer layout: [ReportID=0xEC][0x82][0x00...]
            // HidLibrary: data[0] = Report ID, data[1..64] = report data
            byte[] txBuf = new byte[65];
            txBuf[0] = 0xEC; // Report ID (ASUS Aura uses 0xEC)
            txBuf[1] = AURA_REQUEST_FIRMWARE_VERSION;
            _device!.Write(txBuf);

            Thread.Sleep(50);

            var report = _device.Read(100);
            // HidLibrary read: report.Data[0] = Report ID, report.Data[1..] = data
            // OpenRGB checks usb_buf[1] == 0x02, which maps to report.Data[1] in hidapi
            // But HidLibrary may or may not include the report ID in Data, depending on version.
            // Try both offsets for robustness.
            if (report.Status == HidDeviceData.ReadStatus.Success && report.Data.Length > 3)
            {
                int dataStart = -1;
                // Check if Data[1] == 0x02 (report ID included in Data)
                if (report.Data[1] == 0x02) dataStart = 2;
                // Check if Data[0] == 0x02 (report ID NOT included in Data)
                else if (report.Data[0] == 0x02) dataStart = 1;

                if (dataStart >= 0)
                {
                    int len = Math.Min(16, report.Data.Length - dataStart);
                    char[] version = new char[len];
                    for (int i = 0; i < len; i++)
                    {
                        byte b = report.Data[dataStart + i];
                        if (b == 0) { len = i; break; }
                        version[i] = (char)b;
                    }
                    _firmwareVersion = new string(version, 0, len);
                }
            }
        }

        /// <summary>
        /// Reads the config table from the device.
        /// OpenRGB: AsusAuraUSBController::GetConfigTable()
        /// TX: [0xEC][0xB0][0x00...]  →  RX: [xx][0x30][xx][xx][config_table 60 bytes]
        /// </summary>
        protected bool ReadConfigTable()
        {
            if (!IsConnected) return false;

            // OpenRGB: [ReportID=0xEC][0xB0][0x00...]
            byte[] txBuf = new byte[65];
            txBuf[0] = 0xEC; // Report ID
            txBuf[1] = AURA_REQUEST_CONFIG_TABLE;
            _device!.Write(txBuf);

            Thread.Sleep(50);

            var report = _device.Read(100);
            if (report.Status == HidDeviceData.ReadStatus.Success && report.Data.Length > 4)
            {
                // OpenRGB checks usb_buf[1] == 0x30 then copies from usb_buf[4]
                // Try both offsets for HidLibrary compatibility
                int configStart = -1;
                if (report.Data.Length > 1 && report.Data[1] == 0x30)
                {
                    configStart = 4; // Report ID included in Data
                }
                else if (report.Data.Length > 0 && report.Data[0] == 0x30)
                {
                    configStart = 3; // Report ID NOT included in Data
                }

                if (configStart >= 0 && report.Data.Length > configStart)
                {
                    int copyLen = Math.Min(60, report.Data.Length - configStart);
                    Array.Copy(report.Data, configStart, _configTable, 0, copyLen);
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Sends the SetGen1 command.
        /// OpenRGB: AuraMainboardController::SetGen1()
        /// TX: [0xEC][0x52][0x53][0x00][0x01][0x00...]
        /// </summary>
        protected void SendSetGen1()
        {
            if (!IsConnected) return;

            // OpenRGB: [0xEC][0x52][0x53][0x00][0x01]
            byte[] data = new byte[65];
            data[0] = 0xEC; // Report ID
            data[1] = 0x52;
            data[2] = 0x53;
            data[3] = 0x00;
            data[4] = 0x01;
            _device!.Write(data);
        }

        /// <summary>
        /// Sends an effect mode command for a channel.
        /// OpenRGB: AuraMainboardController::SendEffect()
        /// TX: [0xEC][0x35][effect_channel][0x00][shutdown][mode][0x00...]
        /// </summary>
        protected void SendEffect(byte effectChannel, byte mode, bool shutdownEffect = false)
        {
            if (!IsConnected) return;

            // OpenRGB: [0xEC][0x35][channel][0x00][shutdown][mode]
            byte[] data = new byte[65];
            data[0] = 0xEC; // Report ID
            data[1] = AURA_MAINBOARD_CONTROL_MODE_EFFECT;
            data[2] = effectChannel;
            data[3] = 0x00;
            data[4] = (byte)(shutdownEffect ? 0x01 : 0x00);
            data[5] = mode;
            _device!.Write(data);
        }

        /// <summary>
        /// Sends direct color data to a specific channel.
        /// OpenRGB: AsusAuraUSBController::SendDirect()
        /// TX: [0xEC][0x40][apply|direct_channel][offset][led_count][R G B R G B ...]
        /// </summary>
        protected void SendDirect(byte directChannel, byte red, byte green, byte blue, int ledCount)
        {
            if (!IsConnected) return;

            int offset = 0;

            while (offset < ledCount)
            {
                int sentLedCount = Math.Min(LEDS_PER_PACKET, ledCount - offset);
                bool apply = (offset + sentLedCount == ledCount);

                // OpenRGB: [0xEC][0x40][apply|channel][offset][count][R G B ...]
                byte[] data = new byte[65];
                data[0] = 0xEC; // Report ID
                data[1] = AURA_CONTROL_MODE_DIRECT;
                data[2] = (byte)((apply ? 0x80 : 0x00) | directChannel);
                data[3] = (byte)offset;
                data[4] = (byte)sentLedCount;

                for (int i = 0; i < sentLedCount; i++)
                {
                    data[5 + (i * 3)] = red;
                    data[6 + (i * 3)] = green;
                    data[7 + (i * 3)] = blue;
                }

                _device!.Write(data);

                offset += sentLedCount;
            }
        }

        /// <summary>
        /// Sends direct per-LED color data to a specific channel.
        /// Same protocol as SendDirect but with individual LED colors.
        /// </summary>
        protected void SendDirectPerLed(byte directChannel, byte[] rgbData, int ledCount)
        {
            if (!IsConnected) return;

            int offset = 0;

            while (offset < ledCount)
            {
                int sentLedCount = Math.Min(LEDS_PER_PACKET, ledCount - offset);
                bool apply = (offset + sentLedCount == ledCount);

                // OpenRGB: [0xEC][0x40][apply|channel][offset][count][R G B ...]
                byte[] data = new byte[65];
                data[0] = 0xEC; // Report ID
                data[1] = AURA_CONTROL_MODE_DIRECT;
                data[2] = (byte)((apply ? 0x80 : 0x00) | directChannel);
                data[3] = (byte)offset;
                data[4] = (byte)sentLedCount;

                for (int i = 0; i < sentLedCount; i++)
                {
                    int srcIdx = (offset + i) * 3;
                    if (srcIdx + 2 < rgbData.Length)
                    {
                        data[5 + (i * 3)] = rgbData[srcIdx];
                        data[6 + (i * 3)] = rgbData[srcIdx + 1];
                        data[7 + (i * 3)] = rgbData[srcIdx + 2];
                    }
                }

                _device!.Write(data);

                offset += sentLedCount;
            }
        }
    }
}
