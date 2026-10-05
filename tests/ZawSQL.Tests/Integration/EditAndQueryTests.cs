using System.Diagnostics;
using System.Text.Json;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

[Collection(DbCollection.Name)]
public class EditAndQueryTests(TestDatabase t)
{
    async Task<Dictionary<string, string?>> CustomerAsync(int id)
    {
        var d = (await t.App.GetAsync($"/s/{t.Sid}/data?db={t.Db}&table=customers&where={Uri.EscapeDataString("id = " + id)}")).Expect();
        var cols = d.GetProperty("columns").EnumerateArray().Select(c => c.GetProperty("name").GetString()!).ToList();
        var row = d.GetProperty("rows")[0].EnumerateArray().Select(v => v.ValueKind == JsonValueKind.Null ? null : v.GetString()).ToList();
        return cols.Zip(row).ToDictionary(x => x.First, x => x.Second);
    }

    [DbFact]
    public async Task Each_logged_statement_has_the_time_it_was_sent()
    {
        var before = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var r = await t.App.PostAsync($"/s/{t.Sid}/exec", new { statements = new[] { "SELECT 1", "DO SLEEP(0.3)", "SELECT 2" }, database = t.Db });
        r.Expect();
        var after = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Assert.Equal(r.Log.Length, r.LogTimes.Length);
        var at = (string sql) => r.LogTimes[Array.IndexOf(r.Log, sql)];
        Assert.All(r.LogTimes, ms => Assert.InRange(ms, before - 5, after + 5));
        Assert.True(r.LogTimes.Zip(r.LogTimes.Skip(1)).All(p => p.First <= p.Second), "times in order");
        // Logged as each statement is sent: SELECT 2 comes after the sleep, not at the end of the request.
        Assert.InRange(at("SELECT 2") - at("DO SLEEP(0.3)"), 250, 5000);
        Assert.InRange(at("DO SLEEP(0.3)") - at("SELECT 1"), 0, 250);
    }

    [DbFact]
    public async Task Each_logged_statement_says_how_long_it_took()
    {
        var r = await t.App.PostAsync($"/s/{t.Sid}/exec", new { statements = new[] { "SELECT 1", "DO SLEEP(0.4)", "SELECT * FROM no_such_table" }, database = t.Db, stopOnError = false });
        r.Expect();
        Assert.Equal(r.Log.Length, r.LogMs.Length);
        var ms = (string sql) => r.LogMs[Array.IndexOf(r.Log, sql)];
        Assert.InRange(ms("SELECT 1")!.Value, 0, 300);
        Assert.InRange(ms("DO SLEEP(0.4)")!.Value, 380, 5000);
        Assert.NotNull(ms("SELECT * FROM no_such_table")); // failed statements are timed too
        Assert.All(r.Log.Select((l, i) => (l, i)).Where(x => x.l.StartsWith("/*")), x => Assert.Null(r.LogMs[x.i]));

        // Statements run by the app itself (here the Data tab's) are timed as well.
        var d = await t.App.GetAsync($"/s/{t.Sid}/data?db={t.Db}&table=customers");
        d.Expect();
        Assert.Contains(d.Log.Select((l, i) => (l, i)), x => x.l.StartsWith("SELECT") && d.LogMs[x.i] != null);
    }

    [DbFact]
    public async Task Update_insert_and_delete_rows()
    {
        await t.ExecRootAsync("INSERT INTO customers (id, name) VALUES (100, 'Edit me')");
        var orig = await CustomerAsync(100);

        var u = (await t.App.PostAsync($"/s/{t.Sid}/rows", new { db = t.Db, table = "customers", ops = new[] { new { op = "update", original = orig, values = new Dictionary<string, string?> { ["email"] = "e@x.org", ["balance"] = "7.5" } } } })).Expect();
        Assert.Equal("7.50", u[0].GetProperty("row")[3].GetString());
        Assert.Equal("e@x.org", await t.ScalarAsync("SELECT email FROM customers WHERE id = 100"));

        var ins = (await t.App.PostAsync($"/s/{t.Sid}/rows", new { db = t.Db, table = "customers", ops = new[] { new { op = "insert", values = new Dictionary<string, string?> { ["name"] = "New", ["avatar"] = "0x0102", ["is_vip"] = "1" } } } })).Expect()[0];
        var row = ins.GetProperty("row");
        Assert.Equal("New", row[1].GetString());
        Assert.Equal("0x0102", row[5].GetString());
        Assert.Equal("1", row[6].GetString());
        Assert.Equal("active", row[4].GetString()); // server default read back
        var newId = ins.GetProperty("insertId").GetInt64();

        var del = (await t.App.PostAsync($"/s/{t.Sid}/rows", new { db = t.Db, table = "customers", ops = new[] { new { op = "delete", original = await CustomerAsync((int)newId) } } })).Expect();
        Assert.Equal(1, del[0].GetProperty("affected").GetInt32());
        Assert.Equal("0", await t.ScalarAsync($"SELECT COUNT(*) FROM customers WHERE id = {newId}"));
    }

