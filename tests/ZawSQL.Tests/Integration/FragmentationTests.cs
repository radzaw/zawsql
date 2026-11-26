using System.Text.Json;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

[Collection(DbCollection.Name)]
public class FragmentationTests(TestDatabase t)
{
    [DbFact]
    public async Task Lists_table_sizes_and_free_space_from_the_cache_or_fresh()
    {
        var res = await t.App.GetAsync($"/s/{t.Sid}/fragmentation");
        Assert.Empty(res.Log); // read-only and not logged
        var r = res.Expect();
        Assert.Equal(t.IsMariaDb ? "mariadb" : "mysql", r.GetProperty("server").GetString());
        var tables = r.GetProperty("tables").EnumerateArray().ToList();
        var logs = tables.Single(x => x.GetProperty("schema").GetString() == t.Db && x.GetProperty("name").GetString() == "logs");
        Assert.Equal("InnoDB", logs.GetProperty("engine").GetString());
        Assert.True(logs.GetProperty("dataBytes").GetInt64() > 0);
        Assert.True(logs.GetProperty("freeBytes").GetInt64() >= 0);
        Assert.DoesNotContain(tables, x => x.GetProperty("schema").GetString() is "mysql" or "sys" or "information_schema" or "performance_schema");

        var fresh = await t.App.GetAsync($"/s/{t.Sid}/fragmentation?fresh=true");
        Assert.Empty(fresh.Log);
        Assert.True(fresh.Expect().GetProperty("fresh").GetBoolean());

        // MySQL caches the statistics; forcing fresh ones must not leave the pooled connection with the cache off.
        if (!t.IsMariaDb && r.GetProperty("statsExpiry").ValueKind == JsonValueKind.Number && r.GetProperty("statsExpiry").GetInt64() > 0)
        {
            var again = (await t.App.GetAsync($"/s/{t.Sid}/fragmentation")).Expect();
            Assert.False(again.GetProperty("fresh").GetBoolean());
            Assert.Equal(r.GetProperty("statsExpiry").GetInt64(), again.GetProperty("statsExpiry").GetInt64());
        }
    }
}
