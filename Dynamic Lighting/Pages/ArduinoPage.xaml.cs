using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Dynamic_Lighting.Pages
{
    public sealed partial class ArduinoPage : Page
    {
        private readonly ColorPicker ArduinoColorPicker;

        public ArduinoPage()
        {
            this.InitializeComponent();
            ArduinoColorPicker = ColorPickerFactory.CreateDefaultColorPicker();
            ArduinoColorPicker.ColorChanged += ArduinoColorPicker_ColorChanged;
            ColorPickerFactory.AttachToHost(ArduinoColorPickerHost, ArduinoColorPicker);

            if (DeviceManager.ArduinoLampArray != null)
            {
                ArduinoStatusText.Text = "Status: Connected (Arduino LampArray)";
            }
            else
            {
                ArduinoStatusText.Text = "Status: No LampArray device connected.";
            }
        }

        private void SetArduinoColor(Windows.UI.Color color)
        {
            if (DeviceManager.ArduinoLampArray != null)
            {
                DeviceManager.ArduinoLampArray.SetColor(color);
            }
        }

        private void ApplyArduinoColorButton_Click(object sender, RoutedEventArgs e)
        {
            if (DeviceManager.ArduinoLampArray != null)
            {
                Windows.UI.Color c = ArduinoColorPicker.Color;
                SetArduinoColor(c);
                ArduinoStatusText.Text = $"Status: Color applied ({c.R}, {c.G}, {c.B})";
            }
        }

        private void ArduinoColorPicker_ColorChanged(object sender, ColorChangedEventArgs args)
        {
            if (LivePreviewArduinoToggle.IsChecked == true && DeviceManager.ArduinoLampArray != null)
            {
                SetArduinoColor(args.NewColor);
                ArduinoStatusText.Text = $"Status: Live Preview ({args.NewColor.R}, {args.NewColor.G}, {args.NewColor.B})";
            }
        }

        private void LivePreviewArduinoToggle_Click(object sender, RoutedEventArgs e)
        {
            if (LivePreviewArduinoToggle.IsChecked == true && DeviceManager.ArduinoLampArray != null)
            {
                Windows.UI.Color c = ArduinoColorPicker.Color;
                SetArduinoColor(c);
                ArduinoStatusText.Text = $"Status: Live Preview enabled ({c.R}, {c.G}, {c.B})";
            }
        }
    }
}
