using System.Diagnostics;

namespace ZawSQL;

/// <summary>
/// Opens the UI in a chromeless "app mode" window of a Chromium-based browser, which makes it look
/// like a native desktop window. Falls back to the default browser when none is installed.
/// </summary>
public static class BrowserLauncher
{
    public static void Launch(string url, AppOptions o, ILogger log)
    {
        var profileDir = Path.Combine(o.ConfigDir, "browser");
        foreach (var exe in Candidates(o.Browser))
        {
            try
            {
                var psi = new ProcessStartInfo(exe) { UseShellExecute = false };
                psi.ArgumentList.Add($"--app={url}");
                // Snap-packaged Chromium can't write to hidden folders in $HOME, so let it use its own profile.
                if (!exe.Contains("/snap/", StringComparison.Ordinal))
                    psi.ArgumentList.Add($"--user-data-dir={profileDir}");
                psi.ArgumentList.Add("--no-first-run");
                psi.ArgumentList.Add("--no-default-browser-check");
                psi.ArgumentList.Add("--disable-features=Translate");
                psi.ArgumentList.Add("--window-size=1360,860");
                Process.Start(psi);
                return;
            }
            catch (Exception ex)
            {
                log.LogWarning("Could not start {Browser}: {Message}", exe, ex.Message);
            }
        }
        Console.WriteLine("No Chromium-based browser found; opening the default browser.");
        OpenDefault(url, log);
    }

    static IEnumerable<string> Candidates(string? custom)
    {
        if (!string.IsNullOrEmpty(custom)) yield return custom;

        if (OperatingSystem.IsWindows())
        {
            string?[] roots =
            [
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Environment.GetEnvironmentVariable("ProgramFiles"),
                Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
            ];
            string[] rel =
            [
                @"Google\Chrome\Application\chrome.exe",
                @"Microsoft\Edge\Application\msedge.exe",
                @"BraveSoftware\Brave-Browser\Application\brave.exe",
                @"Chromium\Application\chrome.exe",
            ];
            foreach (var r in rel)
                foreach (var root in roots)
                {
                    if (string.IsNullOrEmpty(root)) continue;
                    var p = Path.Combine(root, r);
                    if (File.Exists(p)) yield return p;
                }
        }
        else if (OperatingSystem.IsMacOS())
        {
            string[] apps =
            [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
                "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            ];
            foreach (var a in apps)
                if (File.Exists(a)) yield return a;
        }
        else
        {
            string[] names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser", "vivaldi"];
            foreach (var n in names)
            {
                var p = FindOnPath(n);
                if (p != null) yield return p;
            }
        }
    }

    static string? FindOnPath(string name)
    {
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var p = Path.Combine(dir, name);
            if (File.Exists(p)) return p;
        }
        return null;
    }

    static void OpenDefault(string url, ILogger log)
    {
        try
        {
            if (OperatingSystem.IsWindows()) Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            else if (OperatingSystem.IsMacOS()) Process.Start("open", url);
            else Process.Start("xdg-open", url);
        }
        catch (Exception ex)
        {
            log.LogWarning("Could not open a browser: {Message}. Open {Url} manually.", ex.Message, url);
        }
    }
}
