using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ZawSQL;

/// <summary>
/// Self-update from GitHub Releases: finds the latest release, downloads the executable for this platform
/// (zawsql-&lt;rid&gt;[.exe]) next to the running one, checks it against the release's SHA256SUMS, swaps it in and
/// restarts on the same port and token so the open window just reloads.
/// </summary>
public sealed partial class Updater(AppOptions opts)
{
    public const string DefaultSource = "https://api.github.com/repos/radzaw/zawsql/releases/latest";

    /// <summary>Release API URL; ZAWSQL_UPDATE_URL overrides it (tests, mirrors).</summary>
    public static string Source => Environment.GetEnvironmentVariable("ZAWSQL_UPDATE_URL") is { Length: > 0 } u ? u : DefaultSource;

    public static string CurrentVersion
    {
        get
        {
            var v = typeof(Updater).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";
            var plus = v.IndexOf('+');
            return plus >= 0 ? v[..plus] : v;
        }
    }

    public static string Rid => RuntimeInformation.RuntimeIdentifier;

    public static string AssetName(string rid) => $"zawsql-{rid}{(rid.StartsWith("win", StringComparison.Ordinal) ? ".exe" : "")}";

    static readonly HttpClient Http = CreateClient();

    static HttpClient CreateClient()
    {
        var c = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        c.DefaultRequestHeaders.UserAgent.ParseAdd($"ZawSQL/{CurrentVersion}");
        c.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return c;
    }

    readonly object gate = new();
    Release? latest;
    string state = "idle"; // idle | downloading | ready | error
    long received, total;
    string? error, downloaded, downloadSigner;
    Task? downloadTask;

    public sealed record Asset(string Name, string Url, long Size);
    public sealed record Release(string Tag, string Version, string? Name, string? Notes, string? Page, string? Published, List<Asset> Assets);

    // ---------------------------------------------------------------- pure helpers

    [GeneratedRegex(@"^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?")]
    private static partial Regex VersionRe();

    /// <summary>Compares versions like 1.2.3, v1.10.0, 2.0.0-beta.1 (a pre-release sorts before its release).</summary>
    public static int CompareVersions(string a, string b)
    {
        var ma = VersionRe().Match(a.Trim());
        var mb = VersionRe().Match(b.Trim());
        if (!ma.Success || !mb.Success) return string.CompareOrdinal(a, b);
        for (var i = 1; i <= 4; i++)
        {
            var x = ma.Groups[i].Success ? long.Parse(ma.Groups[i].Value) : 0;
            var y = mb.Groups[i].Success ? long.Parse(mb.Groups[i].Value) : 0;
            if (x != y) return x.CompareTo(y);
        }
        var pa = ma.Groups[5].Success ? ma.Groups[5].Value : null;
        var pb = mb.Groups[5].Success ? mb.Groups[5].Value : null;
        if (pa == pb) return 0;
        if (pa == null) return 1;
        if (pb == null) return -1;
        return string.CompareOrdinal(pa, pb);
    }

