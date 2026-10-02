using System.Text.Json;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

/// <summary>
/// SSH tunnel settings for integration tests (see tests/ssh): ZAWSQL_TEST_SSH_HOST (enables them), ZAWSQL_TEST_SSH_PORT,
/// ZAWSQL_TEST_SSH_USER/PASSWORD, and the database as seen from the SSH server: ZAWSQL_TEST_SSH_DB_HOST/PORT.
/// </summary>
public static class TestSsh
{
    public static string? Host => Environment.GetEnvironmentVariable("ZAWSQL_TEST_SSH_HOST");
    public static int Port => int.TryParse(Environment.GetEnvironmentVariable("ZAWSQL_TEST_SSH_PORT"), out var p) ? p : 22;
    public static string User => Environment.GetEnvironmentVariable("ZAWSQL_TEST_SSH_USER") ?? "tunnel";
    public static string Password => Environment.GetEnvironmentVariable("ZAWSQL_TEST_SSH_PASSWORD") ?? "tunnel-pass";
    public static string DbHost => Environment.GetEnvironmentVariable("ZAWSQL_TEST_SSH_DB_HOST") ?? "127.0.0.1";
    public static int DbPort => int.TryParse(Environment.GetEnvironmentVariable("ZAWSQL_TEST_SSH_DB_PORT"), out var p) ? p : 3306;
    public static bool Enabled => TestServer.Enabled && !string.IsNullOrEmpty(Host);

    /// <summary>tests/ssh, found by walking up from the test binaries.</summary>
    public static string KeyDir
    {
        get
        {
            for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
            {
                var candidate = Path.Combine(d.FullName, "tests", "ssh");
                if (File.Exists(Path.Combine(candidate, "test_ed25519"))) return candidate;
            }
            throw new InvalidOperationException("tests/ssh not found");
        }
    }
}

public sealed class SshFactAttribute : FactAttribute
{
    public SshFactAttribute()
    {
        if (!TestSsh.Enabled) Skip = "Set ZAWSQL_TEST_HOST and ZAWSQL_TEST_SSH_HOST (see tests/ssh) to run SSH tunnel tests.";
    }
}

[Collection(DbCollection.Name)]
public class SshTunnelTests(TestDatabase t)
{
    static object Profile(string name, string auth = "password", string? keyFile = null, string? secret = null, string? hostKey = null) => new
    {
        name, host = TestSsh.DbHost, port = TestSsh.DbPort, user = TestServer.User, password = TestServer.Password, savePassword = true,
        sshEnabled = true, sshHost = TestSsh.Host, sshPort = TestSsh.Port, sshUser = TestSsh.User, sshAuth = auth,
        sshKeyFile = keyFile, sshSecret = secret ?? (auth == "password" ? TestSsh.Password : null), sshHostKey = hostKey,
    };

    async Task<string> SaveAsync(object profile) => (await t.App.PostAsync("/sessions", profile)).Expect().GetProperty("id").GetString()!;

    /// <summary>Connects, trusting the host key the server presents (what the user does after checking the fingerprint).</summary>
    async Task<string> ConnectTrustingAsync(string id)
    {
        var first = await t.App.PostAsync("/connect", new { sessionId = id });
        if (first.Ok) return first.Data.GetProperty("sid").GetString()!;
        Assert.Equal(Api.SshHostKeyUnknown, first.Code);
        (await t.App.PostAsync($"/sessions/{id}/hostkey", new { fingerprint = first.Data.GetProperty("fingerprint").GetString() })).Expect();
        return (await t.App.PostAsync("/connect", new { sessionId = id })).Expect().GetProperty("sid").GetString()!;
    }

