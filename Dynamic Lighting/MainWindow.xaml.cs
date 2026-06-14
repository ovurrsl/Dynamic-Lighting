using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Devices.Lights;
using System.Linq;

namespace Dynamic_Lighting
{
    public sealed partial class MainWindow : Window
    {
        public MainWindow()
        {
            this.InitializeComponent();

            // Setup Navigation
            NavView.SelectedItem = NavView.MenuItems.OfType<NavigationViewItem>().First();

            // Initialize hardware connections
            InitializeLighting();
        }

        private async void InitializeLighting()
        {
            // 1. Windows Dynamic Lighting (LampArray / Arduino)
            try
            {
                var deviceSelector = LampArray.GetDeviceSelector();
                var devices = await Windows.Devices.Enumeration.DeviceInformation.FindAllAsync(deviceSelector);
                if (devices.Count > 0)
                {
                    DeviceManager.ArduinoLampArray = await LampArray.FromIdAsync(devices[0].Id);
                }
            }
            catch { }

            // 2. ASUS & Corsair via DeviceManager (Offloaded to a background thread to prevent UI freezing, with a 4-second safety timeout)
            try
            {
                var connectTask = System.Threading.Tasks.Task.Run(() => DeviceManager.ConnectAll());
                var timeoutTask = System.Threading.Tasks.Task.Delay(4000);
                await System.Threading.Tasks.Task.WhenAny(connectTask, timeoutTask);
            }
            catch { }

            // 3. UI Transition: hide loading overlay and reveal main interface
            LoadingOverlay.Visibility = Visibility.Collapsed;
            ConnectingProgressRing.IsActive = false;
            NavView.Visibility = Visibility.Visible;

            // Navigate to Home initially
            ContentFrame.Navigate(typeof(Pages.HomePage));
        }

        private void NavView_SelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
        {
            var item = args.SelectedItem as NavigationViewItem;
            if (item == null) return;

            string? tag = item.Tag?.ToString();
            switch (tag)
            {
                case "Home":
                    ContentFrame.Navigate(typeof(Pages.HomePage));
                    break;
                case "Arduino":
                    ContentFrame.Navigate(typeof(Pages.ArduinoPage));
                    break;
                case "Asus":
                    ContentFrame.Navigate(typeof(Pages.AsusPage));
                    break;
                case "Corsair":
                    ContentFrame.Navigate(typeof(Pages.CorsairPage));
                    break;
            }
        }
    }
}
