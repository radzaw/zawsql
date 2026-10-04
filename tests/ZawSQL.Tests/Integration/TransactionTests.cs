using System.Text.Json;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

/// <summary>Manual-commit query tabs: their own connection, changes visible elsewhere only after Commit.</summary>
[Collection(DbCollection.Name)]
public class TransactionTests(TestDatabase t)
{
    async Task<JsonElement> Exec(string tab, params string[] statements) =>
        (await t.App.PostAsync($"/s/{t.Sid}/exec", new { statements, database = t.Db, tab })).Expect();

    async Task<string?> Count(string table) => await t.ScalarAsync($"SELECT COUNT(*) FROM `{table}`"); // another connection

    [DbFact]
    public async Task Changes_stay_in_the_tab_until_commit_or_rollback()
    {
        var table = "tx_" + Guid.NewGuid().ToString("n")[..6];
        await t.ExecRootAsync($"CREATE TABLE `{table}` (id INT PRIMARY KEY, v INT) ENGINE=InnoDB");
        var tab = "tab-" + table;

        var started = (await t.App.PostAsync($"/s/{t.Sid}/tx/{tab}/start", new { database = t.Db })).Expect();
        Assert.True(started.GetProperty("manual").GetBoolean());
        Assert.False(started.GetProperty("open").GetBoolean());

        var r = await Exec(tab, $"INSERT INTO `{table}` VALUES (1, 1), (2, 2)", $"SELECT COUNT(*) FROM `{table}`");
        Assert.Equal("2", r.GetProperty("resultSets")[0].GetProperty("rows")[0][0].GetString()); // the tab sees its own changes
        var tx = r.GetProperty("transaction");
        Assert.True(tx.GetProperty("open").GetBoolean());
        Assert.Equal(1, tx.GetProperty("changes").GetInt32());
        Assert.Equal("0", await Count(table)); // nobody else does
        // The other tabs (the session's own connection) don't see it either.
        var other = (await t.App.PostAsync($"/s/{t.Sid}/exec", new { statements = new[] { $"SELECT COUNT(*) FROM `{table}`" }, database = t.Db })).Expect();
        Assert.Equal("0", other.GetProperty("resultSets")[0].GetProperty("rows")[0][0].GetString());

        var commit = (await t.App.PostAsync($"/s/{t.Sid}/tx/{tab}/commit")).Expect();
        Assert.Equal(1, commit.GetProperty("changes").GetInt32());
        Assert.False(commit.GetProperty("transaction").GetProperty("open").GetBoolean());
        Assert.Equal("2", await Count(table));

        await Exec(tab, $"DELETE FROM `{table}`");
        var rollback = await t.App.PostAsync($"/s/{t.Sid}/tx/{tab}/rollback");
        rollback.Expect();
        Assert.Contains("ROLLBACK", rollback.Log);
        Assert.Equal("2", await Count(table));

        // COMMIT typed in the editor ends the transaction too.
        r = await Exec(tab, $"UPDATE `{table}` SET v = 10", "COMMIT");
        Assert.False(r.GetProperty("transaction").GetProperty("open").GetBoolean());
        Assert.Contains("COMMIT made the open transaction (1 change) permanent.", r.GetProperty("notes").EnumerateArray().Select(n => n.GetString()));
        Assert.Equal("2", await t.ScalarAsync($"SELECT COUNT(*) FROM `{table}` WHERE v = 10"));

        // DDL commits implicitly: the user is told.
        r = await Exec(tab, $"DELETE FROM `{table}` WHERE id = 1", $"CREATE TABLE `{table}_b` (a INT)");
        Assert.Contains(r.GetProperty("notes").EnumerateArray(), n => n.GetString()!.StartsWith("CREATE TABLE committed the open transaction (1 change)"));
        Assert.Equal("1", await Count(table));
        await t.ExecRootAsync($"DROP TABLE `{table}_b`");

        // SET autocommit is undone so the tab stays in manual mode.
        r = await Exec(tab, "SET autocommit = 1", $"INSERT INTO `{table}` VALUES (5, 5)");
        Assert.Contains(r.GetProperty("notes").EnumerateArray(), n => n.GetString()!.Contains("keeps autocommit off"));
        Assert.Equal("1", await Count(table));

        // Leaving manual mode needs a decision about what is open.
        Assert.Contains("commit or roll it back first", (await t.App.PostAsync($"/s/{t.Sid}/tx/{tab}/close")).Error);
        (await t.App.PostAsync($"/s/{t.Sid}/tx/{tab}/close?then=rollback")).Expect();
        Assert.Equal("1", await Count(table));
        Assert.False((await t.App.GetAsync($"/s/{t.Sid}/tx/{tab}")).Expect().GetProperty("manual").GetBoolean());
        // A tab that still thinks it is in manual mode gets an error, never a silent auto-commit.
        var gone = await t.App.PostAsync($"/s/{t.Sid}/exec", new { statements = new[] { $"DELETE FROM `{table}`" }, database = t.Db, tab });
        Assert.Contains("manual-commit connection is gone", gone.Error);
        Assert.Equal("1", await Count(table));
    }

