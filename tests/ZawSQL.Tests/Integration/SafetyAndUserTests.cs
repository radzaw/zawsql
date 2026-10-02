using MySqlConnector;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

[Collection(DbCollection.Name)]
public class SafetyAndUserTests(TestDatabase t)
{
    [DbFact]
    public async Task Read_only_session_blocks_changes_at_both_layers()
    {
        var sid = await t.ConnectAsync(await t.SaveSessionAsync("RO " + t.Suffix, readOnly: true));
        var before = await t.ScalarAsync("SELECT COUNT(*) FROM logs");

        var ok = (await t.App.PostAsync($"/s/{sid}/exec", new { statements = new[] { "SELECT COUNT(*) FROM customers", "SHOW CREATE TABLE customers" }, database = t.Db })).Expect();
        Assert.Empty(ok.GetProperty("errors").EnumerateArray());

        foreach (var sql in new[] { "DELETE FROM logs", "DROP TABLE logs", "SET SESSION TRANSACTION READ WRITE", "SELECT 1; DELETE FROM logs", "/*!40101 DELETE FROM logs */" })
        {
            var r = (await t.App.PostAsync($"/s/{sid}/exec", new { statements = new[] { sql }, database = t.Db })).Expect();
            var err = Assert.Single(r.GetProperty("errors").EnumerateArray());
            Assert.Equal(0, err.GetProperty("code").GetInt32()); // blocked by ZawSQL, never sent
        }

        // Second layer: the server itself refuses the write hidden inside a function.
        var fn = (await t.App.PostAsync($"/s/{sid}/exec", new { statements = new[] { "SELECT sneaky()" }, database = t.Db })).Expect();
        Assert.Equal(1792, Assert.Single(fn.GetProperty("errors").EnumerateArray()).GetProperty("code").GetInt32());

        Assert.False((await t.App.PostAsync($"/s/{sid}/rows", new { db = t.Db, table = "logs", ops = new[] { new { op = "delete", original = new { msg = "bye", level = "2", at = (string?)null } } } })).Ok);
        Assert.False((await t.App.PostAsync($"/s/{sid}/kill", new { id = 1 })).Ok);
        Assert.False((await t.App.PostAsync($"/s/{sid}/users/apply", new { statements = new[] { "DROP USER 'x'@'%'" } })).Ok);
        Assert.Equal(before, await t.ScalarAsync("SELECT COUNT(*) FROM logs"));
        Assert.True((await t.App.GetAsync($"/s/{sid}/users")).Ok); // viewing is fine
    }

    [DbFact]
    public async Task Session_info_reports_color_and_production()
    {
        var sid = await t.ConnectAsync(await t.SaveSessionAsync("Prod " + t.Suffix, production: true, color: "#d13438"));
        var info = (await t.App.GetAsync($"/s/{sid}/info")).Expect();
        Assert.True(info.GetProperty("production").GetBoolean());
        Assert.Equal("#d13438", info.GetProperty("color").GetString());
        Assert.False(info.GetProperty("readOnly").GetBoolean());
    }

