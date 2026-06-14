using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Dynamic_Lighting.Pages
{
    public sealed partial class CorsairPage : Page
    {
        private ColorPicker? CorsairColorPicker;
        private readonly bool _isInitializing = true;

        public CorsairPage()
        {
            this.InitializeComponent();

            CorsairColorPicker = ColorPickerFactory.CreateDefaultColorPicker();
            CorsairColorPicker.ColorChanged += CorsairColorPicker_ColorChanged;
            ColorPickerFactory.AttachToHost(CorsairColorPickerHost, CorsairColorPicker);

            // Load device list
            if (DeviceManager.CorsairController != null && DeviceManager.CorsairController.IsConnected)
            {
                var endpoints = DeviceManager.CorsairController.Endpoints;

                ConnectionStatusText.Text = $"Connected: {endpoints.Count} iCUE Link devices detected.";

                foreach (var endpoint in endpoints)
                {
                    DeviceListPanel.Children.Add(new TextBlock
                    {
                        Text = $"{endpoint.DisplayName} - {endpoint.LedChannels} Addressable LEDs",
                        FontSize = 14,
                        TextWrapping = TextWrapping.Wrap
                    });
                }
            }
            else
            {
                ConnectionStatusText.Text = "Not Connected: No iCUE Link System Hub was discovered.";
                StatusText.Text = "Hardware not connected. Connect hub and restart app.";
            }

            try
            {
                var settings = SettingsManager.Load();
                CorsairColorPicker.Color = Windows.UI.Color.FromArgb(255, settings.ColorR, settings.ColorG, settings.ColorB);
            }
            catch
            {
                CorsairColorPicker.Color = Microsoft.UI.Colors.Red;
            }

            _isInitializing = false;
        }

        private void ApplyColorToHardware(Windows.UI.Color color)
        {
            if (DeviceManager.CorsairController != null && DeviceManager.CorsairController.IsConnected)
            {
                try
                {
                    DeviceManager.CorsairController.SetColor(color.R, color.G, color.B);
                    StatusText.Text = $"Color applied: ({color.R}, {color.G}, {color.B})";
                }
                catch (Exception ex)
                {
                    StatusText.Text = $"Error writing color: {ex.Message}";
                }
            }
            else
            {
                StatusText.Text = "Hardware not connected. Connect hub and restart app.";
            }
        }

        private void CorsairColorPicker_ColorChanged(object sender, ColorChangedEventArgs args)
        {
            if (!_isInitializing && LivePreviewToggle.IsChecked == true)
            {
                ApplyColorToHardware(args.NewColor);
            }
        }

        private void ApplyColorButton_Click(object sender, RoutedEventArgs e)
        {
            if (CorsairColorPicker != null)
            {
                ApplyColorToHardware(CorsairColorPicker.Color);
            }
        }

        private void LivePreviewToggle_Click(object sender, RoutedEventArgs e)
        {
            if (LivePreviewToggle.IsChecked == true)
            {
                if (CorsairColorPicker != null)
                {
                    ApplyColorToHardware(CorsairColorPicker.Color);
                }
            }
        }
    }
}