    [DbFact]
    public async Task Closing_the_window_rolls_back_its_tabs_and_frees_their_locks()
    {
        var table = "txw_" + Guid.NewGuid().ToString("n")[..6];
        await t.ExecRootAsync($"CREATE TABLE `{table}` (id INT PRIMARY KEY, v INT) ENGINE=InnoDB");
        await t.ExecRootAsync($"INSERT INTO `{table}` VALUES (1, 1)");
        var page = "page-" + table;
        (await t.App.Http.PostAsync($"/api/ping?page={page}", null)).EnsureSuccessStatusCode();
        var tab = "tab-" + table;
        (await t.App.PostAsync($"/s/{t.Sid}/tx/{tab}/start", new { database = t.Db, page })).Expect();
        await Exec(tab, $"UPDATE `{table}` SET v = 2 WHERE id = 1"); // holds the row lock

        (await t.App.Http.PostAsync($"/api/bye?page={page}", null)).EnsureSuccessStatusCode();
        for (var i = 0; i < 50 && (await t.App.GetAsync($"/s/{t.Sid}/tx/{tab}")).Expect().GetProperty("manual").GetBoolean(); i++) await Task.Delay(100);
        Assert.False((await t.App.GetAsync($"/s/{t.Sid}/tx/{tab}")).Expect().GetProperty("manual").GetBoolean());
        // Rolled back, and the lock is gone: another connection changes the row at once (a held lock would wait 50 s).
        await t.ExecRootAsync($"UPDATE `{table}` SET v = 3 WHERE id = 1");
        Assert.Equal("3", await t.ScalarAsync($"SELECT v FROM `{table}`"));
    }

    [DbFact]
    public async Task Grid_edits_join_the_transaction_and_a_lost_connection_is_reported()
    {
        var table = "txg_" + Guid.NewGuid().ToString("n")[..6];
        await t.ExecRootAsync($"CREATE TABLE `{table}` (id INT PRIMARY KEY, v INT) ENGINE=InnoDB");
        await t.ExecRootAsync($"INSERT INTO `{table}` VALUES (1, 1)");
        var tab = "tab-" + table;
        var thread = (await t.App.PostAsync($"/s/{t.Sid}/tx/{tab}/start", new { database = t.Db })).Expect().GetProperty("threadId").GetInt64();

        // An edit in the tab's result grid runs on its connection: no lock wait on its own transaction, and part of it.
        await Exec(tab, $"UPDATE `{table}` SET v = 2 WHERE id = 1");
        (await t.App.PostAsync($"/s/{t.Sid}/rows", new
        {
            db = t.Db, table, tab,
            ops = new[] { new { op = "update", original = new Dictionary<string, string?> { ["id"] = "1", ["v"] = "2" }, values = new Dictionary<string, string?> { ["v"] = "3" } } },
        })).Expect();
        var state = (await t.App.GetAsync($"/s/{t.Sid}/tx/{tab}")).Expect();
        Assert.Equal(2, state.GetProperty("changes").GetInt32());
        Assert.Equal("1", await t.ScalarAsync($"SELECT v FROM `{table}`"));

        // The server drops the connection (wait_timeout, restart, KILL): its transaction is rolled back, and the next run says so.
        await t.ExecRootAsync($"KILL {thread}");
        var lost = await t.App.PostAsync($"/s/{t.Sid}/exec", new { statements = new[] { $"UPDATE `{table}` SET v = 9" }, database = t.Db, tab });
        Assert.Contains("rolled back its open transaction (2 changes)", lost.Error);
        Assert.Equal("1", await t.ScalarAsync($"SELECT v FROM `{table}`"));
        // The tab has a fresh connection, still in manual mode.
        var again = await Exec(tab, $"UPDATE `{table}` SET v = 4");
        Assert.Equal(1, again.GetProperty("transaction").GetProperty("changes").GetInt32());
        Assert.Equal("1", await t.ScalarAsync($"SELECT v FROM `{table}`"));
        (await t.App.PostAsync($"/s/{t.Sid}/tx/{tab}/close?then=commit")).Expect();
        Assert.Equal("4", await t.ScalarAsync($"SELECT v FROM `{table}`"));
    }
}
