using System.Text.Json;
using MySqlConnector;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

/// <summary>
/// A replica of the test server, for replication tests: ZAWSQL_TEST_REPLICA_HOST and ZAWSQL_TEST_REPLICA_PORT
/// (same user and password). Without them only the primary-side and parsing tests run.
/// </summary>
public static class TestReplica
{
    public static string? Host => Environment.GetEnvironmentVariable("ZAWSQL_TEST_REPLICA_HOST");
    public static int Port => int.TryParse(Environment.GetEnvironmentVariable("ZAWSQL_TEST_REPLICA_PORT"), out var p) ? p : 3306;
    public static bool Enabled => TestServer.Enabled && !string.IsNullOrEmpty(Host);
}

public sealed class ReplicaFactAttribute : FactAttribute
{
    public ReplicaFactAttribute()
    {
        if (!TestReplica.Enabled) Skip = "Set ZAWSQL_TEST_REPLICA_HOST (a replica of ZAWSQL_TEST_HOST) to run replication tests.";
    }
}

[Collection(DbCollection.Name)]
public class ReplicationTests(TestDatabase t)
{
    async Task<string> ReplicaSidAsync(bool readOnly = false)
    {
        var p = (await t.App.PostAsync("/sessions", new
        {
            name = "Replica" + (readOnly ? " RO" : ""), host = TestReplica.Host, port = TestReplica.Port, user = TestServer.User,
            password = TestServer.Password, savePassword = true, readOnly,
        })).Expect();
        return await t.ConnectAsync(p.GetProperty("id").GetString()!);
    }

    async Task<JsonElement> StatusAsync(string sid)
    {
        var r = await t.App.GetAsync($"/s/{sid}/replication");
        Assert.Empty(r.Log); // polled: not logged
        return r.Expect();
    }

    /// <summary>Polls until the default channel satisfies <paramref name="ok"/>.</summary>
    async Task<JsonElement> ChannelAsync(string sid, Func<JsonElement, bool> ok)
    {
        JsonElement ch = default;
        for (var i = 0; i < 100; i++)
        {
            var s = await StatusAsync(sid);
            ch = s.GetProperty("channels")[0];
            if (ok(ch)) return ch;
            await Task.Delay(100);
        }
        Assert.Fail("channel state not reached: " + ch);
        return ch;
    }

