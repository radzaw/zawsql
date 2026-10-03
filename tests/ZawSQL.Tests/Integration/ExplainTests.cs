using System.Text.Json;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

[Collection(DbCollection.Name)]
public class ExplainTests(TestDatabase t)
{
    Task<ApiResult> ExplainAsync(string sql, bool analyze = false, string? sid = null) =>
        t.App.PostAsync($"/s/{sid ?? t.Sid}/explain", new { sql, database = t.Db, analyze });

    [DbFact]
    public async Task Json_plan_tabular_explain_and_optimizer_notes()
    {
        var r = (await ExplainAsync("-- top customers\nEXPLAIN SELECT c.name, COUNT(*) FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.name;")).Expect();
        Assert.StartsWith("SELECT c.name", r.GetProperty("statement").GetString()); // comment, EXPLAIN and ";" removed
        using var plan = JsonDocument.Parse(r.GetProperty("json").GetString()!);
        Assert.True(plan.RootElement.GetProperty("query_block").TryGetProperty("select_id", out _));
        var table = r.GetProperty("table");
        var cols = table.GetProperty("columns").EnumerateArray().Select(c => c.GetProperty("name").GetString()).ToList();
        Assert.Contains("type", cols);
        Assert.Equal(2, table.GetProperty("rows").GetArrayLength());
        Assert.True(r.GetProperty("canAnalyze").GetBoolean());
        Assert.False(r.GetProperty("analyzed").GetBoolean());
        Assert.Equal(t.IsMariaDb ? "mariadb" : "mysql", r.GetProperty("server").GetString());
        if (!t.IsMariaDb) // MySQL adds the rewritten query as Note 1003
            Assert.Contains(r.GetProperty("notes").EnumerateArray(), n => n.GetProperty("code").GetString() == "1003");
    }

    [DbFact]
    public async Task Analyze_measures_selects_and_is_refused_for_changes()
    {
        var r = (await ExplainAsync("SELECT * FROM orders WHERE total > 10", analyze: true)).Expect();
        Assert.True(r.GetProperty("analyzed").GetBoolean());
        if (t.IsMariaDb)
            Assert.Contains("r_rows", r.GetProperty("json").GetString()); // measured values inside the JSON plan
        else
            Assert.Contains("actual time=", r.GetProperty("analyzeTree").GetString());

        var before = await t.ScalarAsync("SELECT COUNT(*) FROM logs");
        var update = await ExplainAsync("DELETE FROM logs WHERE level > 0", analyze: true);
        Assert.False(update.Ok);
        Assert.Contains("only available for SELECT", update.Error);
        // Explaining (without analyze) a DELETE shows its plan and changes nothing.
        var plain = (await ExplainAsync("DELETE FROM logs WHERE level > 0")).Expect();
        Assert.False(plain.GetProperty("canAnalyze").GetBoolean());
        Assert.Equal(before, await t.ScalarAsync("SELECT COUNT(*) FROM logs"));
    }

    [DbFact]
    public async Task Only_explainable_statements_and_read_only_sessions_can_explain()
    {
        var bad = await ExplainAsync("DROP TABLE customers");
        Assert.False(bad.Ok);
        Assert.Contains("can be explained", bad.Error);
        Assert.False((await ExplainAsync("  ;  ")).Ok);
        Assert.Equal("1", await t.ScalarAsync($"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '{t.Db}' AND TABLE_NAME = 'customers'"));

        // Read-only sessions explain (and analyze) SELECTs; the server refuses EXPLAIN of changes in a read-only transaction.
        var roSid = await t.ConnectAsync(await t.SaveSessionAsync("RO explain", readOnly: true));
        (await ExplainAsync("SELECT * FROM customers WHERE id = 1", sid: roSid)).Expect();
        (await ExplainAsync("SELECT * FROM customers", analyze: true, sid: roSid)).Expect();
        var change = await ExplainAsync("UPDATE customers SET name = 'x' WHERE id = 1", sid: roSid);
        Assert.False(change.Ok);
        Assert.Contains("read-only", change.Error);
    }

    [Theory]
    [InlineData("EXPLAIN FORMAT=JSON SELECT 1;", "SELECT 1")]
    [InlineData("explain analyze select 1", "select 1")]
    [InlineData("ANALYZE FORMAT=JSON SELECT 1", "SELECT 1")]
    [InlineData("/* x */ DESC SELECT * FROM t", "SELECT * FROM t")]
    [InlineData("WITH a AS (SELECT 1) SELECT * FROM a", "WITH a AS (SELECT 1) SELECT * FROM a")]
    public void Statement_prefixes_are_removed(string sql, string expected) => Assert.Equal(expected, Explainer.Statement(sql));

    [Theory]
    [InlineData("SELECT 1", true, true)]
    [InlineData("(SELECT 1) UNION (SELECT 2)", true, true)]
    [InlineData("UPDATE t SET a = 1", true, false)]
    [InlineData("SELECT * FROM t INTO OUTFILE '/tmp/x'", true, false)]
    [InlineData("SHOW TABLES", false, false)]
    public void Explainable_and_analyzable(string stmt, bool explainable, bool analyzable)
    {
        Assert.Equal(explainable, Explainer.IsExplainable(stmt));
        Assert.Equal(analyzable, Explainer.CanAnalyze(stmt));
    }
}
