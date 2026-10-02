using System.Text.Json;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

[Collection(DbCollection.Name)]
public class MonitorTests(TestDatabase t)
{
    [DbFact]
    public async Task Sample_has_counters_variables_and_active_queries_and_is_not_logged()
    {
        var sid = await t.ConnectAsync(t.ProfileId); // own session: its long query must show up as active
        var sleeping = t.App.PostAsync($"/s/{sid}/exec", new { statements = new[] { "SELECT SLEEP(3) AS zawsql_monitor_probe" } });
        await Task.Delay(800);

        var r = await t.App.GetAsync($"/s/{t.Sid}/monitor");
        var s = r.Expect();
        Assert.Empty(r.Log); // polled every few seconds; must not flood the SQL log

        var status = s.GetProperty("status");
        foreach (var key in new[] { "Uptime", "Questions", "Com_select", "Threads_connected", "Threads_running", "Bytes_received", "Bytes_sent", "Handler_read_key", "Handler_write", "Innodb_buffer_pool_pages_total" })
            Assert.True(status.TryGetProperty(key, out var v) && v.GetInt64() >= 0, key);
        // MySQL still has the InnoDB row counters; MariaDB dropped them (the UI falls back to Handler_*).
        Assert.Equal(!t.IsMariaDb, status.TryGetProperty("Innodb_rows_read", out _));
        Assert.True(status.GetProperty("Threads_connected").GetInt64() >= 2);
        Assert.True(long.Parse(s.GetProperty("variables").GetProperty("max_connections").GetString()!) > 0);
        Assert.True(s.GetProperty("t").GetInt64() > 1_700_000_000_000);

        var active = s.GetProperty("active");
        var cols = active.GetProperty("columns").EnumerateArray().Select(c => c.GetProperty("name").GetString()).ToList();
        var queryIdx = cols.IndexOf("Query");
        var queries = active.GetProperty("rows").EnumerateArray().Select(row => row[queryIdx].ValueKind == JsonValueKind.Null ? "" : row[queryIdx].GetString()).ToList();
        Assert.Contains(queries, q => q!.Contains("zawsql_monitor_probe"));
        Assert.DoesNotContain(queries, q => q!.Contains("information_schema.PROCESSLIST")); // its own query is excluded

        (await sleeping).Expect();
        (await t.App.PostAsync($"/s/{sid}/disconnect")).Expect();
    }

    [DbFact]
    public async Task Counters_increase_between_samples()
    {
        var a = (await t.App.GetAsync($"/s/{t.Sid}/monitor")).Expect().GetProperty("status");
        await t.ExecAsync("SELECT 1", "SELECT 2", "SELECT 3", "SELECT 4", "SELECT 5");
        var b = (await t.App.GetAsync($"/s/{t.Sid}/monitor")).Expect().GetProperty("status");
        // 5 SELECTs plus the monitor's own statements; Questions counts every client statement.
        Assert.True(b.GetProperty("Questions").GetInt64() - a.GetProperty("Questions").GetInt64() >= 5 + ServerMonitor.OwnStatements);
        Assert.True(b.GetProperty("Com_select").GetInt64() - a.GetProperty("Com_select").GetInt64() >= 5);
    }
}
