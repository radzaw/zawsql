using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace ZawSQL;

/// <summary>Who signed a file: the certificate subject (compared) and its common name (shown).</summary>
public sealed record Publisher(string Subject, string Name);

/// <summary>
/// Windows Authenticode: checks that an executable carries a valid signature that chains to a trusted root
/// (WinVerifyTrust, the same check Windows itself makes) and reports who signed it.
/// </summary>
public static class Authenticode
{
    /// <summary>The publisher of a validly signed file; null when the file is unsigned, tampered with or untrusted, or not on Windows.</summary>
    public static Publisher? SignerOf(string path)
    {
        if (!OperatingSystem.IsWindows() || !File.Exists(path)) return null;
        if (!IsTrusted(path)) return null;
        try
        {
#pragma warning disable SYSLIB0057 // there is no X509CertificateLoader equivalent for reading a signed file's certificate
            using var cert = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
#pragma warning restore SYSLIB0057
            return new Publisher(cert.Subject, cert.GetNameInfo(X509NameType.SimpleName, false));
        }
        catch (CryptographicException)
        {
            return null;
        }
    }

    [SupportedOSPlatform("windows")]
    static bool IsTrusted(string path)
    {
        var filePath = Marshal.StringToHGlobalUni(Path.GetFullPath(path));
        var fileInfo = Marshal.AllocHGlobal(Marshal.SizeOf<FileInfo>());
        try
        {
            Marshal.StructureToPtr(new FileInfo { cbStruct = (uint)Marshal.SizeOf<FileInfo>(), pcwszFilePath = filePath }, fileInfo, false);
            var data = new TrustData
            {
                cbStruct = (uint)Marshal.SizeOf<TrustData>(),
                dwUIChoice = 2,              // WTD_UI_NONE
                fdwRevocationChecks = 0,     // WTD_REVOKE_NONE: works offline; the signature is timestamped
                dwUnionChoice = 1,           // WTD_CHOICE_FILE
                pFile = fileInfo,
                dwStateAction = 1,           // WTD_STATEACTION_VERIFY
                dwProvFlags = 0x1000,        // WTD_CACHE_ONLY_URL_RETRIEVAL: no network
            };
            var result = WinVerifyTrust(new IntPtr(-1), GenericVerifyV2, ref data);
            data.dwStateAction = 2;          // WTD_STATEACTION_CLOSE
            WinVerifyTrust(new IntPtr(-1), GenericVerifyV2, ref data);
            return result == 0;
        }
        finally
        {
            Marshal.FreeHGlobal(fileInfo);
            Marshal.FreeHGlobal(filePath);
        }
    }

    static readonly Guid GenericVerifyV2 = new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE"); // WINTRUST_ACTION_GENERIC_VERIFY_V2

    [StructLayout(LayoutKind.Sequential)]
    struct FileInfo
    {
        public uint cbStruct;
        public IntPtr pcwszFilePath, hFile, pgKnownSubject;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct TrustData
    {
        public uint cbStruct;
        public IntPtr pPolicyCallbackData, pSIPClientData;
        public uint dwUIChoice, fdwRevocationChecks, dwUnionChoice;
        public IntPtr pFile;
        public uint dwStateAction;
        public IntPtr hWVTStateData, pwszURLReference;
        public uint dwProvFlags, dwUIContext;
        public IntPtr pSignatureSettings;
    }

    [DllImport("wintrust.dll", ExactSpelling = true)]
    static extern int WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid action, ref TrustData data);
}
