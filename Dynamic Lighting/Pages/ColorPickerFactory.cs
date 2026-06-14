using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Dynamic_Lighting.Pages
{
    internal static class ColorPickerFactory
    {
        private static readonly Color[] PaletteColors =
        {
            Colors.Red,
            Colors.Orange,
            Colors.Yellow,
            Colors.Lime,
            Colors.DeepSkyBlue,
            Colors.Blue,
            Colors.Magenta,
            Colors.White,
            Color.FromArgb(255, 255, 64, 64),
            Color.FromArgb(255, 255, 128, 0),
            Color.FromArgb(255, 0, 255, 128),
            Color.FromArgb(255, 0, 180, 255),
            Color.FromArgb(255, 128, 64, 255),
            Color.FromArgb(255, 255, 0, 128),
            Colors.Cyan,
            Colors.Black,
        };

        public static ColorPicker CreateDefaultColorPicker()
        {
            return new ColorPicker
            {
                HorizontalAlignment = HorizontalAlignment.Center,
                ColorSpectrumShape = ColorSpectrumShape.Ring,
                IsAlphaEnabled = false,
                IsAlphaSliderVisible = false,
                IsColorChannelTextInputVisible = true,
                IsColorSliderVisible = true,
                IsColorSpectrumVisible = true,
            };
        }

        public static void AttachToHost(Panel host, ColorPicker picker)
        {
            var container = new StackPanel
            {
                HorizontalAlignment = HorizontalAlignment.Center,
                Spacing = 10,
            };

            container.Children.Add(picker);
            container.Children.Add(CreatePalette(picker));

            host.Children.Clear();
            host.Children.Add(container);
        }

        private static Grid CreatePalette(ColorPicker picker)
        {
            var palette = new Grid
            {
                ColumnSpacing = 6,
                RowSpacing = 6,
                HorizontalAlignment = HorizontalAlignment.Center,
            };

            for (var column = 0; column < 8; column++)
            {
                palette.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            }

            for (var row = 0; row < 2; row++)
            {
                palette.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            }

            for (var index = 0; index < PaletteColors.Length; index++)
            {
                var color = PaletteColors[index];
                var swatch = new Button
                {
                    Width = 28,
                    Height = 28,
                    MinWidth = 0,
                    MinHeight = 0,
                    Padding = new Thickness(0),
                    Background = new SolidColorBrush(color),
                    BorderBrush = new SolidColorBrush(Colors.Gray),
                    BorderThickness = new Thickness(1),
                    Tag = color,
                };

                ToolTipService.SetToolTip(swatch, ToHex(color));
                AutomationProperties.SetName(swatch, $"Color {ToHex(color)}");
                swatch.Click += (_, _) => picker.Color = (Color)swatch.Tag;

                Grid.SetColumn(swatch, index % 8);
                Grid.SetRow(swatch, index / 8);
                palette.Children.Add(swatch);
            }

            return palette;
        }

        private static string ToHex(Color color)
        {
            return $"#{color.R:X2}{color.G:X2}{color.B:X2}";
        }
    }
}
