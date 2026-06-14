using System;
using Windows.Devices.Lights;

namespace Dynamic_Lighting
{
    public static class DeviceManager
    {
        public static IAuraController? AuraController { get; set; }
        public static CorsairICueLinkController? CorsairController { get; set; }
        public static LampArray? ArduinoLampArray { get; set; }

        public static void ConnectAll()
        {
            // Connect ASUS Aura
            if (AuraController == null || !AuraController.IsConnected)
            {
                var mainboardCtrl = new AuraMainboardController();
                if (mainboardCtrl.Connect())
                {
                    AuraController = mainboardCtrl;
                }
            }

            // Connect Corsair
            if (CorsairController == null || !CorsairController.IsConnected)
            {
                var corsair = new CorsairICueLinkController();
                if (corsair.Connect())
                {
                    CorsairController = corsair;
                }
            }
        }

        public static void DisconnectAll()
        {
            if (AuraController != null)
            {
                AuraController.Disconnect();
                AuraController = null;
            }

            if (CorsairController != null)
            {
                CorsairController.Disconnect();
                CorsairController = null;
            }
            
            // Arduino LampArray doesn't need explicit disconnect here 
            // as it's managed by Windows.Devices.Lights, but we clear ref.
            ArduinoLampArray = null; 
        }
    }
}
