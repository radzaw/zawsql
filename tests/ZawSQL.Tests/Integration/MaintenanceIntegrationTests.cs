using System.Text.Json;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

[Collection(DbCollection.Name)]
public class MaintenanceIntegrationTests(TestDatabase t)
{
    async Task<JsonElement> RunAsync(string sid, string op, string[] tables, params string[] options) =>
        (await t.App.PostAsync($"/s/{sid}/maintenance", new { db = t.Db, tables, op, options })).Expect();

    static List<string[]> Rows(JsonElement rs) =>
        rs.GetProperty("rows").EnumerateArray().Select(r => r.EnumerateArray().Select(v => v.ValueKind == JsonValueKind.Null ? "" : v.GetString()!).ToArray()).ToList();

    [DbFact]
    public async Task Check_analyze_and_optimize_report_per_table_status()
    {
        var check = Rows(await RunAsync(t.Sid, "check", ["customers", "orders"], "MEDIUM"));
        Assert.Contains(check, r => r[0].EndsWith(".customers") && r[1] == "check" && r[2] == "status" && r[3] == "OK");
        Assert.Contains(check, r => r[0].EndsWith(".orders") && r[3] == "OK");

        var analyze = Rows(await RunAsync(t.Sid, "analyze", ["customers"]));
        Assert.Contains(analyze, r => r[1] == "analyze" && r[2] == "status");

        // InnoDB answers OPTIMIZE with a note ("recreate + analyze") followed by status OK.
        var optimize = Rows(await RunAsync(t.Sid, "optimize", ["logs"], "LOCAL"));
        Assert.Contains(optimize, r => r[1] == "optimize" && r[2] == "status" && r[3] == "OK");
        Assert.Equal("3", await t.ScalarAsync("SELECT COUNT(*) FROM logs")); // data untouched
    }

    [DbFact]
    public async Task Checksum_is_stable_and_repair_explains_unsupported_engines()
    {
        var a = Rows(await RunAsync(t.Sid, "checksum", ["customers"]));
        var b = Rows(await RunAsync(t.Sid, "checksum", ["customers"], "EXTENDED"));
        Assert.Matches(@"^\d+$", a[0][1]);
        Assert.Equal(a[0][1], b[0][1]);

        var repair = Rows(await RunAsync(t.Sid, "repair", ["customers"]));
        Assert.Contains(repair, r => r[1] == "repair"); // InnoDB: "doesn't support repair" note
    }

    [DbFact]
    public async Task Read_only_sessions_may_only_check_and_checksum()
    {
        var sid = await t.ConnectAsync(await t.SaveSessionAsync("RO maint " + t.Suffix, readOnly: true));
        Assert.Contains(Rows(await RunAsync(sid, "check", ["customers"])), r => r[3] == "OK");
        Assert.NotEmpty(Rows(await RunAsync(sid, "checksum", ["customers"])));
        foreach (var op in new[] { "analyze", "optimize", "repair" })
        {
            var r = await t.App.PostAsync($"/s/{sid}/maintenance", new { db = t.Db, tables = new[] { "customers" }, op });
            Assert.False(r.Ok, op);
            Assert.Contains("read-only", r.Error);
        }
    }

    [DbFact]
    public async Task Invalid_requests_never_reach_the_server()
    {
        var r = await t.App.PostAsync($"/s/{t.Sid}/maintenance", new { db = t.Db, tables = new[] { "customers" }, op = "optimize", options = new[] { "EXTENDED; DROP TABLE customers" } });
        Assert.False(r.Ok);
        Assert.Empty(r.Log);
        Assert.Equal("3", (await t.ScalarAsync("SELECT COUNT(*) FROM customers WHERE id <= 3")));
    }
}
