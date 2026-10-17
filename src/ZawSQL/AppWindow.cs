using System.Diagnostics;
using System.Runtime.InteropServices;
using Photino.NET;

namespace ZawSQL;

/// <summary>
/// The native app window: the UI in the operating system's web view (WebView2 on Windows, WKWebView on macOS,
/// WebKitGTK on Linux) through Photino. The window has to run on the process's main thread, which on Windows must
/// be an STA thread.
/// </summary>
public sealed class AppWindow(AppOptions opts, ILogger<AppWindow> log)
{
    PhotinoWindow? window;
    volatile bool open;
    // Set once the window exists: a failure after that is a real error, not a missing web view.
    volatile bool created;
    // Closing asks the page first (it saves its state and asks about open transactions), unless this is set.
    volatile bool closeAllowed;
    // The page said it handles close requests; until then (still loading, or broken) the window just closes.
    volatile bool pageReady;
    DateTime closeAskedAt;

    /// <summary>
    /// Shows the window and blocks until it's closed. Returns false, having shown nothing, when the platform's
    /// web view isn't available (for example WebKitGTK missing on Linux); the caller then uses a browser window.
    /// </summary>
    public bool Run(string url, IHostApplicationLifetime life)
    {
        // Without a display GTK ends the process instead of failing, so don't even try (e.g. over SSH).
        if (OperatingSystem.IsLinux() && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("DISPLAY"))
            && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("WAYLAND_DISPLAY")))
        {
            log.LogWarning("No display found; using a browser window.");
            return false;
        }
        try
        {
            var w = new PhotinoWindow()
                .SetLogVerbosity(0)
                .SetTitle("ZawSQL")
                .SetUseOsDefaultSize(false)
                .SetSize(1360, 860)
                .SetMinSize(760, 520)
                .Center()
                .SetDevToolsEnabled(false)
                .SetTemporaryFilesPath(Path.Combine(opts.ConfigDir, "webview"));
            if (IconFile() is { } icon) w.SetIconFile(icon);
            w.WindowCreated += (_, _) =>
            {
                created = open = true;
                // The host began stopping before the window existed (Ctrl+C during startup): don't outlive it.
                if (closeAllowed)
                {
                    Close();
                    return;
                }
                // Smaller screens: start maximized rather than hanging off the edge.
                try
                {
                    var area = w.MainMonitor.WorkArea;
                    if (area.Width < 1360 || area.Height < 860) w.SetMaximized(true);
                }
                catch (Exception ex) when (ex is ApplicationException or InvalidOperationException) { /* keep the default size */ }
            };
            w.RegisterWindowClosingHandler((_, _) => KeepOpen(w));
            w.RegisterWebMessageReceivedHandler((_, message) => OnMessage(w, message));
            w.Load(new Uri(url));
            window = w;

            // File > Exit and installing an update stop the host; take the window down with it.
            using var reg = life.ApplicationStopping.Register(Close);
            w.WaitForClose();
            return true;
        }
        catch (Exception ex) when (!created)
        {
            log.LogWarning("The native window is not available ({Message}); using a browser window.", Reason(ex));
            return false;
        }
        finally
        {
            open = false;
        }
    }

    /// <summary>A short reason: the loader's message lists every path it tried.</summary>
    static string Reason(Exception ex)
    {
        var m = (ex.InnerException ?? ex).Message;
        if (OperatingSystem.IsLinux() && ex.GetBaseException() is DllNotFoundException)
        {
            var missing = System.Text.RegularExpressions.Regex.Match(m, @"(lib[\w.+-]+\.so[.\d]*): cannot open");
            return missing.Success
                ? $"{missing.Groups[1].Value} is missing; install WebKitGTK 4.1 and libnotify (libwebkit2gtk-4.1-0 and libnotify4 on Debian and Ubuntu)"
                : "Photino.Native could not be loaded";
        }
        return m.Length > 300 ? m[..300] + "…" : m;
    }

    /// <summary>
    /// The window's close button: the web view doesn't run beforeunload, so the page is asked instead. It saves its
    /// state, asks about open transactions and answers "close". A second click after a few seconds closes anyway,
    /// in case the page is stuck.
    /// </summary>
    bool KeepOpen(PhotinoWindow w)
    {
        if (closeAllowed || !pageReady) return false;
        if (closeAskedAt != default && DateTime.UtcNow - closeAskedAt > TimeSpan.FromSeconds(5)) return false;
        closeAskedAt = DateTime.UtcNow;
        try { w.SendWebMessage("close-request"); }
        catch (ApplicationException) { return false; }
        return true;
    }

    void Close()
    {
        closeAllowed = true;
        if (!open || window == null) return;
        open = false;
        try { window.Close(); }
        catch (ApplicationException) { /* not created yet or already gone */ }
    }

    /// <summary>
    /// Messages from the page: "ready" (it handles close requests), "close" (it agreed to close), "close-cancel"
    /// (the user kept the window), "theme:dark" / "theme:light" (the title bar follows the app's theme) and
    /// "open:&lt;url&gt;" (a web page for the default browser, not a web view popup).
    /// </summary>
    void OnMessage(PhotinoWindow w, string? message)
    {
        switch (message)
        {
            case "ready": pageReady = true; break;
            case "close": Close(); break;
            case "close-cancel": closeAskedAt = default; break;
            case "theme:dark" or "theme:light" when OperatingSystem.IsWindows():
                DarkTitleBar(w.WindowHandle, message == "theme:dark");
                break;
            case not null when message.StartsWith("open:", StringComparison.Ordinal):
                OpenInBrowser(message[5..]);
                break;
        }
    }

    void OpenInBrowser(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http")) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            log.LogWarning("Could not open {Url}: {Message}", uri, ex.Message);
        }
    }

    /// <summary>The window icon as a file (Photino loads it from disk): .ico on Windows, .png elsewhere.</summary>
    string? IconFile()
    {
        var resource = OperatingSystem.IsWindows() ? "zawsql.ico" : "wwwroot/icon-256.png";
        var asm = typeof(AppWindow).Assembly;
        var name = asm.GetManifestResourceNames().FirstOrDefault(n => n.EndsWith(Path.GetFileName(resource), StringComparison.OrdinalIgnoreCase));
        if (name == null) return null;
        try
        {
            var dir = Path.Combine(opts.ConfigDir, "webview");
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, Path.GetFileName(resource));
            using var src = asm.GetManifestResourceStream(name)!;
            using var ms = new MemoryStream();
            src.CopyTo(ms);
            if (!File.Exists(path) || new FileInfo(path).Length != ms.Length) File.WriteAllBytes(path, ms.ToArray());
            return path;
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    static void DarkTitleBar(IntPtr hwnd, bool dark)
    {
        if (hwnd == IntPtr.Zero) return;
        var on = dark ? 1 : 0;
        try { DwmSetWindowAttribute(hwnd, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref on, sizeof(int)); }
        catch (EntryPointNotFoundException) { /* Windows 10 before 20H1 */ }
    }
}