    [SshFact]
    public async Task Unknown_host_key_must_be_confirmed_then_queries_run_through_the_tunnel()
    {
        var id = await SaveAsync(Profile("SSH pw " + t.Suffix));
        var first = await t.App.PostAsync("/connect", new { sessionId = id });
        Assert.False(first.Ok);
        Assert.Equal(Api.SshHostKeyUnknown, first.Code);
        var fingerprint = first.Data.GetProperty("fingerprint").GetString()!;
        Assert.StartsWith("SHA256:", fingerprint);
        Assert.DoesNotContain(first.Log, l => l.Contains(TestSsh.Password));

        (await t.App.PostAsync($"/sessions/{id}/hostkey", new { fingerprint })).Expect();
        var info = (await t.App.PostAsync("/connect", new { sessionId = id })).Expect();
        var sid = info.GetProperty("sid").GetString()!;
        Assert.Equal($"{TestSsh.User}@{TestSsh.Host}", info.GetProperty("ssh").GetString());

        var dbs = (await t.App.GetAsync($"/s/{sid}/databases")).Expect().EnumerateArray().Select(d => d.GetString()).ToList();
        Assert.Contains(t.Db, dbs);
        var rows = (await t.App.PostAsync($"/s/{sid}/exec", new { statements = new[] { "SELECT COUNT(*) FROM customers WHERE id <= 3" }, database = t.Db })).Expect();
        Assert.Equal("3", rows.GetProperty("resultSets")[0].GetProperty("rows")[0][0].GetString());
        // Metadata connections (pooled, separate) use the tunnel too.
        Assert.True((await t.App.GetAsync($"/s/{sid}/data?db={t.Db}&table=customers")).Ok);
        (await t.App.PostAsync($"/s/{sid}/disconnect")).Expect();
    }

    [SshFact]
    public async Task Private_keys_from_file_or_pasted_text_with_and_without_passphrase()
    {
        var ed = Path.Combine(TestSsh.KeyDir, "test_ed25519");
        var sid1 = await ConnectTrustingAsync(await SaveAsync(Profile("SSH key " + t.Suffix, "key", ed)));
        Assert.True((await t.App.GetAsync($"/s/{sid1}/databases")).Ok);

        var pasted = await File.ReadAllTextAsync(ed);
        var sid2 = await ConnectTrustingAsync(await SaveAsync(Profile("SSH pasted " + t.Suffix, "key", pasted)));
        Assert.True((await t.App.GetAsync($"/s/{sid2}/databases")).Ok);

        var rsa = Path.Combine(TestSsh.KeyDir, "test_rsa");
        var sid3 = await ConnectTrustingAsync(await SaveAsync(Profile("SSH rsa " + t.Suffix, "key", rsa, "key-passphrase")));
        Assert.True((await t.App.GetAsync($"/s/{sid3}/databases")).Ok);

        var noPass = await t.App.PostAsync("/connect", new { sessionId = await SaveAsync(Profile("SSH rsa nopass " + t.Suffix, "key", rsa)) });
        Assert.False(noPass.Ok);
        Assert.Contains("passphrase", noPass.Error, StringComparison.OrdinalIgnoreCase);

        var missing = await t.App.PostAsync("/connect", new { sessionId = await SaveAsync(Profile("SSH missing " + t.Suffix, "key", "/nope/id_ed25519")) });
        Assert.False(missing.Ok);
        Assert.Contains("not found", missing.Error);

        foreach (var sid in new[] { sid1, sid2, sid3 }) await t.App.PostAsync($"/s/{sid}/disconnect");
    }

    [SshFact]
    public async Task Changed_host_key_and_wrong_password_are_refused()
    {
        var changed = await t.App.PostAsync("/connect", new { sessionId = await SaveAsync(Profile("SSH mitm " + t.Suffix, hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")) });
        Assert.False(changed.Ok);
        Assert.NotEqual(Api.SshHostKeyUnknown, changed.Code);
        Assert.Contains("CHANGED", changed.Error);

        // Trust the real key first so the failure is about authentication.
        var id = await SaveAsync(Profile("SSH wrong pw " + t.Suffix, secret: "not-the-password"));
        var probe = await t.App.PostAsync("/connect", new { sessionId = id });
        if (probe.Code == Api.SshHostKeyUnknown)
        {
            (await t.App.PostAsync($"/sessions/{id}/hostkey", new { fingerprint = probe.Data.GetProperty("fingerprint").GetString() })).Expect();
            probe = await t.App.PostAsync("/connect", new { sessionId = id });
        }
        Assert.False(probe.Ok);
        Assert.Contains("authentication failed", probe.Error, StringComparison.OrdinalIgnoreCase);
    }

    [SshFact]
    public async Task Connection_test_works_for_unsaved_profiles_through_the_tunnel()
    {
        var unknown = await t.App.PostAsync("/test", new { profile = Profile("unsaved") });
        Assert.Equal(Api.SshHostKeyUnknown, unknown.Code);
        var fp = unknown.Data.GetProperty("fingerprint").GetString();
        var ok = (await t.App.PostAsync("/test", new { profile = Profile("unsaved", hostKey: fp) })).Expect();
        Assert.True(ok.GetProperty("ssh").GetBoolean());
        Assert.False(string.IsNullOrEmpty(ok.GetProperty("version").GetString()));
    }
}
