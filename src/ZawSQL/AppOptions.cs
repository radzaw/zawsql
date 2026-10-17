using System.Security.Cryptography;

namespace ZawSQL;

public sealed class AppOptions
{
    public int Port { get; private set; }
    public bool NoBrowser { get; private set; }
    public bool KeepAlive { get; private set; }
    /// <summary>Open the UI in a browser app window instead of the native window.</summary>
    public bool UseBrowser { get; private set; }
    public bool ShowHelp { get; private set; }
    /// <summary>
    /// Restarted after an update: wait for the port, and don't open a browser window (the existing one reloads).
    /// A native window closed with the previous process, so that one is opened again.
    /// </summary>
    public bool Attach { get; private set; }
    public string? Browser { get; private set; }
    public string ConfigDir { get; private set; } = DefaultConfigDir();
    public string Token { get; private set; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(20)).ToLowerInvariant();

    public const string HelpText = """
        ZawSQL - MySQL / MariaDB client

        Usage: ZawSQL [options]
          --port <n>        Listen on this local port (default: a random free port)
          --no-browser      Don't open a window; print the URL instead (implies --keep-alive)
          --use-browser     Use a browser app window instead of the native window
          --keep-alive      Keep running after the last browser window is closed
          --browser <path>  Chromium-based browser for the app window (implies --use-browser)
          --config <dir>    Configuration directory (saved sessions, UI state)
          --token <value>   Use a fixed API token instead of a random one (for automation and tests;
                            letters, digits, '-' and '_', at least 16 characters)
          -h, --help        Show this help
        """;

    /// <summary>
    /// Carries the token to the process an update starts. The environment, unlike the command line, isn't readable
    /// by other users of the machine.
    /// </summary>
    public const string TokenVariable = "ZAWSQL_TOKEN";

    public static AppOptions Parse(string[] args)
    {
        var inherited = Environment.GetEnvironmentVariable(TokenVariable);
        // Not passed on to the processes this one starts (the browser).
        if (inherited != null) Environment.SetEnvironmentVariable(TokenVariable, null);
        return Parse(args, inherited);
    }

    /// <summary>Parses the command line; <paramref name="inheritedToken"/> is the token from the previous version.</summary>
    public static AppOptions Parse(string[] args, string? inheritedToken)
    {
        var o = new AppOptions();
        if (!string.IsNullOrEmpty(inheritedToken)) o.Token = ValidToken(inheritedToken, TokenVariable);
        for (var i = 0; i < args.Length; i++)
        {
            string Next() => i + 1 < args.Length ? args[++i] : throw new ArgumentException($"Missing value for {args[i]}");
            switch (args[i])
            {
                case "--port": o.Port = int.Parse(Next()); break;
                case "--no-browser": o.NoBrowser = true; o.KeepAlive = true; break;
                case "--keep-alive": o.KeepAlive = true; break;
                case "--attach": o.Attach = true; break;
                case "--browser": o.Browser = Next(); o.UseBrowser = true; break;
                case "--use-browser": o.UseBrowser = true; break;
                case "--config": o.ConfigDir = Path.GetFullPath(Next()); break;
                case "--token": o.Token = ValidToken(Next(), "--token"); break;
                case "-h" or "--help" or "/?": o.ShowHelp = true; break;
            }
        }
        return o;
    }

    static string ValidToken(string token, string source) =>
        token.Length >= 16 && token.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_')
            ? token
            : throw new ArgumentException($"{source} must be at least 16 characters of letters, digits, '-' or '_'.");

    /// <summary>The native window isn't available: a browser window is used, also after an update restart.</summary>
    public void FallBackToBrowser() => UseBrowser = true;

    static string DefaultConfigDir()
    {
        var baseDir = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        if (string.IsNullOrEmpty(baseDir))
            baseDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config");
        return Path.Combine(baseDir, "ZawSQL");
    }
}
