using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using NAudio.CoreAudioApi;

namespace Dynamic_Lighting
{
    public enum LightingMode
    {
        Static,
        Breathing,
        Rainbow,
        AudioReactive
    }

    public static class AnimationManager
    {
        private static LightingMode _currentMode = LightingMode.Static;
        private static Windows.UI.Color _baseColor = Windows.UI.Color.FromArgb(255, 255, 0, 0);
        private static double _speed = 1.0;
        private static int _targetDeviceIndex = 0; // 0 = All, 1 = Arduino, 2 = ASUS, 3 = Corsair

        private static CancellationTokenSource? _cts;
        private static readonly object _lock = new object();
        private static bool _isRunning = false;

        // Audio Reactive fields
        private static MMDevice? _audioDevice;
        private static float _smoothPeak = 0f;

        // Visual preview color synchronized in real-time
        public static event Action<Windows.UI.Color>? OnColorUpdated;

        public static LightingMode CurrentMode => _currentMode;
        public static Windows.UI.Color BaseColor => _baseColor;
        public static double Speed => _speed;
        public static int TargetDeviceIndex => _targetDeviceIndex;

        public static void Initialize()
        {
            // Initial state set to Static Red
            UpdateMode(LightingMode.Static, _baseColor, 1.0, 0);
        }

        public static void UpdateMode(LightingMode mode, Windows.UI.Color color, double speed, int targetIndex)
        {
            lock (_lock)
            {
                _currentMode = mode;
                _baseColor = color;
                _speed = speed;
                _targetDeviceIndex = targetIndex;

                if (mode == LightingMode.Static)
                {
                    StopLoop();
                    ApplyStaticColor(color);
                }
                else
                {
                    StartLoop();
                }
            }
        }

        private static void StartLoop()
        {
            if (_isRunning) return;

            _cts = new CancellationTokenSource();
            _isRunning = true;
            
            // Start the background animation loop on a Task
            Task.Run(() => AnimationLoopAsync(_cts.Token));
        }

        private static void StopLoop()
        {
            if (!_isRunning) return;

            _cts?.Cancel();
            _cts?.Dispose();
            _cts = null;
            _isRunning = false;

            ReleaseAudioDevice();
        }

        private static void ApplyStaticColor(Windows.UI.Color color)
        {
            ApplyColorToHardware(color);
            OnColorUpdated?.Invoke(color);
        }

        private static async Task AnimationLoopAsync(CancellationToken token)
        {
            var stopwatch = Stopwatch.StartNew();
            double lastTime = 0;
            double accumulatedTime = 0;

            // Frame delay of ~33ms targeting a stable and CPU-friendly ~30 FPS
            const int FrameDelayMs = 33; 

            try
            {
                while (!token.IsCancellationRequested)
                {
                    double currentTime = stopwatch.Elapsed.TotalSeconds;
                    double deltaTime = currentTime - lastTime;
                    lastTime = currentTime;

                    accumulatedTime += deltaTime * _speed;

                    Windows.UI.Color frameColor;

                    if (_currentMode == LightingMode.Breathing)
                    {
                        // Sinusoidal wave scaling from 0.0 to 1.0
                        // Breathing cycle frequency shaped by Math.PI
                        double wave = (Math.Sin(accumulatedTime * Math.PI) + 1.0) / 2.0;

                        byte r = (byte)(_baseColor.R * wave);
                        byte g = (byte)(_baseColor.G * wave);
                        byte b = (byte)(_baseColor.B * wave);

                        frameColor = Windows.UI.Color.FromArgb(255, r, g, b);
                    }
                    else if (_currentMode == LightingMode.Rainbow)
                    {
                        // Cycle hue from 0 to 360 degrees
                        double hue = (accumulatedTime * 60.0) % 360.0;
                        if (hue < 0) hue += 360.0;

                        frameColor = ColorFromHsv(hue, 1.0, 1.0);
                    }
                    else if (_currentMode == LightingMode.AudioReactive)
                    {
                        float peak = GetAudioPeak();
                        
                        // Decay the smoothed peak smoothly over time based on deltaTime and speed
                        _smoothPeak = Math.Max(peak, _smoothPeak - (float)(deltaTime * 2.5 * _speed));
                        _smoothPeak = Math.Clamp(_smoothPeak, 0f, 1f);

                        byte r = (byte)(_baseColor.R * _smoothPeak);
                        byte g = (byte)(_baseColor.G * _smoothPeak);
                        byte b = (byte)(_baseColor.B * _smoothPeak);

                        frameColor = Windows.UI.Color.FromArgb(255, r, g, b);
                    }
                    else
                    {
                        // Fallback static
                        frameColor = _baseColor;
                    }

                    // Push the color to hardware devices
                    ApplyColorToHardware(frameColor);

                    // Notify UI to render local synchronized glowing effect
                    OnColorUpdated?.Invoke(frameColor);

                    // Wait asynchronously to prevent CPU thread blocking
                    await Task.Delay(FrameDelayMs, token);
                }
            }
            catch (TaskCanceledException)
            {
                // Graceful cancellation exit
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"Error in AnimationLoop: {ex.Message}");
            }
            finally
            {
                stopwatch.Stop();
                ReleaseAudioDevice();
            }
        }

