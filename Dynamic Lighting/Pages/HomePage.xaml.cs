using System;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Dynamic_Lighting.Pages
{
    public sealed partial class HomePage : Page
    {
        private readonly ColorPicker GlobalColorPicker;
        private bool _isInitializing = true;

        public HomePage()
        {
            this.InitializeComponent();
            GlobalColorPicker = ColorPickerFactory.CreateDefaultColorPicker();
            GlobalColorPicker.ColorChanged += GlobalColorPicker_ColorChanged;
            ColorPickerFactory.AttachToHost(GlobalColorPickerHost, GlobalColorPicker);

            // Load and apply settings
            LoadSettings();

            // Subscribe to real-time color updates for the Fluent glow visualizer
            AnimationManager.OnColorUpdated += AnimationManager_OnColorUpdated;

            this.Unloaded += HomePage_Unloaded;
            
            _isInitializing = false;

            // Trigger initial state application
            ApplyActiveConfiguration(saveToDisk: false);
        }

        private void HomePage_Unloaded(object sender, RoutedEventArgs e)
        {
            // Unsubscribe from events to prevent memory leaks
            AnimationManager.OnColorUpdated -= AnimationManager_OnColorUpdated;
        }

        private void LoadSettings()
        {
            var settings = SettingsManager.Load();

            // Apply to UI controls
            TargetDeviceComboBox.SelectedIndex = Math.Clamp(settings.TargetDeviceIndex, 0, 3);
            
            // Mode mapping
            if (Enum.TryParse<LightingMode>(settings.Mode, out var mode))
            {
                ModeComboBox.SelectedIndex = (int)mode;
            }
            else
            {
                ModeComboBox.SelectedIndex = 0;
            }

            // Color mapping
            GlobalColorPicker.Color = Windows.UI.Color.FromArgb(255, settings.ColorR, settings.ColorG, settings.ColorB);

            // Speed mapping
            SpeedSlider.Value = Math.Clamp(settings.Speed, 0.1, 5.0);
            SpeedTextValue.Text = $"{SpeedSlider.Value:F1}x";

            // Live Preview mapping
            LivePreviewToggle.IsChecked = settings.LivePreview;

            UpdateUIStateForMode((LightingMode)ModeComboBox.SelectedIndex);
        }

        private void SaveCurrentSettingsToDisk()
        {
            var settings = new AppSettings
            {
                TargetDeviceIndex = TargetDeviceComboBox.SelectedIndex,
                Mode = ((LightingMode)ModeComboBox.SelectedIndex).ToString(),
                ColorR = GlobalColorPicker.Color.R,
                ColorG = GlobalColorPicker.Color.G,
                ColorB = GlobalColorPicker.Color.B,
                Speed = SpeedSlider.Value,
                LivePreview = LivePreviewToggle.IsChecked == true
            };

            SettingsManager.Save(settings);
        }

        private void ApplyActiveConfiguration(bool saveToDisk)
        {
            if (_isInitializing) return;

            var mode = (LightingMode)ModeComboBox.SelectedIndex;
            var targetIndex = TargetDeviceComboBox.SelectedIndex;
            var color = GlobalColorPicker.Color;
            var speed = SpeedSlider.Value;

            // Update parameters inside the background animation engine
            AnimationManager.UpdateMode(mode, color, speed, targetIndex);

            // Update parameters card visibility based on the effect
            UpdateUIStateForMode(mode);

            // Update status text
            if (mode == LightingMode.Static)
            {
                StatusText.Text = $"Synced static color ({color.R}, {color.G}, {color.B}) to target.";
                StatusIcon.Visibility = Visibility.Visible;
                StatusProgressRing.IsActive = false;
            }
            else
            {
                StatusText.Text = $"Synchronizing dynamic {mode} effect at {speed:F1}x speed...";
                StatusIcon.Visibility = Visibility.Collapsed;
                StatusProgressRing.IsActive = true;
            }

            if (saveToDisk)
            {
                SaveCurrentSettingsToDisk();
            }
        }

        private void UpdateUIStateForMode(LightingMode mode)
        {
            if (ParametersCard == null || ColorPickerContainer == null || GlobalColorPicker == null) return;

            if (mode == LightingMode.Static)
            {
                ParametersCard.Visibility = Visibility.Collapsed;
                ColorPickerContainer.Opacity = 1.0;
                ColorPickerContainer.IsHitTestVisible = true;
                GlobalColorPicker.IsEnabled = true;
            }
            else if (mode == LightingMode.Breathing || mode == LightingMode.AudioReactive)
            {
                ParametersCard.Visibility = Visibility.Visible;
                ColorPickerContainer.Opacity = 1.0;
                ColorPickerContainer.IsHitTestVisible = true;
                GlobalColorPicker.IsEnabled = true;
            }
            else if (mode == LightingMode.Rainbow)
            {
                ParametersCard.Visibility = Visibility.Visible;
                // Hue spectrum is animated; disable color picker input
                ColorPickerContainer.Opacity = 0.4;
                ColorPickerContainer.IsHitTestVisible = false;
                GlobalColorPicker.IsEnabled = false;
            }
        }

        private void AnimationManager_OnColorUpdated(Windows.UI.Color color)
        {
            // Marshal thread execution to UI thread to update the preview indicators safely
            DispatcherQueue.TryEnqueue(() =>
            {
                var brush = new SolidColorBrush(color);
                
                if (VisualizerOuterGlow != null) VisualizerOuterGlow.Fill = brush;
                if (VisualizerMediumGlow != null) VisualizerMediumGlow.Fill = brush;
                if (VisualizerCore != null) VisualizerCore.Fill = brush;
            });
        }

        private void TargetDeviceComboBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            ApplyActiveConfiguration(saveToDisk: !_isInitializing);
        }

        private void ModeComboBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            ApplyActiveConfiguration(saveToDisk: !_isInitializing);
        }

        private void SpeedSlider_ValueChanged(object sender, Microsoft.UI.Xaml.Controls.Primitives.RangeBaseValueChangedEventArgs e)
        {
            if (SpeedTextValue != null)
            {
                SpeedTextValue.Text = $"{e.NewValue:F1}x";
            }
            ApplyActiveConfiguration(saveToDisk: !_isInitializing);
        }

        private void GlobalColorPicker_ColorChanged(object sender, Microsoft.UI.Xaml.Controls.ColorChangedEventArgs args)
        {
            if (LivePreviewToggle.IsChecked == true)
            {
                // Update live hardware color, but skip continuous heavy disk write for CPU optimization
                ApplyActiveConfiguration(saveToDisk: false);
            }
        }

        private void ApplyColorButton_Click(object sender, RoutedEventArgs e)
        {
            // Explicitly apply and persist configuration to JSON profile
            ApplyActiveConfiguration(saveToDisk: true);
            StatusText.Text = "Settings applied and successfully saved to JSON profile!";
        }

        private void LivePreviewToggle_Click(object sender, RoutedEventArgs e)
        {
            if (LivePreviewToggle.IsChecked == true)
            {
                ApplyActiveConfiguration(saveToDisk: !_isInitializing);
            }
        }
    }
}
