using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

/// <summary>
/// Read-only sessions against statements the lexical guard reads differently than the server: backslashes under
/// NO_BACKSLASH_ESCAPES and MariaDB's /*M! */ executable comments. The Data tab's filter runs on the metadata connection,
/// which isn't READ ONLY on the server, so there the guard is the only layer.
/// </summary>
[Collection(DbCollection.Name)]
public class ReadOnlyBypassTests(TestDatabase t)
{
    async Task<long> VictimRowsAsync() => long.Parse((await t.ScalarAsync("SELECT COUNT(*) FROM ro_victim"))!);

    async Task<string> RoSidAsync(string name) => await t.ConnectAsync(await t.SaveSessionAsync(name + " " + t.Suffix, readOnly: true));

    async Task SetupAsync()
    {
        await t.ExecRootAsync("CREATE TABLE IF NOT EXISTS ro_victim (id INT PRIMARY KEY)");
        await t.ExecRootAsync("REPLACE INTO ro_victim VALUES (1)");
    }

    Task<ApiResult> FilterAsync(string sid, string where) =>
        t.App.GetAsync($"/s/{sid}/data?db={Uri.EscapeDataString(t.Db)}&table=ro_victim&limit=10&where={Uri.EscapeDataString(where)}");

    [DbFact]
    public async Task A_backslash_before_a_quote_cannot_hide_a_statement_under_NO_BACKSLASH_ESCAPES()
    {
        await SetupAsync();
        var mode = await t.ScalarAsync("SELECT @@GLOBAL.sql_mode");
        await t.ExecRootAsync("SET GLOBAL sql_mode = CONCAT(@@GLOBAL.sql_mode, ',NO_BACKSLASH_ESCAPES')");
        try
        {
            var sid = await RoSidAsync("RO nbe");
            await FilterAsync(sid, @"'\'); DELETE FROM ro_victim; -- '");
            Assert.Equal(1, await VictimRowsAsync());
            // Before the fix this changed the server's max_connections from a read-only session.
            var r = await t.App.PostAsync($"/s/{sid}/exec", new { database = t.Db, statements = new[] { @"SELECT '\'; SET GLOBAL max_connections = 77; -- '" } });
            Assert.NotEqual("77", await t.ScalarAsync("SELECT @@GLOBAL.max_connections"));
            Assert.Contains("not allowed in read-only mode", r.Data.ToString());
            // Backslashes in ordinary strings still work.
            var ok = (await t.App.PostAsync($"/s/{sid}/exec", new { database = t.Db, statements = new[] { @"SELECT 'C:\dir\' AS p" } })).Expect();
            Assert.DoesNotContain("not allowed", ok.ToString());
        }
        finally
        {
            await t.ExecRootAsync($"SET GLOBAL sql_mode = '{mode}'");
        }
    }

    [DbFact]
    public async Task MariaDB_executable_comments_are_refused()
    {
        await SetupAsync();
        var sid = await RoSidAsync("RO mcomment");
        var before = await t.ScalarAsync("SELECT @@GLOBAL.max_connections");
        await FilterAsync(sid, "1 /*M!); DELETE FROM ro_victim; -- */");
        Assert.Equal(1, await VictimRowsAsync());
        await t.App.PostAsync($"/s/{sid}/exec", new { database = t.Db, statements = new[] { "SELECT 1 /*M!100000 ; SET GLOBAL max_connections = 78 */" } });
        Assert.Equal(before, await t.ScalarAsync("SELECT @@GLOBAL.max_connections"));
        // MariaDB runs the comment even in a READ ONLY transaction: this wrote a file on the server before the fix.
        var outfile = await t.App.PostAsync($"/s/{sid}/exec", new { database = t.Db, statements = new[] { $"SELECT 1 /*M! INTO OUTFILE '/tmp/zawsql_ro_{t.Suffix}' */" } });
        Assert.Contains("Executable comments", outfile.Data.ToString());
    }
}
