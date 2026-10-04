using System.Text.Json;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

[Collection(DbCollection.Name)]
public class HealthTests(TestDatabase t)
{
    static IEnumerable<JsonElement> Where(JsonElement list, string schema, string table, string tableProp = "table") =>
        list.EnumerateArray().Where(x => x.GetProperty("schema").GetString() == schema && x.GetProperty(tableProp).GetString() == table);

    [DbFact]
    public async Task Collects_the_facts_the_checks_need()
    {
        var s = t.Suffix;
        var user = $"zt_hc_{s}";
        // Problems the report should surface: no primary key, a non-InnoDB table, a redundant index,
        // an auto-increment column close to its maximum, a latin1 table and an account without a password.
        await t.ExecRootAsync($"CREATE TABLE hc_nopk_{s} (a INT, b INT, KEY ab (a, b), KEY a_only (a)) ENGINE=InnoDB");
        await t.ExecRootAsync($"CREATE TABLE hc_myisam_{s} (id INT PRIMARY KEY) ENGINE=MyISAM");
        await t.ExecRootAsync($"CREATE TABLE hc_ai_{s} (id TINYINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, v INT) AUTO_INCREMENT=240");
        await t.ExecRootAsync($"CREATE TABLE hc_latin_{s} (id INT PRIMARY KEY, name VARCHAR(20)) CHARACTER SET latin1");
        t.CleanupLater($"user:'{user}'@'%'");
        await t.ExecRootAsync($"CREATE USER '{user}'@'%'");

        var res = await t.App.GetAsync($"/s/{t.Sid}/health");
        Assert.Empty(res.Log); // read-only and not logged
        var r = res.Expect();
        if (Environment.GetEnvironmentVariable("ZAWSQL_HEALTH_DUMP") is { Length: > 0 } dump)
            await File.WriteAllTextAsync(dump, JsonSerializer.Serialize(r, new JsonSerializerOptions { WriteIndented = true }));

        Assert.Equal(t.IsMariaDb ? "mariadb" : "mysql", r.GetProperty("server").GetString());
        Assert.True(r.GetProperty("variables").TryGetProperty("max_connections", out _));
        Assert.True(r.GetProperty("status").TryGetProperty("Uptime", out _));
        Assert.Contains(t.Db, r.GetProperty("schemas").EnumerateArray().Select(x => x.GetString()));
        Assert.DoesNotContain("mysql", r.GetProperty("schemas").EnumerateArray().Select(x => x.GetString()));

        var tables = r.GetProperty("tables");
        Assert.Equal("MyISAM", Where(tables, t.Db, $"hc_myisam_{s}", "name").Single().GetProperty("engine").GetString());
        Assert.StartsWith("latin1", Where(tables, t.Db, $"hc_latin_{s}", "name").Single().GetProperty("collation").GetString());
        Assert.DoesNotContain(tables.EnumerateArray(), x => x.GetProperty("schema").GetString() == "mysql");

        var nopk = Where(r.GetProperty("indexes"), t.Db, $"hc_nopk_{s}").ToList();
        Assert.Equal(["a_only", "ab"], nopk.Select(x => x.GetProperty("name").GetString()).Order());
        Assert.Equal(["a", "b"], nopk.Single(x => x.GetProperty("name").GetString() == "ab").GetProperty("columns").EnumerateArray().Select(x => x.GetString()));
        Assert.DoesNotContain(nopk, x => x.GetProperty("name").GetString() == "PRIMARY");

        var ai = Where(r.GetProperty("autoIncrement"), t.Db, $"hc_ai_{s}").Single();
        Assert.Equal("tinyint", ai.GetProperty("type").GetString());
        Assert.True(ai.GetProperty("unsigned").GetBoolean());
        Assert.True(ai.GetProperty("next").GetDecimal() >= 240);

        var account = r.GetProperty("accounts").EnumerateArray().Single(a => a.GetProperty("user").GetString() == user);
        Assert.True(account.GetProperty("emptyPassword").GetBoolean());
        Assert.False(account.GetProperty("allPrivileges").GetBoolean());
        // The test account (root) is an administrator.
        Assert.Contains(r.GetProperty("accounts").EnumerateArray(), a => a.GetProperty("admin").GetArrayLength() > 0);

        Assert.True(r.GetProperty("replication").TryGetProperty("role", out _));
        if (r.GetProperty("performanceSchema").GetBoolean())
            Assert.Equal(JsonValueKind.Array, r.GetProperty("unusedIndexes").ValueKind);
        else
            Assert.Equal(JsonValueKind.Null, r.GetProperty("unusedIndexes").ValueKind);
    }

    [DbFact]
    public async Task A_user_without_access_to_mysql_user_still_gets_a_report()
    {
        var user = $"zt_hc_lo_{t.Suffix}";
        t.CleanupLater($"user:'{user}'@'%'");
        await t.ExecRootAsync($"CREATE USER '{user}'@'%' IDENTIFIED BY 'Secret_123'");
        await t.ExecRootAsync($"GRANT SELECT ON `{t.Db}`.* TO '{user}'@'%'");
        var sid = (await t.App.PostAsync("/connect", new { profile = new { name = "health", host = TestServer.Host, port = TestServer.Port, user }, password = "Secret_123" }))
            .Expect().GetProperty("sid").GetString()!;
        var r = (await t.App.GetAsync($"/s/{sid}/health")).Expect();
        Assert.Equal(JsonValueKind.Null, r.GetProperty("accounts").ValueKind);
        Assert.Contains(r.GetProperty("notes").EnumerateArray(), n => n.GetString()!.Contains("mysql.user"));
        // Only what the user can see: their database's tables.
        Assert.All(r.GetProperty("tables").EnumerateArray(), x => Assert.Equal(t.Db, x.GetProperty("schema").GetString()));
    }
}
