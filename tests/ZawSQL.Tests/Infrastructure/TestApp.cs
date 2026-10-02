using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;

namespace ZawSQL.Tests.Infrastructure;

/// <summary>Response envelope of the ZawSQL API.</summary>
public sealed record ApiResult(bool Ok, JsonElement Data, string? Error, int? Code, string[] Log)
{
    public JsonElement Expect()
    {
        Assert.True(Ok, $"API call failed: {Error}");
        return Data;
    }
}

/// <summary>A real ZawSQL backend on a random loopback port with a throwaway configuration directory.</summary>
public sealed class TestApp : IAsyncDisposable
{
    public const string Token = "test-token-0123456789";
    public string ConfigDir { get; }
    public HttpClient Http { get; }
    public string BaseAddress { get; }
    readonly WebApplication app;

    TestApp(WebApplication app, string configDir, string baseAddress)
    {
        this.app = app;
        ConfigDir = configDir;
        BaseAddress = baseAddress;
        Http = new HttpClient { BaseAddress = new Uri(baseAddress), Timeout = TimeSpan.FromSeconds(60) };
        Http.DefaultRequestHeaders.Add("X-Token", Token);
    }

    public static async Task<TestApp> StartAsync()
    {
        var dir = Path.Combine(Path.GetTempPath(), "zawsql-tests", Guid.NewGuid().ToString("n"));
        var opts = AppOptions.Parse(["--no-browser", "--port", "0", "--config", dir, "--token", Token]);
        var app = AppHost.Build(opts);
        await app.StartAsync();
        return new TestApp(app, dir, AppHost.Address(app));
    }

    public async Task<ApiResult> CallAsync(HttpMethod method, string path, object? body = null)
    {
        using var req = new HttpRequestMessage(method, "/api" + path);
        if (body != null) req.Content = JsonContent.Create(body);
        using var res = await Http.SendAsync(req);
        res.EnsureSuccessStatusCode();
        var json = await res.Content.ReadFromJsonAsync<JsonElement>();
        return new ApiResult(
            json.GetProperty("ok").GetBoolean(),
            json.GetProperty("data").Clone(),
            json.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null,
            json.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.Number ? c.GetInt32() : null,
            json.GetProperty("log").EnumerateArray().Select(x => x.GetString() ?? "").ToArray());
    }

    public Task<ApiResult> GetAsync(string path) => CallAsync(HttpMethod.Get, path);
    public Task<ApiResult> PostAsync(string path, object? body = null) => CallAsync(HttpMethod.Post, path, body ?? new { });

    public async ValueTask DisposeAsync()
    {
        Http.Dispose();
        await app.StopAsync();
        await app.DisposeAsync();
        try { Directory.Delete(ConfigDir, recursive: true); } catch (IOException) { /* best effort */ }
    }
}