    static async Task<string?> ReplicaScalarAsync(string sql, string db)
    {
        var cs = new MySqlConnectionStringBuilder(TestServer.ConnectionString(database: db)) { Server = TestReplica.Host, Port = (uint)TestReplica.Port }.ConnectionString;
        await using var c = new MySqlConnection(cs);
        await c.OpenAsync();
        await using var cmd = new MySqlCommand(sql, c);
        var v = await cmd.ExecuteScalarAsync();
        return v is null or DBNull ? null : Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture);
    }

    async Task WaitOnReplicaAsync(string sql, string expected)
    {
        for (var i = 0; i < 100; i++)
        {
            try { if (await ReplicaScalarAsync(sql, t.Db) == expected) return; } catch (MySqlException) { /* table not there yet */ }
            await Task.Delay(100);
        }
        Assert.Fail($"replica never returned {expected} for {sql}");
    }

    [DbFact]
    public async Task Status_describes_the_server_and_its_binary_log()
    {
        var s = await StatusAsync(t.Sid);
        Assert.Contains(s.GetProperty("role").GetString(), new[] { "standalone", "primary", "replica", "both" });
        Assert.True(s.GetProperty("identity").GetProperty("serverId").GetInt64() >= 0);
        Assert.Equal(t.IsMariaDb ? "mariadb" : "mysql", s.GetProperty("server").GetString());
        if (s.GetProperty("identity").GetProperty("logBin").GetBoolean())
            Assert.False(string.IsNullOrEmpty(s.GetProperty("binlog").GetProperty("file").GetString()));
        if (TestReplica.Enabled)
        {
            Assert.Equal("primary", s.GetProperty("role").GetString());
            Assert.True(s.GetProperty("connected").GetArrayLength() >= 1);
            Assert.True(s.GetProperty("registered").GetArrayLength() >= 1);
        }
    }

    [ReplicaFact]
    public async Task Replica_status_shows_running_threads_lag_source_and_gtids()
    {
        var sid = await ReplicaSidAsync();
        var s = await StatusAsync(sid);
        Assert.Equal("replica", s.GetProperty("role").GetString());
        Assert.True(s.GetProperty("identity").GetProperty("readOnly").GetBoolean());
        var ch = await ChannelAsync(sid, c => c.GetProperty("ioRunning").GetString() == "Yes" && c.GetProperty("sqlRunning").GetString() == "Yes");
        Assert.True(ch.GetProperty("lagSeconds").GetInt64() >= 0);
        Assert.False(string.IsNullOrEmpty(ch.GetProperty("sourceHost").GetString()));
        Assert.Equal(JsonValueKind.Null, ch.GetProperty("sqlError").ValueKind);

        await t.ExecRootAsync("CREATE TABLE rep_probe (id INT PRIMARY KEY)");
        await t.ExecRootAsync("INSERT INTO rep_probe VALUES (1), (2)");
        await WaitOnReplicaAsync("SELECT COUNT(*) FROM rep_probe", "2");
        s = await StatusAsync(sid);
        if (t.IsMariaDb) Assert.False(string.IsNullOrEmpty(s.GetProperty("gtid").GetProperty("slavePos").GetString()));
        else Assert.False(string.IsNullOrEmpty(s.GetProperty("channels")[0].GetProperty("executedGtid").GetString()));
    }

    [ReplicaFact]
    public async Task Stop_start_and_a_replication_error_with_its_recovery()
    {
        var sid = await ReplicaSidAsync();
        var roSid = await ReplicaSidAsync(readOnly: true);
        Assert.False((await t.App.PostAsync($"/s/{roSid}/replication/stop", new { channel = "" })).Ok);

        var stop = await t.App.PostAsync($"/s/{sid}/replication/stop", new { channel = "" });
        stop.Expect();
        Assert.Contains(stop.Log, l => l.StartsWith("STOP REPLICA"));
        await ChannelAsync(sid, c => c.GetProperty("ioRunning").GetString() == "No" && c.GetProperty("sqlRunning").GetString() == "No");
        (await t.App.PostAsync($"/s/{sid}/replication/start", new { channel = "" })).Expect();
        await ChannelAsync(sid, c => c.GetProperty("ioRunning").GetString() == "Yes" && c.GetProperty("sqlRunning").GetString() == "Yes");

        // A row written directly on the replica makes the same insert from the primary fail there.
        await t.ExecRootAsync("CREATE TABLE rep_conflict (id INT PRIMARY KEY, v VARCHAR(10))");
        await WaitOnReplicaAsync("SELECT COUNT(*) FROM rep_conflict", "0");
        await ReplicaScalarAsync("INSERT INTO rep_conflict VALUES (100, 'replica')", t.Db);
        try
        {
            await t.ExecRootAsync("INSERT INTO rep_conflict VALUES (100, 'primary')");
            var broken = await ChannelAsync(sid, c => c.GetProperty("sqlError").ValueKind == JsonValueKind.Object);
            Assert.Equal(1062, broken.GetProperty("sqlError").GetProperty("number").GetInt64());
            Assert.Contains("Duplicate", broken.GetProperty("sqlError").GetProperty("message").GetString()); // the worker's error on MySQL
            Assert.Equal("No", broken.GetProperty("sqlRunning").GetString());
            Assert.Equal("Yes", broken.GetProperty("ioRunning").GetString());
        }
        finally
        {
            // Fix the data on the replica and restart: the insert is applied again (also repairs the replica if an assert failed).
            await ReplicaScalarAsync("DELETE FROM rep_conflict WHERE id = 100", t.Db);
            (await t.App.PostAsync($"/s/{sid}/replication/start", new { channel = "" })).Expect();
        }
        await ChannelAsync(sid, c => c.GetProperty("sqlRunning").GetString() == "Yes" && c.GetProperty("sqlError").ValueKind == JsonValueKind.Null);
        await WaitOnReplicaAsync("SELECT v FROM rep_conflict WHERE id = 100", "primary");
    }

    [ReplicaFact]
    public async Task Skipping_the_failed_transaction_restarts_the_applier_and_keeps_the_replica_row()
    {
        var sid = await ReplicaSidAsync();
        var roSid = await ReplicaSidAsync(readOnly: true);
        await ChannelAsync(sid, c => c.GetProperty("sqlRunning").GetString() == "Yes");
        Assert.False((await t.App.PostAsync($"/s/{sid}/replication/skip", new { channel = "" })).Ok); // no error to skip

        await t.ExecRootAsync("CREATE TABLE rep_skip (id INT PRIMARY KEY, v VARCHAR(10))");
        await WaitOnReplicaAsync("SELECT COUNT(*) FROM rep_skip", "0");
        await ReplicaScalarAsync("INSERT INTO rep_skip VALUES (1, 'replica')", t.Db);
        await t.ExecRootAsync("INSERT INTO rep_skip VALUES (1, 'primary')");
        var broken = await ChannelAsync(sid, c => c.GetProperty("sqlError").ValueKind == JsonValueKind.Object);
        var failed = broken.GetProperty("sqlError").GetProperty("transaction").GetString();
        try
        {
            Assert.False((await t.App.PostAsync($"/s/{roSid}/replication/skip", new { channel = "" })).Ok);
            // "Show in relay log" opens the relay log where the applier stopped: the failed transaction is there.
            var relay = (await t.App.GetAsync($"/s/{sid}/binlog/events?log=relay&file={Uri.EscapeDataString(broken.GetProperty("relayFile").GetString()!)}&from={broken.GetProperty("relayPos").GetInt64()}&limit=200")).Expect();
            var infos = relay.GetProperty("events").EnumerateArray().Select(e => e.GetProperty("info").GetString() ?? "").ToList();
            if (failed != null) Assert.Contains(infos, i => i.Contains(failed));
            Assert.Contains(infos, i => i.Contains("rep_skip"));
            if (failed != null) // a transaction other than the one shown is never skipped
                Assert.False((await t.App.PostAsync($"/s/{sid}/replication/skip", new { channel = "", transaction = "00000000-0000-0000-0000-000000000000:1" })).Ok);
            var skip = await t.App.PostAsync($"/s/{sid}/replication/skip", new { channel = "", transaction = failed });
            var r = skip.Expect();
            Assert.Contains(skip.Log, l => l.Contains("SQL_THREAD"));
            if (failed != null) Assert.Equal(failed, r.GetProperty("transaction").GetString());
            await ChannelAsync(sid, c => c.GetProperty("sqlRunning").GetString() == "Yes" && c.GetProperty("sqlError").ValueKind == JsonValueKind.Null);
            Assert.Equal("replica", await ReplicaScalarAsync("SELECT v FROM rep_skip WHERE id = 1", t.Db));
            // Later changes replicate again.
            await t.ExecRootAsync("INSERT INTO rep_skip VALUES (2, 'primary')");
            await WaitOnReplicaAsync("SELECT COUNT(*) FROM rep_skip", "2");
        }
        finally
        {
            // Repair the replica if an assert failed before the skip.
            var ch = (await StatusAsync(sid)).GetProperty("channels")[0];
            if (ch.GetProperty("sqlError").ValueKind == JsonValueKind.Object)
            {
                await ReplicaScalarAsync("DELETE FROM rep_skip WHERE id = 1", t.Db);
                (await t.App.PostAsync($"/s/{sid}/replication/start", new { channel = "" })).Expect();
            }
        }
    }

    [Fact]
    public void The_failed_gtid_comes_from_the_worker_or_the_error_message()
    {
        const string g = "3e11fa47-71ca-11e1-9e33-c80aa9429562:23";
        Assert.Equal(g, Replication.FailedGtid([(g, null)], null));
        Assert.Equal(g, Replication.FailedGtid([("", $"Worker 1 failed executing transaction '{g}' at source log binlog.000002, end_log_pos 1234")], null));
        Assert.Equal(g, Replication.FailedGtid([], $"Coordinator stopped ... Worker 1 failed executing transaction '{g}' at ..."));
        Assert.Equal("3e11fa47-71ca-11e1-9e33-c80aa9429562:tag_1:5", Replication.FailedGtid([("3e11fa47-71ca-11e1-9e33-c80aa9429562:tag_1:5", null)], null));
        Assert.Null(Replication.FailedGtid([("ANONYMOUS", "failed executing transaction 'ANONYMOUS' at")], "x"));
        Assert.Null(Replication.FailedGtid([("x'; DROP TABLE t; --", null)], null));
    }

    [Fact]
    public void Mysql_and_mariadb_replica_status_columns_are_normalized()
    {
        static JsonElement N2(Dictionary<string, string?> r, List<Replication.WorkerError>? w) => JsonSerializer.SerializeToElement(Replication.NormalizeChannel(r, w), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        static JsonElement N(Dictionary<string, string?> r) => N2(r, null);
        var my = N(new()
        {
            ["Channel_Name"] = "", ["Source_Host"] = "db1", ["Source_Port"] = "3306", ["Replica_IO_Running"] = "Yes", ["Replica_SQL_Running"] = "No",
            ["Seconds_Behind_Source"] = null, ["Last_SQL_Errno"] = "1062", ["Last_SQL_Error"] = "Duplicate entry", ["Last_SQL_Error_Timestamp"] = "251003 10:00:00",
            ["Last_IO_Errno"] = "0", ["Retrieved_Gtid_Set"] = "uuid:1-5", ["Auto_Position"] = "1", ["SQL_Delay"] = "3600", ["Replicate_Do_DB"] = "shop",
        });
        Assert.Equal("db1", my.GetProperty("sourceHost").GetString());
        Assert.Equal("No", my.GetProperty("sqlRunning").GetString());
        Assert.Equal(JsonValueKind.Null, my.GetProperty("lagSeconds").ValueKind);
        Assert.Equal(1062, my.GetProperty("sqlError").GetProperty("number").GetInt64());
        Assert.Equal(JsonValueKind.Null, my.GetProperty("ioError").ValueKind);
        Assert.True(my.GetProperty("autoPosition").GetBoolean());
        var coordinated = N2(new() { ["Last_SQL_Errno"] = "1062", ["Last_SQL_Error"] = "Coordinator stopped because there were error(s) in the worker(s)." },
            [new Replication.WorkerError(1, 1062, "Duplicate entry '100' for key 'PRIMARY'", "2026-10-03 19:07:02", "uuid:32")]);
        Assert.Equal("Duplicate entry '100' for key 'PRIMARY'", coordinated.GetProperty("sqlError").GetProperty("message").GetString());
        Assert.Equal("uuid:32", coordinated.GetProperty("sqlError").GetProperty("transaction").GetString());
        Assert.StartsWith("Coordinator stopped", coordinated.GetProperty("sqlError").GetProperty("coordinator").GetString());
        Assert.Equal(3600, my.GetProperty("sqlDelay").GetInt64());
        Assert.Equal("Replicate_Do_DB", my.GetProperty("filters")[0].GetProperty("name").GetString());

        var maria = N(new()
        {
            ["Connection_name"] = "eu", ["Master_Host"] = "db2", ["Slave_IO_Running"] = "Connecting", ["Slave_SQL_Running"] = "Yes",
            ["Seconds_Behind_Master"] = "42", ["Using_Gtid"] = "Slave_Pos", ["Gtid_Slave_Pos"] = "0-1-17", ["Parallel_Mode"] = "optimistic",
        });
        Assert.Equal("eu", maria.GetProperty("channel").GetString());
        Assert.Equal("db2", maria.GetProperty("sourceHost").GetString());
        Assert.Equal("Connecting", maria.GetProperty("ioRunning").GetString());
        Assert.Equal(42, maria.GetProperty("lagSeconds").GetInt64());
        Assert.Equal("0-1-17", maria.GetProperty("gtidSlavePos").GetString());
        Assert.Equal(0, maria.GetProperty("filters").GetArrayLength());
    }
}
