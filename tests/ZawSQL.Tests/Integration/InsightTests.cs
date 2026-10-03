using System.Text.Json;
using MySqlConnector;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

[Collection(DbCollection.Name)]
public class InsightTests(TestDatabase t)
{
    async Task<MySqlConnection> OpenAsync()
    {
        var c = new MySqlConnection(TestServer.ConnectionString(database: t.Db));
        await c.OpenAsync();
        return c;
    }

    static async Task ExecAsync(MySqlConnection c, string sql)
    {
        await using var cmd = new MySqlCommand(sql, c);
        await cmd.ExecuteNonQueryAsync();
    }

    async Task<string> LockTableAsync()
    {
        var table = "lk_" + Guid.NewGuid().ToString("n")[..6];
        await t.ExecRootAsync($"CREATE TABLE `{table}` (id INT PRIMARY KEY, v INT) ENGINE=InnoDB");
        await t.ExecRootAsync($"INSERT INTO `{table}` VALUES (1, 0), (2, 0)");
        return table;
    }

    /// <summary>Polls the locks endpoint until <paramref name="ready"/> holds (lock waits take a moment to appear).</summary>
    async Task<JsonElement> LocksAsync(Func<JsonElement, bool> ready)
    {
        JsonElement r = default;
        for (var i = 0; i < 50; i++)
        {
            var res = await t.App.GetAsync($"/s/{t.Sid}/insight/locks");
            Assert.Empty(res.Log); // polled: never logged
            r = res.Expect();
            if (ready(r)) return r;
            await Task.Delay(100);
        }
        Assert.Fail("condition not reached: " + r);
        return r;
    }

    [DbFact]
    public async Task Top_queries_come_from_statement_digests_when_performance_schema_is_on()
    {
        for (var i = 0; i < 3; i++) await t.ExecAsync("SELECT id AS zs_insight_probe FROM customers WHERE id > " + i);
        var res = await t.App.GetAsync($"/s/{t.Sid}/insight/queries");
        Assert.Empty(res.Log);
        var r = res.Expect();
        Assert.True(r.GetProperty("slowLog").TryGetProperty("longQueryTime", out _));
        if (!r.GetProperty("available").GetBoolean())
        {
            // MariaDB ships with performance_schema off: explain instead of an empty list.
            Assert.Contains("performance_schema", r.GetProperty("reason").GetString());
            return;
        }
        var probe = r.GetProperty("rows").EnumerateArray().First(x => x.GetProperty("text").GetString()!.Contains("zs_insight_probe"));
        Assert.True(probe.GetProperty("count").GetDouble() >= 3);
        Assert.True(probe.GetProperty("totalMs").GetDouble() > 0);
        Assert.Equal(t.Db, probe.GetProperty("schema").GetString());
        Assert.DoesNotContain(r.GetProperty("rows").EnumerateArray(), x => x.GetProperty("text").GetString()!.Contains("events_statements_summary_by_digest"));

        var roSid = await t.ConnectAsync(await t.SaveSessionAsync("RO insight", readOnly: true));
        Assert.False((await t.App.PostAsync($"/s/{roSid}/insight/reset")).Ok);
        (await t.App.PostAsync($"/s/{t.Sid}/insight/reset")).Expect();
        var after = (await t.App.GetAsync($"/s/{t.Sid}/insight/queries")).Expect();
        Assert.DoesNotContain(after.GetProperty("rows").EnumerateArray(), x => x.GetProperty("text").GetString()!.Contains("zs_insight_probe"));
    }

    [DbFact]
    public async Task Row_lock_waits_show_who_blocks_whom_and_open_transactions()
    {
        var table = await LockTableAsync();
        await using var a = await OpenAsync();
        await using var b = await OpenAsync();
        await ExecAsync(a, "START TRANSACTION");
        await ExecAsync(a, $"UPDATE `{table}` SET v = 1 WHERE id = 1");
        await ExecAsync(b, "SET SESSION innodb_lock_wait_timeout = 30");
        var blocked = ExecAsync(b, $"UPDATE `{table}` SET v = 2 WHERE id = 1");
        try
        {
            var r = await LocksAsync(x => x.GetProperty("waits").EnumerateArray().Any(w => w.GetProperty("table").GetString() == table));
            var w = r.GetProperty("waits").EnumerateArray().First(w => w.GetProperty("table").GetString() == table);
            Assert.Equal(t.Db, w.GetProperty("db").GetString());
            Assert.Equal(b.ServerThread, w.GetProperty("waiting").GetProperty("thread").GetInt64());
            Assert.Contains("SET v = 2", w.GetProperty("waiting").GetProperty("query").GetString());
            Assert.Equal(a.ServerThread, w.GetProperty("blocking").GetProperty("thread").GetInt64());
            Assert.Equal("Sleep", w.GetProperty("blocking").GetProperty("command").GetString()); // idle in transaction
            Assert.Contains("X", w.GetProperty("waiting").GetProperty("mode").GetString());

            var trx = r.GetProperty("transactions").EnumerateArray().First(x => x.GetProperty("thread").GetInt64() == a.ServerThread);
            Assert.True(trx.GetProperty("rowsLocked").GetInt64() >= 1);
            Assert.Equal(JsonValueKind.Null, trx.GetProperty("query").ValueKind);

            // Killing the blocker (as the UI's Kill button does) lets the waiting update through.
            (await t.App.PostAsync($"/s/{t.Sid}/kill", new { id = a.ServerThread })).Expect();
            await blocked;
            Assert.Equal("2", await t.ScalarAsync($"SELECT v FROM `{table}` WHERE id = 1"));
        }
        finally
        {
            try { await ExecAsync(a, "ROLLBACK"); } catch (MySqlException) { } catch (InvalidOperationException) { }
            try { await blocked; } catch (MySqlException) { }
        }
    }

