namespace Dynamic_Lighting
{
    public interface IAuraController
    {
        bool Connect();
        void Disconnect();
        bool IsConnected { get; }
        string? DevicePath { get; }
        void SetColor(byte red, byte green, byte blue, int ledCount = 120);
    }
}
