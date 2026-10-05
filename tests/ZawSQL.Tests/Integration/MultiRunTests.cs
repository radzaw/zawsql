using System.Diagnostics;
using System.Text.Json;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

[Collection(DbCollection.Name)]
public class MultiRunTests(TestDatabase t)
{
    static JsonElement Server(JsonElement data, string id) =>
        data.GetProperty("servers").EnumerateArray().Single(s => s.GetProperty("session").GetString() == id);

    async Task<string> SaveAsync(object profile) => (await t.App.PostAsync("/sessions", profile)).Expect().GetProperty("id").GetString()!;

    [DbFact]
    public async Task Runs_on_connected_and_saved_sessions_and_logs_each_server()
    {
        var other = await t.SaveSessionAsync("MR other");
        var r = await t.App.PostAsync("/multi/run", new { runId = "mr1", sessions = new[] { t.ProfileId, other }, statements = new[] { "SELECT DATABASE() AS db", "SELECT COUNT(*) AS n FROM customers" }, database = t.Db });
        var d = r.Expect();
        foreach (var id in new[] { t.ProfileId, other })
        {
            var s = Server(d, id);
            Assert.True(s.GetProperty("ok").GetBoolean(), s.ToString());
            Assert.Equal(2, s.GetProperty("executed").GetInt32());
            var sets = s.GetProperty("resultSets");
            Assert.Equal(t.Db, sets[0].GetProperty("rows")[0][0].GetString());
            Assert.Equal(await t.ScalarAsync("SELECT COUNT(*) FROM customers"), sets[1].GetProperty("rows")[0][0].GetString());
        }
        // Each server's lines under a header, with the times they were logged.
        Assert.Contains(r.Log, l => l.StartsWith("/* On \"Test server\": 2 of 2 statements"));
        Assert.Contains(r.Log, l => l.StartsWith("/* On \"MR other\": 2 of 2 statements"));
        Assert.Equal(r.Log.Length, r.LogTimes.Length);
        var header = Array.FindIndex(r.Log, l => l.StartsWith("/* On \"MR other\""));
        Assert.Contains(r.Log.Skip(header + 1).TakeWhile(l => !l.StartsWith("/* On ")), l => l.StartsWith("/* Connecting to")); // connected for the run
    }

    [DbFact]
    public async Task Changes_run_on_every_server_and_failures_stay_per_server()
    {
        await t.ExecRootAsync("CREATE TABLE mr_hits (who VARCHAR(20))");
        var second = await t.SaveSessionAsync("MR second");
        var bad = await SaveAsync(new { name = "MR bad password", host = TestServer.Host, port = TestServer.Port, user = TestServer.User, password = "definitely-wrong", savePassword = true });
        var ro = await t.SaveSessionAsync("MR read-only", readOnly: true);
        var d = (await t.App.PostAsync("/multi/run", new
        {
            runId = "mr2", sessions = new[] { t.ProfileId, second, bad, ro }, database = t.Db, stopOnError = false,
            statements = new[] { "INSERT INTO mr_hits VALUES (CONNECTION_ID())", "SELECT * FROM no_such_table", "SELECT 1 AS one" },
        })).Expect();

        Assert.Equal("2", await t.ScalarAsync("SELECT COUNT(DISTINCT who) FROM mr_hits")); // once per writable server, on its own connection
        var ok = Server(d, second);
        Assert.False(ok.GetProperty("ok").GetBoolean());
        Assert.Equal(1, ok.GetProperty("affected").GetInt64());
        Assert.Equal(2, ok.GetProperty("executed").GetInt32()); // went on after the error
        Assert.Equal(1146, ok.GetProperty("errors")[0].GetProperty("code").GetInt32());

        var denied = Server(d, bad);
        Assert.Contains("Access denied", denied.GetProperty("error").GetString());
        Assert.Equal(0, denied.GetProperty("executed").GetInt32());

        var blocked = Server(d, ro);
        Assert.True(blocked.GetProperty("readOnly").GetBoolean());
        Assert.Equal(0, blocked.GetProperty("errors")[0].GetProperty("code").GetInt32());
        Assert.Equal(1, blocked.GetProperty("resultSets").GetArrayLength()); // SELECT 1 still ran
    }

    [DbFact]
    public async Task Stops_at_the_first_error_and_needs_a_saved_password()
    {
        var noPwd = await SaveAsync(new { name = "MR no password", host = TestServer.Host, port = TestServer.Port, user = TestServer.User, savePassword = false });
        var d = (await t.App.PostAsync("/multi/run", new { runId = "mr3", sessions = new[] { t.ProfileId, noPwd }, statements = new[] { "SELECT * FROM no_such_table", "SELECT 2" }, database = t.Db })).Expect();
        var s = Server(d, t.ProfileId);
        Assert.Equal(0, s.GetProperty("executed").GetInt32());
        Assert.Equal(0, s.GetProperty("resultSets").GetArrayLength());
        Assert.Contains("password isn't saved", Server(d, noPwd).GetProperty("error").GetString());
    }

    [DbFact]
    public async Task A_run_can_be_stopped()
    {
        var sw = Stopwatch.StartNew();
        var running = t.App.PostAsync("/multi/run", new { runId = "mr4", sessions = new[] { t.ProfileId }, statements = new[] { "SELECT SLEEP(20)", "SELECT 1" } });
        await Task.Delay(1500);
        Assert.True((await t.App.PostAsync("/multi/cancel", new { runId = "mr4" })).Expect().GetProperty("cancelled").GetBoolean());
        var d = (await running).Expect();
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(15), $"stop took {sw.Elapsed}");
        Assert.True(d.GetProperty("cancelled").GetBoolean());
        Assert.Equal("Stopped.", Server(d, t.ProfileId).GetProperty("error").GetString());
        Assert.False((await t.App.PostAsync("/multi/cancel", new { runId = "mr4" })).Expect().GetProperty("cancelled").GetBoolean());
    }
}
