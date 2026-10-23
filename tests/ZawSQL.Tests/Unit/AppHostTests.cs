using System.Net;
using Microsoft.Extensions.DependencyInjection;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Unit;

/// <summary>HTTP-level behaviour of the backend that needs no database.</summary>
public class AppHostTests
{
    [Fact]
    public async Task Api_requires_the_token_but_static_files_do_not()
    {
        await using var app = await TestApp.StartAsync();
        using var anon = new HttpClient { BaseAddress = new Uri(app.BaseAddress) };

        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.GetAsync("/api/sessions")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.GetAsync("/api/sessions?token=wrong-token-123456")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await anon.GetAsync($"/api/sessions?token={TestApp.Token}")).StatusCode);

        var index = await anon.GetStringAsync("/");
        Assert.Contains("<title>ZawSQL</title>", index);
        Assert.Contains("export class Grid", await anon.GetStringAsync("/js/grid.js"));
    }

    [Fact]
    public async Task A_one_time_code_gives_out_the_token_once()
    {
        await using var app = await TestApp.StartAsync();
        using var anon = new HttpClient { BaseAddress = new Uri(app.BaseAddress) };
        async Task<HttpResponseMessage> Boot(string? code)
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "/boot");
            if (code != null) req.Headers.Add("X-Boot", code);
            return await anon.SendAsync(req);
        }
        var code = app.Services.GetRequiredService<BootCodes>().Issue();

        var first = await Boot(code);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Contains(TestApp.Token, await first.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.Unauthorized, (await Boot(code)).StatusCode); // used up
        Assert.Equal(HttpStatusCode.Unauthorized, (await Boot("0123456789abcdef0123456789abcdef")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Boot(null)).StatusCode);
    }

    [Fact]
    public async Task Native_file_dialogs_need_the_native_window_and_never_take_a_path()
    {
        await using var app = await TestApp.StartAsync(); // --no-browser: no window
        var open = await app.PostAsync("/native/open", new { accept = ".sql", multiple = false });
        Assert.False(open.Ok);
        Assert.Contains("native window is not open", open.Error);
        Assert.False((await app.PostAsync("/native/save", new { ext = ".sql", text = "x" })).Ok);
        // Files are only handed out by the id of a dialog's answer.
        Assert.Equal(HttpStatusCode.NotFound, (await app.Http.GetAsync("/api/native/file/" + Uri.EscapeDataString("C:\\Windows\\win.ini"))).StatusCode);
    }

    [Fact]
    public async Task Sessions_crud_and_state_roundtrip()
    {
        await using var app = await TestApp.StartAsync();
        var saved = (await app.PostAsync("/sessions", new { name = "Prod", host = "db.example", port = 3307, password = "pw", savePassword = true, production = true, color = "#d13438" })).Expect();
        var id = saved.GetProperty("id").GetString();
        Assert.True(saved.GetProperty("hasPassword").GetBoolean());
        Assert.True(saved.GetProperty("production").GetBoolean());

        var list = (await app.GetAsync("/sessions")).Expect();
        Assert.Equal("Prod", Assert.Single(list.EnumerateArray()).GetProperty("name").GetString());
        Assert.Equal(System.Text.Json.JsonValueKind.Null, list[0].GetProperty("password").ValueKind);

        (await app.CallAsync(HttpMethod.Delete, $"/sessions/{id}")).Expect();
        Assert.Empty((await app.GetAsync("/sessions")).Expect().EnumerateArray());

        var put = await app.Http.PutAsync("/api/state", new StringContent("""{"prefs":{"theme":"dark"},"history":[]}""", System.Text.Encoding.UTF8, "application/json"));
        put.EnsureSuccessStatusCode();
        Assert.Equal("dark", (await app.GetAsync("/state")).Expect().GetProperty("prefs").GetProperty("theme").GetString());
    }

    [Fact]
    public async Task Library_roundtrips_and_rejects_documents_that_are_not_a_library()
    {
        await using var app = await TestApp.StartAsync();
        Assert.Equal(System.Text.Json.JsonValueKind.Null, (await app.GetAsync("/library")).Expect().ValueKind); // nothing saved yet

        var lib = new { version = 1, queries = new[] { new { id = "q1", name = "Report", folder = "Monthly", sql = "SELECT 1" } }, snippets = Array.Empty<object>() };
        (await app.CallAsync(HttpMethod.Put, "/library", lib)).Expect();
        var back = (await app.GetAsync("/library")).Expect();
        Assert.Equal("Report", back.GetProperty("queries")[0].GetProperty("name").GetString());

        // A buggy or foreign document must never replace the saved queries.
        var bad = await app.CallAsync(HttpMethod.Put, "/library", new { queries = "oops" });
        Assert.False(bad.Ok);
        Assert.Contains("queries", bad.Error);
        Assert.Equal("SELECT 1", (await app.GetAsync("/library")).Expect().GetProperty("queries")[0].GetProperty("sql").GetString());
    }

    [Fact]
    public async Task Library_saves_based_on_an_older_revision_are_refused()
    {
        await using var app = await TestApp.StartAsync();
        var empty = Array.Empty<object>();
        Assert.Equal(1, (await app.CallAsync(HttpMethod.Put, "/library", new { revision = 0, queries = empty, snippets = empty })).Expect().GetProperty("revision").GetInt64());
        Assert.Equal(2, (await app.CallAsync(HttpMethod.Put, "/library", new { revision = 1, queries = empty, snippets = empty })).Expect().GetProperty("revision").GetInt64());

        // A window that loaded revision 1 must not overwrite revision 2.
        var stale = await app.CallAsync(HttpMethod.Put, "/library", new { revision = 1, queries = new[] { new { id = "x" } }, snippets = empty });
        Assert.False(stale.Ok);
        Assert.Equal(Api.LibraryConflict, stale.Code);
        var back = (await app.GetAsync("/library")).Expect();
        Assert.Equal(2, back.GetProperty("revision").GetInt64());
        Assert.Equal(0, back.GetProperty("queries").GetArrayLength());
    }

    [Fact]
    public async Task Unknown_session_and_failed_connection_report_errors()
    {
        await using var app = await TestApp.StartAsync();
        var r = await app.GetAsync("/s/nope/databases");
        Assert.False(r.Ok);
        Assert.Contains("not connected", r.Error);

        // Port 1 on loopback refuses connections quickly.
        var c = await app.PostAsync("/test", new { profile = new { name = "x", host = "127.0.0.1", port = 1, user = "root", connectTimeout = 3 } });
        Assert.False(c.Ok);
    }

    [Theory]
    [InlineData("short")]
    [InlineData("has spaces in the token value")]
    public void Rejects_weak_tokens(string token) =>
        Assert.Throws<ArgumentException>(() => AppOptions.Parse(["--token", token]));
}
