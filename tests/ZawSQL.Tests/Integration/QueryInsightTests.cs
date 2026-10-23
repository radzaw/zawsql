using System.Text.Json;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

/// <summary>Statement statistics, index suggestions' inputs, the error log and the InnoDB status.</summary>
[Collection(DbCollection.Name)]
public class QueryInsightTests(TestDatabase t)
{
    static long Counter(JsonElement stat, string name) =>
        stat.GetProperty("counters").TryGetProperty(name, out var v) ? v.GetInt64() : 0;

    [DbFact]
    public async Task Statement_statistics_show_scans_and_lookups()
    {
        var r = (await t.App.PostAsync($"/s/{t.Sid}/exec", new
        {
            statements = new[] { "SELECT * FROM logs WHERE level = 1", "SELECT name FROM customers WHERE id = 1", "SELECT * FROM customers ORDER BY balance" },
            database = t.Db, stats = true,
        })).Expect();
        var stats = r.GetProperty("stats").EnumerateArray().ToList();
        Assert.Equal([0, 1, 2], stats.Select(s => s.GetProperty("statement").GetInt32()));
        Assert.True(Counter(stats[0], "Handler_read_rnd_next") >= 3, stats[0].ToString()); // a full scan of the 3 rows
        Assert.True(Counter(stats[1], "Handler_read_key") >= 1, stats[1].ToString());     // a primary key lookup
        Assert.True(Counter(stats[1], "Handler_read_rnd_next") < 3, stats[1].ToString());  // reading the counters isn't counted
        Assert.True(Counter(stats[2], "Sort_rows") >= 3, stats[2].ToString());
        Assert.Equal(3, r.GetProperty("resultSets").GetArrayLength());

        var plain = (await t.App.PostAsync($"/s/{t.Sid}/exec", new { statements = new[] { "SELECT 1" }, database = t.Db })).Expect();
        Assert.Equal(JsonValueKind.Null, plain.GetProperty("stats").ValueKind);
    }

    [DbFact]
    public async Task Explain_names_the_current_database()
    {
        var r = (await t.App.PostAsync($"/s/{t.Sid}/explain", new { sql = "SELECT * FROM logs WHERE level = 2", database = t.Db })).Expect();
        Assert.Equal(t.Db, r.GetProperty("database").GetString());
    }

    [DbFact]
    public async Task Error_log_is_read_or_explained()
    {
        var r = (await t.App.GetAsync($"/s/{t.Sid}/errorlog?limit=50")).Expect();
        Assert.NotNull(r.GetProperty("file").GetString());
        if (t.IsMariaDb)
        {
            Assert.False(r.GetProperty("available").GetBoolean());
            Assert.Contains("MariaDB", r.GetProperty("reason").GetString());
            return;
        }
        Assert.True(r.GetProperty("available").GetBoolean(), r.GetProperty("reason").GetString());
        var rows = r.GetProperty("rows").EnumerateArray().ToList();
        Assert.InRange(rows.Count, 1, 50); // a running server has logged at least its start-up
        Assert.Contains(rows, x => x.GetProperty("prio").GetString() == "System");
        Assert.NotNull(r.GetProperty("now").GetString());
    }

    [DbFact]
    public async Task Innodb_status_text_is_returned()
    {
        var r = (await t.App.GetAsync($"/s/{t.Sid}/innodb")).Expect();
        var status = r.GetProperty("status").GetString()!;
        Assert.Contains("TRANSACTIONS", status);
        Assert.Contains("BUFFER POOL AND MEMORY", status);
    }
}