    /// <summary>"&lt;sha256&gt;  &lt;file&gt;" lines (sha256sum format, also with "*" for binary mode) → file → lower-case hash.</summary>
    public static Dictionary<string, string> ParseChecksums(string text)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var line in text.Split('\n'))
        {
            var m = Regex.Match(line.Trim(), @"^([0-9a-fA-F]{64})\s+\*?(.+)$");
            if (m.Success) map[m.Groups[2].Value.Trim()] = m.Groups[1].Value.ToLowerInvariant();
        }
        return map;
    }

    public static Release ParseRelease(JsonElement r) => new(
        Tag: r.GetProperty("tag_name").GetString() ?? "",
        Version: (r.GetProperty("tag_name").GetString() ?? "").TrimStart('v', 'V'),
        Name: r.TryGetProperty("name", out var n) ? n.GetString() : null,
        Notes: r.TryGetProperty("body", out var b) ? b.GetString() : null,
        Page: r.TryGetProperty("html_url", out var u) ? u.GetString() : null,
        Published: r.TryGetProperty("published_at", out var p) ? p.GetString() : null,
        Assets: r.TryGetProperty("assets", out var a)
            ? a.EnumerateArray().Select(x => new Asset(x.GetProperty("name").GetString() ?? "", x.GetProperty("browser_download_url").GetString() ?? "", x.TryGetProperty("size", out var s) ? s.GetInt64() : 0)).ToList()
            : []);

    /// <summary>Where the verified download waits: "ZawSQL.update" / "ZawSQL.update.exe" next to the executable.</summary>
    public static string UpdateFilePath(string exePath) =>
        Path.Combine(Path.GetDirectoryName(exePath)!, Path.GetFileNameWithoutExtension(exePath) + ".update" + Path.GetExtension(exePath));

    static void MakeExecutable(string path)
    {
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead
                | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
    }

    /// <summary>
    /// Replaces the (no longer running) executable with <paramref name="newFile"/>; the previous one is kept as
    /// "&lt;exe&gt;.old" until the next start, and put back if the copy fails.
    /// </summary>
    public static void ReplaceExecutable(string exePath, string newFile)
    {
        var old = exePath + ".old";
        if (File.Exists(old)) File.Delete(old);
        File.Move(exePath, old);
        try
        {
            File.Copy(newFile, exePath);
            MakeExecutable(exePath);
        }
        catch
        {
            if (File.Exists(exePath)) File.Delete(exePath);
            File.Move(old, exePath);
            throw;
        }
    }

    /// <summary>
    /// Helper mode of the downloaded executable ("--apply-update &lt;exe&gt; --parent &lt;pid&gt; -- &lt;args&gt;"): waits for
    /// the old process to exit, copies itself over the executable and starts it with the given arguments. A single-file
    /// app loads its assemblies lazily from its own file, so no process may replace the file it runs from; this
    /// helper runs from the download instead.
    /// </summary>
    public static int ApplyUpdate(string[] args)
    {
        var exe = args[1];
        var pid = int.Parse(args[3], System.Globalization.CultureInfo.InvariantCulture);
        var rest = args.SkipWhile(a => a != "--").Skip(1).ToArray();
        try
        {
            using var parent = Process.GetProcessById(pid);
            parent.WaitForExit(30_000);
        }
        catch (ArgumentException) { /* already gone */ }

        var self = Environment.ProcessPath!;
        Exception? last = null;
        for (var attempt = 0; attempt < 40; attempt++)
        {
            try
            {
                ReplaceExecutable(exe, self);
                last = null;
                break;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                last = ex; // Windows may hold the old file a moment longer
                Thread.Sleep(250);
            }
        }
        if (last != null) Console.Error.WriteLine($"ZawSQL: the update could not be installed: {last.Message}");
        var psi = new ProcessStartInfo(exe) { UseShellExecute = false };
        foreach (var a in rest) psi.ArgumentList.Add(a);
        Process.Start(psi);
        return last == null ? 0 : 1;
    }

    /// <summary>
    /// Removes "&lt;exe&gt;.old" and the update file left by an earlier update. The helper that started this process may
    /// still be running from the update file for a moment, so this retries in the background.
    /// </summary>
    public static void CleanupLeftovers(string? exePath)
    {
        if (string.IsNullOrEmpty(exePath)) return;
        var files = new[] { exePath + ".old", UpdateFilePath(exePath) };
        _ = Task.Run(async () =>
        {
            for (var attempt = 0; attempt < 40; attempt++)
            {
                var left = 0;
                foreach (var f in files)
                {
                    try { if (File.Exists(f)) File.Delete(f); }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { left++; }
                }
                if (left == 0) return;
                await Task.Delay(500);
            }
        });
    }

    // ---------------------------------------------------------------- this process

    public static string? ExePath => Environment.ProcessPath;

    /// <summary>Who signed this running copy (Windows only); the file can't change while it runs, so checked once.</summary>
    static readonly Lazy<Publisher?> OwnSigner = new(() => ExePath is { } exe ? Authenticode.SignerOf(exe) : null);

    /// <summary>Whether this process can replace its own executable, and why not.</summary>
    public static (bool ok, string? reason) CanInstall(string? exePath = null)
    {
        exePath ??= ExePath;
        // A single-file publish has no assembly path; `dotnet run` and test hosts run ZawSQL.dll through dotnet.
#pragma warning disable IL3000 // an empty Location is exactly what identifies the single-file build
        var fromSource = !string.IsNullOrEmpty(typeof(Updater).Assembly.Location);
#pragma warning restore IL3000
        if (fromSource || exePath == null
            || !Path.GetFileNameWithoutExtension(exePath).StartsWith("zawsql", StringComparison.OrdinalIgnoreCase))
            return (false, "This copy runs from source (dotnet run); updates install only into a published ZawSQL executable.");
        var dir = Path.GetDirectoryName(exePath)!;
        try
        {
            var probe = Path.Combine(dir, $".zawsql-write-test-{Environment.ProcessId}");
            File.WriteAllBytes(probe, []);
            File.Delete(probe);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return (false, $"The folder {dir} isn't writable for this user, so the update can't be installed here. Download it from the release page instead.");
        }
        return (true, null);
    }

    public object Version() => new
    {
        version = CurrentVersion, rid = Rid, canInstall = CanInstall().ok, reason = CanInstall().reason, source = Source,
        signer = OwnSigner.Value?.Name,
    };

    /// <summary>The release list next to the source ("…/releases/latest" → "…/releases"); null for other feeds.</summary>
    public static string? ListSource => Source.EndsWith("/releases/latest", StringComparison.Ordinal) ? Source[..^"/latest".Length] + "?per_page=50" : null;

    /// <summary>
    /// Release notes for "What's new": every published release after <paramref name="since"/> up to the running
    /// version, newest first; without <paramref name="since"/> just the running version's. Pre-releases count only
    /// when this copy is one.
    /// </summary>
    public async Task<object> NotesAsync(string? since, CancellationToken ct)
    {
        var list = ListSource ?? throw new ApiException("This update source has no release list.");
        using var res = await Http.GetAsync(list, ct);
        if (res.StatusCode == System.Net.HttpStatusCode.NotFound) throw new ApiException("No release has been published yet.");
        if ((int)res.StatusCode == 403) throw new ApiException("GitHub refused the request (rate limit). Try again later.");
        res.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
        var current = CurrentVersion;
        var pre = current.Contains('-');
        static bool Flag(JsonElement r, string name) => r.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
        var releases = doc.RootElement.EnumerateArray()
            .Where(r => !Flag(r, "draft") && (pre || !Flag(r, "prerelease")))
            .Select(ParseRelease)
            .Where(r => CompareVersions(r.Version, current) <= 0
                && (since == null ? CompareVersions(r.Version, current) == 0 : CompareVersions(r.Version, since) > 0))
            .OrderByDescending(r => r.Version, Comparer<string>.Create(CompareVersions))
            .Take(20)
            .Select(r => new { version = r.Version, name = r.Name, notes = r.Notes, page = r.Page, published = r.Published })
            .ToList();
        return new { current, since, releases };
    }

    public async Task<object> CheckAsync(CancellationToken ct)
    {
        using var res = await Http.GetAsync(Source, ct);
        if (res.StatusCode == System.Net.HttpStatusCode.NotFound) throw new ApiException("No release has been published yet.");
        if ((int)res.StatusCode == 403) throw new ApiException("GitHub refused the update check (rate limit). Try again later.");
        res.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
        var rel = ParseRelease(doc.RootElement);
        lock (gate) latest = rel;
        var asset = rel.Assets.FirstOrDefault(a => a.Name == AssetName(Rid));
        var (ok, reason) = CanInstall();
        if (ok && asset == null) (ok, reason) = (false, $"This release has no build for {Rid}.");
        return new
        {
            current = CurrentVersion,
            latest = rel.Version,
            newer = CompareVersions(rel.Version, CurrentVersion) > 0,
            name = rel.Name,
            notes = rel.Notes,
            page = rel.Page,
            published = rel.Published,
            asset = asset == null ? null : new { asset.Name, asset.Size },
            canInstall = ok,
            reason,
        };
    }

    /// <summary>Starts downloading the latest release's executable (after a check); progress via <see cref="Status"/>.</summary>
    public object StartDownload()
    {
        lock (gate)
        {
            if (state == "downloading") return Status();
            var rel = latest ?? throw new ApiException("Check for updates first.");
            if (CompareVersions(rel.Version, CurrentVersion) <= 0) throw new ApiException($"ZawSQL {CurrentVersion} is up to date.");
            var (ok, reason) = CanInstall();
            if (!ok) throw new ApiException(reason!);
            var asset = rel.Assets.FirstOrDefault(a => a.Name == AssetName(Rid)) ?? throw new ApiException($"This release has no build for {Rid}.");
            var sums = rel.Assets.FirstOrDefault(a => a.Name == "SHA256SUMS") ?? throw new ApiException("The release has no SHA256SUMS file, so the download can't be verified.");
            (state, received, total, error, downloaded) = ("downloading", 0, asset.Size, null, null);
            downloadTask = Task.Run(() => DownloadAsync(rel, asset, sums));
            return Status();
        }
    }

    static void CheckUrl(string url)
    {
        var u = new Uri(url);
        // Releases are fetched over HTTPS. Plain HTTP only from this machine, or from an explicitly configured
        // update source (ZAWSQL_UPDATE_URL, for tests and private mirrors).
        var overridden = Environment.GetEnvironmentVariable("ZAWSQL_UPDATE_URL") is { Length: > 0 };
        if (u.Scheme == Uri.UriSchemeHttps || (u.Scheme == Uri.UriSchemeHttp && (u.IsLoopback || overridden))) return;
        throw new ApiException($"Refusing to download over an insecure connection: {url}");
    }

    /// <summary>
    /// Downloads <paramref name="assetUrl"/> to <paramref name="target"/> and checks it against the SHA-256 that
    /// <paramref name="sumsUrl"/> (a sha256sum file) lists for <paramref name="assetName"/>. On any failure the
    /// partial file is removed and an exception explains why.
    /// </summary>
    public static async Task DownloadVerifiedAsync(HttpClient http, string assetUrl, string sumsUrl, string assetName, string target,
        Action<long?, long>? progress = null, CancellationToken ct = default)
    {
        try
        {
            CheckUrl(assetUrl);
            CheckUrl(sumsUrl);
            var expected = ParseChecksums(await http.GetStringAsync(sumsUrl, ct)).GetValueOrDefault(assetName)
                ?? throw new ApiException($"SHA256SUMS lists no checksum for {assetName}, so the download can't be verified.");
            using var res = await http.GetAsync(assetUrl, HttpCompletionOption.ResponseHeadersRead, ct);
            res.EnsureSuccessStatusCode();
            var length = res.Content.Headers.ContentLength;
            using var sha = SHA256.Create();
            long received = 0;
            await using (var src = await res.Content.ReadAsStreamAsync(ct))
            await using (var dst = File.Create(target))
            {
                var buf = new byte[81920];
                int n;
                while ((n = await src.ReadAsync(buf, ct)) > 0)
                {
                    await dst.WriteAsync(buf.AsMemory(0, n), ct);
                    sha.TransformBlock(buf, 0, n, null, 0);
                    received += n;
                    progress?.Invoke(length, received);
                }
            }
            sha.TransformFinalBlock([], 0, 0);
            var actual = Convert.ToHexString(sha.Hash!).ToLowerInvariant();
            if (actual != expected)
                throw new ApiException($"The download doesn't match its published checksum (expected {expected[..12]}…, got {actual[..12]}…). Nothing was changed.");
        }
        catch
        {
            try { if (File.Exists(target)) File.Delete(target); } catch (IOException) { }
            throw;
        }
    }

    async Task DownloadAsync(Release rel, Asset asset, Asset sums)
    {
        var target = UpdateFilePath(ExePath!);
        try
        {
            await DownloadVerifiedAsync(Http, asset.Url, sums.Url, asset.Name, target, (len, got) =>
            {
                lock (gate) { if (len is { } l) total = l; received = got; }
            });
            var signer = VerifyPublisher(target);
            lock (gate) (state, downloaded, downloadSigner) = ("ready", target, signer?.Name);
        }
        catch (Exception ex)
        {
            lock (gate) (state, error) = ("error", ex is HttpRequestException ? $"Download failed: {ex.Message}" : ex.Message);
        }
    }

    /// <summary>
    /// A signed copy of ZawSQL only installs updates signed by the same publisher (the certificate subject: Artifact
    /// Signing renews the certificate itself every few days). An unsigned copy (a development build, or a release made
    /// before signing was set up) accepts anything that passed the checksum. Returns the reason to refuse, or null.
    /// </summary>
    public static string? PublisherMismatch(Publisher? current, Publisher? update) =>
        current == null ? null
        : update == null ? $"The update isn't validly signed, but this copy of ZawSQL is signed by {current.Name}."
        : update.Subject != current.Subject ? $"The update is signed by {update.Name}, not by {current.Name} like this copy of ZawSQL."
        : null;

    /// <summary>The <see cref="Authenticode"/> check on Windows; deletes the file and throws when it fails.</summary>
    static Publisher? VerifyPublisher(string file)
    {
        var signer = Authenticode.SignerOf(file);
        if (PublisherMismatch(OwnSigner.Value, signer) is { } problem)
        {
            try { File.Delete(file); } catch (IOException) { }
            throw new ApiException(problem + " Nothing was changed.");
        }
        return signer;
    }

    public object Status()
    {
        lock (gate) return new { state, received, total, error, version = latest?.Version, signer = state == "ready" ? downloadSigner : null };
    }

    /// <summary>
    /// Hands over to the downloaded version: starts it in helper mode (it replaces the executable once this process has
    /// exited, then starts it on the same port and token) and stops this process. Returns the new version.
    /// </summary>
    public string InstallAndRestart(IHostApplicationLifetime life, int port)
    {
        string version, update;
        lock (gate)
        {
            if (state != "ready" || downloaded == null || !File.Exists(downloaded)) throw new ApiException("The update hasn't been downloaded yet.");
            (version, update) = (latest!.Version, downloaded);
        }
        try
        {
            VerifyPublisher(update); // again: the file sat in the folder since the download
        }
        catch (ApiException ex)
        {
            lock (gate) (state, error, downloaded) = ("error", ex.Message, null);
            throw;
        }
        MakeExecutable(update);
        var psi = new ProcessStartInfo(update) { UseShellExecute = false };
        foreach (var a in new[] { "--apply-update", ExePath!, "--parent", Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture), "--" })
            psi.ArgumentList.Add(a);
        foreach (var a in RestartArguments(opts, port)) psi.ArgumentList.Add(a);
        Process.Start(psi);
        lock (gate) state = "installing";
        // Let the HTTP answer go out, then free the port for the new version.
        _ = Task.Delay(400).ContinueWith(_ => life.StopApplication());
        return version;
    }

    /// <summary>
    /// The new process takes over: same port, token and configuration; --attach means "don't open another window,
    /// wait for the port to be released"; keep-alive mode carries over.
    /// </summary>
    public static List<string> RestartArguments(AppOptions o, int port)
    {
        var args = new List<string> { "--port", port.ToString(System.Globalization.CultureInfo.InvariantCulture), "--token", o.Token, "--config", o.ConfigDir, "--attach" };
        if (o.KeepAlive) args.Add("--keep-alive");
        if (o.Browser != null) args.AddRange(["--browser", o.Browser]);
        return args;
    }
}
