using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Dynamic_Lighting.Pages
{
    public sealed partial class AsusPage : Page
    {
        private readonly ColorPicker AuraColorPicker;

        public AsusPage()
        {
            this.InitializeComponent();
            AuraColorPicker = ColorPickerFactory.CreateDefaultColorPicker();
            AuraColorPicker.ColorChanged += AuraColorPicker_ColorChanged;
            ColorPickerFactory.AttachToHost(AuraColorPickerHost, AuraColorPicker);

            if (DeviceManager.AuraController != null && DeviceManager.AuraController.IsConnected)
            {
                if (DeviceManager.AuraController is AuraMainboardController mb)
                {
                    AuraStatusText.Text = $"Status: Connected\n{mb.GetDeviceInfo()}";
                }
                else
                {
                    AuraStatusText.Text = "Status: Connected (Fallback Controller)";
                }
            }
            else
            {
                AuraStatusText.Text = "Status: No ASUS Aura device connected.";
            }
        }

        private void SetAuraColor(Windows.UI.Color color)
        {
            if (DeviceManager.AuraController == null || !DeviceManager.AuraController.IsConnected) return;

            try
            {
                if (DeviceManager.AuraController is AuraMainboardController mbCtrl)
                {
                    int zoneIndex = AuraZoneComboBox.SelectedIndex;

                    // 0 = All Zones
                    // 1 = Mainboard LEDs Only
                    // 2 = Addressable Header 1 Only
                    // 3 = Addressable Header 2 Only

                    if (zoneIndex == 0 || zoneIndex == 1)
                    {
                        mbCtrl.SetMainboardColor(color.R, color.G, color.B);
                    }
                    
                    if (zoneIndex == 0 || zoneIndex == 2)
                    {
                        int header1Count = (int)(AddrHeader1LedCount.Value);
                        if (header1Count > 0)
                            mbCtrl.SetAddressableColor(0, color.R, color.G, color.B, header1Count);
                    }
                    
                    if (zoneIndex == 0 || zoneIndex == 3)
                    {
                        int header2Count = (int)(AddrHeader2LedCount.Value);
                        if (header2Count > 0)
                            mbCtrl.SetAddressableColor(1, color.R, color.G, color.B, header2Count);
                    }
                }
                else
                {
                    DeviceManager.AuraController.SetColor(color.R, color.G, color.B, 120);
                }
            }
            catch { }
        }

        private void ApplyAuraColorButton_Click(object sender, RoutedEventArgs e)
        {
            if (DeviceManager.AuraController != null && DeviceManager.AuraController.IsConnected)
            {
                Windows.UI.Color c = AuraColorPicker.Color;
                SetAuraColor(c);
                int h1 = (int)(AddrHeader1LedCount.Value);
                int h2 = (int)(AddrHeader2LedCount.Value);
                AuraStatusText.Text = $"Status: Color applied ({c.R}, {c.G}, {c.B}) | H1:{h1} H2:{h2} LEDs";
            }
        }

        private void AuraColorPicker_ColorChanged(object sender, ColorChangedEventArgs args)
        {
            if (LivePreviewAuraToggle.IsChecked == true && DeviceManager.AuraController != null && DeviceManager.AuraController.IsConnected)
            {
                SetAuraColor(args.NewColor);
                AuraStatusText.Text = $"Status: Live Preview ({args.NewColor.R}, {args.NewColor.G}, {args.NewColor.B})";
            }
        }

        private void LivePreviewAuraToggle_Click(object sender, RoutedEventArgs e)
        {
            if (LivePreviewAuraToggle.IsChecked == true && DeviceManager.AuraController != null && DeviceManager.AuraController.IsConnected)
            {
                Windows.UI.Color c = AuraColorPicker.Color;
                SetAuraColor(c);
                AuraStatusText.Text = $"Status: Live Preview enabled ({c.R}, {c.G}, {c.B})";
            }
        }

        private void AddrHeaderLedCount_ValueChanged(NumberBox sender, NumberBoxValueChangedEventArgs args)
        {
            if (LivePreviewAuraToggle != null && LivePreviewAuraToggle.IsChecked == true && 
                DeviceManager.AuraController != null && DeviceManager.AuraController.IsConnected)
            {
                Windows.UI.Color c = AuraColorPicker.Color;
                SetAuraColor(c);
            }
        }

        private void AuraZoneComboBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (AddressableLedCountPanel == null) return;
            int idx = AuraZoneComboBox.SelectedIndex;
            AddressableLedCountPanel.Visibility = (idx == 0 || idx == 2 || idx == 3) ? Visibility.Visible : Visibility.Collapsed;
        }
    }
}
