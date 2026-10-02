using System.Security.Cryptography;

namespace ZawSQL;

public sealed class AppOptions
{
    public int Port { get; private set; }
    public bool NoBrowser { get; private set; }
    public bool KeepAlive { get; private set; }
    public bool ShowHelp { get; private set; }
    public string? Browser { get; private set; }
    public string ConfigDir { get; private set; } = DefaultConfigDir();
    public string Token { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(20)).ToLowerInvariant();

    public const string HelpText = """
        ZawSQL - MySQL / MariaDB client

        Usage: ZawSQL [options]
          --port <n>        Listen on this local port (default: a random free port)
          --no-browser      Don't open an app window; print the URL instead (implies --keep-alive)
          --keep-alive      Keep running after the last window is closed
          --browser <path>  Chromium-based browser used for the app window (Chrome, Edge, Chromium, Brave)
          --config <dir>    Configuration directory (saved sessions, UI state)
          -h, --help        Show this help
        """;

    public static AppOptions Parse(string[] args)
    {
        var o = new AppOptions();
        for (var i = 0; i < args.Length; i++)
        {
            string Next() => i + 1 < args.Length ? args[++i] : throw new ArgumentException($"Missing value for {args[i]}");
            switch (args[i])
            {
                case "--port": o.Port = int.Parse(Next()); break;
                case "--no-browser": o.NoBrowser = true; o.KeepAlive = true; break;
                case "--keep-alive": o.KeepAlive = true; break;
                case "--browser": o.Browser = Next(); break;
                case "--config": o.ConfigDir = Path.GetFullPath(Next()); break;
                case "-h" or "--help" or "/?": o.ShowHelp = true; break;
            }
        }
        return o;
    }

    static string DefaultConfigDir()
    {
        var baseDir = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        if (string.IsNullOrEmpty(baseDir))
            baseDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config");
        return Path.Combine(baseDir, "ZawSQL");
    }
}