    [DbFact]
    public async Task User_manager_creates_parses_renames_and_drops_accounts()
    {
        var user = "zt_u" + t.Suffix;
        var renamed = user + "b";
        t.CleanupLater($"user:'{user}'@'%'");
        t.CleanupLater($"user:'{renamed}'@'%'");
        const string password = "Pw-123-secret!";

        var create = (await t.App.PostAsync($"/s/{t.Sid}/users/apply", new
        {
            statements = new[]
            {
                $"CREATE USER '{user}'@'%' IDENTIFIED BY {UserAdmin.PasswordToken}",
                $"GRANT SELECT, INSERT ON `{t.Db}`.* TO '{user}'@'%'",
                $"GRANT SELECT (`id`), UPDATE (`name`) ON `{t.Db}`.`customers` TO '{user}'@'%'",
                $"GRANT EXECUTE ON PROCEDURE `{t.Db}`.`top_customers` TO '{user}'@'%'",
                $"GRANT SELECT ON `{t.Db}`.`logs` TO '{user}'@'%' WITH GRANT OPTION",
            },
            password,
        }));
        var data = create.Expect();
        Assert.Equal(5, data.GetProperty("executed").GetInt32());
        Assert.DoesNotContain(create.Log, l => l.Contains(password));
        Assert.Contains(create.Log, l => l.Contains("'***'"));

        await using (var login = new MySqlConnection(TestServer.ConnectionString(user, password, t.Db)))
            await login.OpenAsync();

        var users = (await t.App.GetAsync($"/s/{t.Sid}/users")).Expect().EnumerateArray().Select(u => u.GetProperty("user").GetString()).ToList();
        Assert.Contains(user, users);

        var d = (await t.App.GetAsync($"/s/{t.Sid}/user?user={user}&host=%25")).Expect();
        var grants = d.GetProperty("grants").EnumerateArray()
            .Select(g => $"{g.GetProperty("level").GetString()}|{g.GetProperty("table").GetString()}|{g.GetProperty("column").GetString()}|{string.Join(",", g.GetProperty("privs").EnumerateArray().Select(p => p.GetString()))}|{g.GetProperty("grantOption").GetBoolean()}")
            .ToList();
        Assert.Contains("db|||SELECT,INSERT|False", grants);
        Assert.Contains("column|customers|id|SELECT|False", grants);
        Assert.Contains("column|customers|name|UPDATE|False", grants);
        Assert.Contains("routine|top_customers||EXECUTE|False", grants);
        Assert.Contains("table|logs||SELECT|True", grants);

        var rename = await t.App.PostAsync($"/s/{t.Sid}/users/apply", new { statements = new[] { $"RENAME USER '{user}'@'%' TO '{renamed}'@'%'", $"REVOKE INSERT ON `{t.Db}`.* FROM '{renamed}'@'%'" } });
        rename.Expect();
        var after = (await t.App.GetAsync($"/s/{t.Sid}/user?user={renamed}&host=%25")).Expect();
        Assert.Contains(after.GetProperty("grants").EnumerateArray(), g => g.GetProperty("level").GetString() == "db"
            && g.GetProperty("privs").EnumerateArray().Select(p => p.GetString()).SequenceEqual(["SELECT"]));

        var failing = (await t.App.PostAsync($"/s/{t.Sid}/users/apply", new { statements = new[] { $"GRANT SELECT ON `{t.Db}`.* TO '{renamed}'@'%'", "GRANT NOPE ON *.* TO 'x'@'%'" } })).Expect();
        Assert.Equal(1, failing.GetProperty("executed").GetInt32());
        Assert.Equal(1, failing.GetProperty("error").GetProperty("statement").GetInt32());

        (await t.App.PostAsync($"/s/{t.Sid}/users/apply", new { statements = new[] { $"DROP USER '{renamed}'@'%'" } })).Expect();
        Assert.Equal("0", await t.ScalarAsync($"SELECT COUNT(*) FROM mysql.user WHERE User = '{renamed}'"));
    }

    [DbFact]
    public async Task Roles_are_listed_on_the_account()
    {
        var user = "zt_r" + t.Suffix;
        var role = "zt_role" + t.Suffix;
        t.CleanupLater($"user:'{user}'@'%'");
        t.CleanupLater($"role:{role}");
        await t.ExecRootAsync($"CREATE ROLE {role}");
        await t.ExecRootAsync($"CREATE USER '{user}'@'%'");
        await t.ExecRootAsync($"GRANT {role} TO '{user}'@'%'");
        var d = (await t.App.GetAsync($"/s/{t.Sid}/user?user={user}&host=%25")).Expect();
        var roles = d.GetProperty("roles").EnumerateArray().Select(r => r.GetString()!).ToList();
        Assert.Single(roles);
        Assert.Contains(role, roles[0]);
    }
}