    [DbFact]
    public async Task Tables_without_key_change_exactly_one_row_and_stale_edits_fail()
    {
        await t.ExecRootAsync("CREATE TABLE dupes (msg VARCHAR(10), n INT)");
        await t.ExecRootAsync("INSERT INTO dupes VALUES ('same', 1), ('same', 1)");
        var r = (await t.App.PostAsync($"/s/{t.Sid}/rows", new { db = t.Db, table = "dupes", ops = new[] { new { op = "update", original = new { msg = "same", n = "1" }, values = new { msg = "changed" } } } })).Expect();
        Assert.Equal(1, r[0].GetProperty("affected").GetInt32());
        Assert.Equal("1", await t.ScalarAsync("SELECT COUNT(*) FROM dupes WHERE msg = 'changed'"));

        var stale = await t.App.PostAsync($"/s/{t.Sid}/rows", new { db = t.Db, table = "dupes", ops = new[] { new { op = "update", original = new { msg = "gone", n = "1" }, values = new { msg = "x" } } } });
        Assert.False(stale.Ok);
        Assert.Contains("No row was affected", stale.Error);
    }

    [DbFact]
    public async Task Exec_returns_multiple_result_sets_and_tracks_database()
    {
        var r = await t.ExecAsync("SELECT 1 AS a, NULL AS b", "SET @x := 5", "SELECT @x AS x", "CALL top_customers(2)");
        var sets = r.GetProperty("resultSets");
        Assert.True(sets.GetArrayLength() >= 4);
        Assert.Equal("5", sets[1].GetProperty("rows")[0][0].GetString());
        Assert.Equal(t.Db, r.GetProperty("database").GetString());
        // Result columns carry their source table for in-place editing of query results.
        var q = await t.ExecAsync("SELECT id, name AS n FROM customers");
        var col = q.GetProperty("resultSets")[0].GetProperty("columns")[1];
        Assert.Equal("customers", col.GetProperty("table").GetString());
        Assert.Equal("name", col.GetProperty("baseName").GetString());
        Assert.Equal(t.Db, col.GetProperty("schema").GetString());
    }

    [DbFact]
    public async Task Exec_stops_at_first_error_and_limits_rows()
    {
        var r = await t.ExecAsync("SELECT 1", "SELECT * FROM does_not_exist", "SELECT 2");
        var err = Assert.Single(r.GetProperty("errors").EnumerateArray());
        Assert.Equal(1, err.GetProperty("statement").GetInt32());
        Assert.Equal(1146, err.GetProperty("code").GetInt32());
        Assert.Equal(1, r.GetProperty("executed").GetInt32());

        var limited = (await t.App.PostAsync($"/s/{t.Sid}/exec", new { statements = new[] { "SELECT * FROM information_schema.COLLATIONS" }, maxRows = 5 })).Expect();
        var set = limited.GetProperty("resultSets")[0];
        Assert.Equal(5, set.GetProperty("rows").GetArrayLength());
        Assert.True(set.GetProperty("truncated").GetBoolean());
    }

    [DbFact]
    public async Task Long_query_blocks_the_session_and_can_be_cancelled()
    {
        var sid = await t.ConnectAsync(t.ProfileId); // own session so other tests aren't blocked
        var sw = Stopwatch.StartNew();
        var running = t.App.PostAsync($"/s/{sid}/exec", new { statements = new[] { "SELECT SLEEP(20)" } });
        await Task.Delay(1500);
        var busy = await t.App.PostAsync($"/s/{sid}/exec", new { statements = new[] { "SELECT 1" } });
        Assert.False(busy.Ok);
        Assert.Contains("busy", busy.Error);
        (await t.App.PostAsync($"/s/{sid}/cancel")).Expect();
        (await running).Expect();
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(15), $"cancel took {sw.Elapsed}");
        (await t.App.PostAsync($"/s/{sid}/disconnect")).Expect();
    }

    [DbFact]
    public async Task Dump_contains_everything_and_tables_reimport_into_another_database()
    {
        var full = await t.App.Http.GetStringAsync($"/api/s/{t.Sid}/dump?db={t.Db}&token={TestApp.Token}");
        Assert.Contains("CREATE TABLE `customers`", full);
        Assert.Contains("INSERT INTO `customers`", full);
        Assert.Contains("0xDEADBEEF", full);
        Assert.Contains("Zoë", full);
        Assert.Contains("DELIMITER ;;", full);
        Assert.Contains("top_customers", full);
        Assert.DoesNotContain($"`{t.Db}`.", full); // portable: no hard-coded schema names

        var tablesOnly = await t.App.Http.GetStringAsync($"/api/s/{t.Sid}/dump?db={t.Db}&tables=customers,orders,logs&token={TestApp.Token}");
        Assert.DoesNotContain("DELIMITER", tablesOnly);
        var copy = t.Db + "_copy";
        t.CleanupLater("db:" + copy);
        await t.ExecRootAsync($"CREATE DATABASE `{copy}`");
        await using (var c = new MySqlConnector.MySqlConnection(TestServer.ConnectionString(database: copy)))
        {
            await c.OpenAsync();
            await using var cmd = new MySqlConnector.MySqlCommand(tablesOnly, c);
            await cmd.ExecuteNonQueryAsync();
        }
        Assert.Equal(await t.ScalarAsync("SELECT COUNT(*) FROM customers"), await t.ScalarAsync($"SELECT COUNT(*) FROM `{copy}`.customers"));
        Assert.Equal("DEADBEEF", await t.ScalarAsync($"SELECT HEX(avatar) FROM `{copy}`.customers WHERE id = 1"));
        Assert.Equal("Zoë Ünicode", await t.ScalarAsync($"SELECT name FROM `{copy}`.customers WHERE id = 3"));
    }
}
