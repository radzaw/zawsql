namespace ZawSQL.Tests.Unit;

public class GrantParserTests
{
    static UserDetail Parse(params string[] lines)
    {
        var d = new UserDetail();
        UserAdmin.ParseGrants(lines, d);
        return d;
    }

    static GrantObject Find(UserDetail d, string level, string? db = null, string? table = null, string? column = null) =>
        Assert.Single(d.Grants, g => g.Level == level && g.Db == db && g.Table == table && g.Column == column);

    [Fact]
    public void Parses_mysql_grant_levels()
    {
        var d = Parse(
            "GRANT USAGE ON *.* TO `app`@`%`",
            "GRANT BACKUP_ADMIN,AUDIT_ADMIN ON *.* TO `app`@`%`",
            "GRANT SELECT, INSERT ON `shop`.* TO `app`@`%`",
            "GRANT SELECT ON `other`.* TO `app`@`%` WITH GRANT OPTION",
            "GRANT SELECT (`id`), UPDATE (`name`, `email`) ON `shop`.`customers` TO `app`@`%`",
            "GRANT DELETE ON `shop`.`logs` TO `app`@`%`",
            "GRANT EXECUTE ON PROCEDURE `shop`.`top_customers` TO `app`@`%`",
            "GRANT `reader`@`%` TO `app`@`%`");

        Assert.Equal(["BACKUP_ADMIN", "AUDIT_ADMIN"], Find(d, "global").Privs);
        Assert.Equal(["SELECT", "INSERT"], Find(d, "db", "shop").Privs);
        Assert.True(Find(d, "db", "other").GrantOption);
        Assert.Equal(["SELECT"], Find(d, "column", "shop", "customers", "id").Privs);
        Assert.Equal(["UPDATE"], Find(d, "column", "shop", "customers", "email").Privs);
        Assert.DoesNotContain(d.Grants, g => g.Level == "table" && g.Table == "customers");
        Assert.Equal(["DELETE"], Find(d, "table", "shop", "logs").Privs);
        var routine = Find(d, "routine", "shop", "top_customers");
        Assert.Equal("PROCEDURE", routine.RoutineType);
        Assert.Equal(["EXECUTE"], routine.Privs);
        Assert.Equal(["`reader`@`%`"], d.Roles);
        Assert.Empty(d.Other);
    }

    [Fact]
    public void Parses_mariadb_specifics()
    {
        var d = Parse(
            "GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost` IDENTIFIED VIA mysql_native_password USING '*ABC' OR unix_socket WITH GRANT OPTION",
            "GRANT USAGE ON *.* TO `u`@`%` IDENTIFIED BY PASSWORD '*94BDCEBE19083CE2A1F959FD02F964C7AF4CFC29'",
            "GRANT SELECT ON `my\\_db`.* TO `u`@`%`",
            "GRANT `reader` TO `u`@`%`",
            "GRANT PROXY ON ''@'%' TO 'root'@'localhost' WITH GRANT OPTION",
            "SET DEFAULT ROLE `reader` FOR `u`@`%`");

        var global = Find(d, "global");
        Assert.True(global.All);
        Assert.True(global.GrantOption);
        Assert.Equal(["SELECT"], Find(d, "db", "my\\_db").Privs);
        Assert.Equal(["`reader`"], d.Roles);
        Assert.Equal(2, d.Other.Count); // PROXY and SET DEFAULT ROLE are shown read-only
    }

    [Fact]
    public void Quoted_names_with_special_characters()
    {
        var d = Parse("GRANT SELECT ON `we``ird.db`.`t a` TO 'o''brien'@'10.%'");
        Assert.Equal(["SELECT"], Find(d, "table", "we`ird.db", "t a").Privs);
    }
}
