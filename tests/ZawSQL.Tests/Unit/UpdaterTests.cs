using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Unit;

/// <summary>Self-update: version comparison, checksums, file replacement, downloads and the API (no database needed).</summary>
public sealed class UpdaterTests : IDisposable
{
    readonly string dir = Path.Combine(Path.GetTempPath(), "zawsql-tests", Guid.NewGuid().ToString("n"));
    public UpdaterTests() => Directory.CreateDirectory(dir);
    public void Dispose() => Directory.Delete(dir, true);

    [Theory]
    [InlineData("1.2.3", "1.2.3", 0)]
    [InlineData("v1.10.0", "1.9.9", 1)]
    [InlineData("1.2", "1.2.0", 0)]
    [InlineData("2.0.0-beta.1", "2.0.0", -1)]
    [InlineData("2.0.0-beta.2", "2.0.0-beta.1", 1)]
    [InlineData("1.0.0", "1.0.1", -1)]
    public void Versions_compare_numerically(string a, string b, int expected) => Assert.Equal(expected, Math.Sign(Updater.CompareVersions(a, b)));

    [Fact]
    public void Checksum_files_asset_names_and_paths()
    {
        var h = new string('a', 64);
        var sums = Updater.ParseChecksums($"{h}  zawsql-linux-x64\n{new string('B', 64)} *zawsql-win-x64.exe\nnot a line\n");
        Assert.Equal(h, sums["zawsql-linux-x64"]);
        Assert.Equal(new string('b', 64), sums["zawsql-win-x64.exe"]);
        Assert.Equal(2, sums.Count);
        Assert.Equal("zawsql-win-x64.exe", Updater.AssetName("win-x64"));
        Assert.Equal("zawsql-osx-arm64", Updater.AssetName("osx-arm64"));
        Assert.Equal(Path.Combine("apps", "ZawSQL.update.exe"), Updater.UpdateFilePath(Path.Combine("apps", "ZawSQL.exe")));
        Assert.Equal(Path.Combine("apps", "ZawSQL.update"), Updater.UpdateFilePath(Path.Combine("apps", "ZawSQL")));
    }

    [Fact]
    public void The_executable_is_replaced_and_the_previous_one_kept()
    {
        var exe = Path.Combine(dir, "ZawSQL");
        var update = Path.Combine(dir, "ZawSQL.update");
        File.WriteAllText(exe, "old");
        File.WriteAllText(update, "new");
        Updater.ReplaceExecutable(exe, update);
        Assert.Equal("new", File.ReadAllText(exe));
        Assert.Equal("old", File.ReadAllText(exe + ".old"));
        if (!OperatingSystem.IsWindows()) Assert.True(File.GetUnixFileMode(exe).HasFlag(UnixFileMode.UserExecute));
        // A missing update file leaves the executable as it was.
        Assert.ThrowsAny<IOException>(() => Updater.ReplaceExecutable(exe, Path.Combine(dir, "missing")));
        Assert.Equal("new", File.ReadAllText(exe));
    }

    [Fact]
    public void The_new_process_takes_over_port_token_and_mode()
    {
        var o = AppOptions.Parse(["--no-browser", "--token", "token-0123456789abcdef", "--config", dir, "--browser", "/opt/chrome"]);
        Assert.Equal(["--port", "5300", "--token", "token-0123456789abcdef", "--config", dir, "--attach", "--keep-alive", "--browser", "/opt/chrome"], Updater.RestartArguments(o, 5300));
        var windowed = AppOptions.Parse(["--token", "token-0123456789abcdef", "--config", dir]);
        Assert.DoesNotContain("--keep-alive", Updater.RestartArguments(windowed, 1));
        Assert.True(AppOptions.Parse(["--attach"]).Attach);
    }

