using System.Security.Cryptography;

namespace ZawSQL;

public sealed class AppOptions
{
    public int Port { get; private set; }
    public bool NoBrowser { get; private set; }
    public bool KeepAlive { get; private set; }
    public bool ShowHelp { get; private set; }
    /// <summary>Restarted after an update: don't open a window (the existing one reloads) and wait for the port.</summary>
    public bool Attach { get; private set; }
    public string? Browser { get; private set; }
    public string ConfigDir { get; private set; } = DefaultConfigDir();
    public string Token { get; private set; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(20)).ToLowerInvariant();

    public const string HelpText = """
        ZawSQL - MySQL / MariaDB client

        Usage: ZawSQL [options]
          --port <n>        Listen on this local port (default: a random free port)
          --no-browser      Don't open an app window; print the URL instead (implies --keep-alive)
          --keep-alive      Keep running after the last window is closed
          --browser <path>  Chromium-based browser used for the app window (Chrome, Edge, Chromium, Brave)
          --config <dir>    Configuration directory (saved sessions, UI state)
          --token <value>   Use a fixed API token instead of a random one (for automation and tests;
                            letters, digits, '-' and '_', at least 16 characters)
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
                case "--attach": o.Attach = true; break;
                case "--browser": o.Browser = Next(); break;
                case "--config": o.ConfigDir = Path.GetFullPath(Next()); break;
                case "--token":
                    o.Token = Next();
                    if (o.Token.Length < 16 || !o.Token.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_'))
                        throw new ArgumentException("--token must be at least 16 characters of letters, digits, '-' or '_'.");
                    break;
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