        private static void ApplyColorToHardware(Windows.UI.Color color)
        {
            int target = _targetDeviceIndex;

            // 0 = All Devices
            // 1 = Arduino (LampArray)
            // 2 = ASUS Aura (Motherboard)
            // 3 = Corsair iCUE Link

            if (target == 0 || target == 1)
            {
                if (DeviceManager.ArduinoLampArray != null)
                {
                    try
                    {
                        DeviceManager.ArduinoLampArray.SetColor(color);
                    }
                    catch { }
                }
            }

            if (target == 0 || target == 2)
            {
                if (DeviceManager.AuraController != null && DeviceManager.AuraController.IsConnected)
                {
                    try
                    {
                        DeviceManager.AuraController.SetColor(color.R, color.G, color.B, 120);
                    }
                    catch { }
                }
            }

            if (target == 0 || target == 3)
            {
                if (DeviceManager.CorsairController != null && DeviceManager.CorsairController.IsConnected)
                {
                    try
                    {
                        DeviceManager.CorsairController.SetColor(color.R, color.G, color.B);
                    }
                    catch { }
                }
            }
        }

        private static Windows.UI.Color ColorFromHsv(double hue, double saturation, double value)
        {
            int hi = Convert.ToInt32(Math.Floor(hue / 60)) % 6;
            double f = hue / 60 - Math.Floor(hue / 60);

            value = value * 255;
            byte v = Convert.ToByte(value);
            byte p = Convert.ToByte(value * (1 - saturation));
            byte q = Convert.ToByte(value * (1 - f * saturation));
            byte t = Convert.ToByte(value * (1 - (1 - f) * saturation));

            if (hi == 0)
                return Windows.UI.Color.FromArgb(255, v, t, p);
            else if (hi == 1)
                return Windows.UI.Color.FromArgb(255, q, v, p);
            else if (hi == 2)
                return Windows.UI.Color.FromArgb(255, p, v, t);
            else if (hi == 3)
                return Windows.UI.Color.FromArgb(255, p, q, v);
            else if (hi == 4)
                return Windows.UI.Color.FromArgb(255, t, p, v);
            else
                return Windows.UI.Color.FromArgb(255, v, p, q);
        }

        private static float GetAudioPeak()
        {
            try
            {
                if (_audioDevice == null)
                {
                    var enumerator = new MMDeviceEnumerator();
                    _audioDevice = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Console);
                }
                return _audioDevice.AudioMeterInformation.MasterPeakValue;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"Error reading audio peak: {ex.Message}");
                return 0f;
            }
        }

        private static void ReleaseAudioDevice()
        {
            if (_audioDevice != null)
            {
                try
                {
                    _audioDevice.Dispose();
                }
                catch { }
                _audioDevice = null;
            }
        }
    }
}