    /// <summary>A local stand-in for the GitHub release API and its assets.</summary>
    static async Task<(WebApplication app, string url)> ReleaseServerAsync(byte[] binary, string? checksum)
    {
        var b = WebApplication.CreateBuilder();
        b.WebHost.UseUrls("http://127.0.0.1:0");
        var app = b.Build();
        string Base(HttpContext c) => $"http://127.0.0.1:{c.Connection.LocalPort}";
        app.MapGet("/releases/latest", (HttpContext c) => Results.Json(new
        {
            tag_name = "v99.1.0", name = "ZawSQL 99.1.0", body = "- fixes", html_url = "https://example.com/r", published_at = "2026-10-01T00:00:00Z",
            assets = new object[]
            {
                new { name = Updater.AssetName(Updater.Rid), browser_download_url = $"{Base(c)}/dl/bin", size = binary.Length },
                new { name = "SHA256SUMS", browser_download_url = $"{Base(c)}/dl/sums", size = 1 },
            },
        }));
        app.MapGet("/dl/bin", () => Results.Bytes(binary));
        app.MapGet("/dl/sums", () => checksum == null ? "" : $"{checksum}  {Updater.AssetName(Updater.Rid)}\n");
        await app.StartAsync();
        return (app, app.Urls.First());
    }

    [Fact]
    public async Task Downloads_are_verified_against_the_published_checksum()
    {
        var binary = Encoding.UTF8.GetBytes(new string('x', 300_000));
        var good = Convert.ToHexString(SHA256.HashData(binary)).ToLowerInvariant();
        using var http = new HttpClient();
        var target = Path.Combine(dir, "ZawSQL.update");
        var name = Updater.AssetName(Updater.Rid);

        var (app, url) = await ReleaseServerAsync(binary, good);
        await using (app)
        {
            long last = 0;
            await Updater.DownloadVerifiedAsync(http, $"{url}/dl/bin", $"{url}/dl/sums", name, target, (_, got) => last = got);
            Assert.Equal(binary, await File.ReadAllBytesAsync(target));
            Assert.Equal(binary.Length, last);

            // Listed for another file only: refused.
            var none = await Assert.ThrowsAsync<ApiException>(() => Updater.DownloadVerifiedAsync(http, $"{url}/dl/bin", $"{url}/dl/sums", "zawsql-other", target));
            Assert.Contains("can't be verified", none.Message);
            Assert.False(File.Exists(target));
        }

        (app, url) = await ReleaseServerAsync(binary, new string('0', 64));
        await using (app)
        {
            var bad = await Assert.ThrowsAsync<ApiException>(() => Updater.DownloadVerifiedAsync(http, $"{url}/dl/bin", $"{url}/dl/sums", name, target));
            Assert.Contains("doesn't match its published checksum", bad.Message);
            Assert.False(File.Exists(target)); // nothing left behind
        }
    }

    [Fact]
    public async Task Api_reports_the_version_and_finds_a_newer_release()
    {
        var binary = Encoding.UTF8.GetBytes("binary");
        var (release, url) = await ReleaseServerAsync(binary, Convert.ToHexString(SHA256.HashData(binary)).ToLowerInvariant());
        await using (release)
        {
            Environment.SetEnvironmentVariable("ZAWSQL_UPDATE_URL", $"{url}/releases/latest");
            try
            {
                await using var app = await TestApp.StartAsync();
                var v = (await app.GetAsync("/version")).Expect();
                Assert.Equal(Updater.CurrentVersion, v.GetProperty("version").GetString());
                Assert.False(v.GetProperty("canInstall").GetBoolean()); // the test host runs from source
                Assert.Contains("from source", v.GetProperty("reason").GetString());

                var c = (await app.PostAsync("/update/check")).Expect();
                Assert.True(c.GetProperty("newer").GetBoolean());
                Assert.Equal("99.1.0", c.GetProperty("latest").GetString());
                Assert.Equal("- fixes", c.GetProperty("notes").GetString());
                Assert.Equal(Updater.AssetName(Updater.Rid), c.GetProperty("asset").GetProperty("name").GetString());
                Assert.False(c.GetProperty("canInstall").GetBoolean());

                var d = await app.PostAsync("/update/download");
                Assert.False(d.Ok);
                Assert.Contains("from source", d.Error);
                Assert.False((await app.PostAsync("/update/install")).Ok);
                Assert.Equal("idle", (await app.GetAsync("/update/status")).Expect().GetProperty("state").GetString());
            }
            finally
            {
                Environment.SetEnvironmentVariable("ZAWSQL_UPDATE_URL", null);
            }
        }
    }
}