    [DbFact]
    public async Task Metadata_lock_waits_and_the_latest_deadlock()
    {
        var table = await LockTableAsync();
        await using var a = await OpenAsync();
        await using var c = await OpenAsync();
        await ExecAsync(a, "START TRANSACTION");
        await ExecAsync(a, $"SELECT * FROM `{table}`");
        await ExecAsync(c, "SET SESSION lock_wait_timeout = 30");
        var alter = ExecAsync(c, $"ALTER TABLE `{table}` ADD COLUMN x INT");
        try
        {
            var r = await LocksAsync(x => x.GetProperty("metadata").EnumerateArray().Any(m => m.GetProperty("waiting").GetProperty("thread").GetInt64() == c.ServerThread));
            var m = r.GetProperty("metadata").EnumerateArray().First(m => m.GetProperty("waiting").GetProperty("thread").GetInt64() == c.ServerThread);
            if (!t.IsMariaDb) // MySQL names the holder; MariaDB (without the metadata_lock_info plugin) only the waiter
            {
                Assert.Equal(table, m.GetProperty("name").GetString());
                Assert.Equal(a.ServerThread, m.GetProperty("blocking").GetProperty("thread").GetInt64());
            }
        }
        finally
        {
            await ExecAsync(a, "ROLLBACK");
            await alter;
        }

        // A deadlock: each transaction waits for the row the other one holds.
        await using var b = await OpenAsync();
        await ExecAsync(a, "START TRANSACTION");
        await ExecAsync(b, "START TRANSACTION");
        await ExecAsync(a, $"UPDATE `{table}` SET v = 10 WHERE id = 1");
        await ExecAsync(b, $"UPDATE `{table}` SET v = 20 WHERE id = 2");
        var first = ExecAsync(a, $"UPDATE `{table}` SET v = 11 WHERE id = 2");
        await Task.Delay(300);
        var errors = 0;
        try { await ExecAsync(b, $"UPDATE `{table}` SET v = 21 WHERE id = 1"); } catch (MySqlException ex) when (ex.Number == 1213) { errors++; }
        try { await first; } catch (MySqlException ex) when (ex.Number == 1213) { errors++; }
        Assert.Equal(1, errors);
        await ExecAsync(a, "ROLLBACK");
        await ExecAsync(b, "ROLLBACK");
        var locks = (await t.App.GetAsync($"/s/{t.Sid}/insight/locks")).Expect();
        var deadlock = locks.GetProperty("deadlock").GetString();
        Assert.Contains("WE ROLL BACK TRANSACTION", deadlock);
        Assert.Contains(table, deadlock);
    }

    [DbFact]
    public async Task Slow_log_table_entries()
    {
        var old = await t.ScalarAsync("SELECT CONCAT(@@GLOBAL.slow_query_log, '|', @@GLOBAL.log_output)");
        try
        {
            await t.ExecRootAsync("SET GLOBAL log_output = 'TABLE', GLOBAL slow_query_log = 1");
            await using (var c = await OpenAsync())
            {
                await ExecAsync(c, "SET SESSION long_query_time = 0");
                await ExecAsync(c, "SELECT SLEEP(0.05) AS zs_slow_probe");
            }
            var r = (await t.App.GetAsync($"/s/{t.Sid}/insight/slowlog?limit=200")).Expect();
            Assert.True(r.GetProperty("settings").GetProperty("toTable").GetBoolean());
            Assert.True(r.GetProperty("settings").GetProperty("enabled").GetBoolean());
            var cols = r.GetProperty("log").GetProperty("columns").EnumerateArray().Select(x => x.GetProperty("name").GetString()).ToList();
            var q = cols.IndexOf("Query");
            Assert.Contains(r.GetProperty("log").GetProperty("rows").EnumerateArray(), row => row[q].GetString()!.Contains("zs_slow_probe"));
        }
        finally
        {
            var parts = old!.Split('|');
            await t.ExecRootAsync($"SET GLOBAL slow_query_log = {parts[0]}, GLOBAL log_output = '{parts[1]}'");
        }
    }

    [Theory]
    [InlineData("`shop`.`orders`", "shop", "orders")]
    [InlineData("`we``ird`.`t`", "we`ird", "t")]
    [InlineData("orders", null, "orders")]
    public void Lock_table_names_are_split(string input, string? db, string table) => Assert.Equal((db, table), Insight.SplitLockTable(input));
}
