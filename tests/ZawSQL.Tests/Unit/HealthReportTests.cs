using System.Text.Json;

namespace ZawSQL.Tests.Unit;

/// <summary>How mysql.user rows (MySQL table, MariaDB view) become the facts the health checks use.</summary>
public class HealthReportTests
{
    static JsonElement Account(params (string Key, string? Value)[] cols) =>
        JsonSerializer.SerializeToElement(HealthReport.NormalizeAccount(cols.ToDictionary(c => c.Key, c => c.Value)));

    [Fact]
    public void Password_accounts_without_a_password_are_flagged()
    {
        var a = Account(("User", "app"), ("Host", "%"), ("plugin", "caching_sha2_password"), ("authentication_string", ""), ("Select_priv", "N"), ("Super_priv", "N"));
        Assert.True(a.GetProperty("emptyPassword").GetBoolean());
        Assert.False(a.GetProperty("allPrivileges").GetBoolean());
        Assert.Equal(0, a.GetProperty("admin").GetArrayLength());

        // MariaDB keeps old-style hashes in the Password column of its mysql.user view.
        Assert.False(Account(("User", "old"), ("Host", "%"), ("plugin", ""), ("authentication_string", ""), ("Password", "*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19"))
            .GetProperty("emptyPassword").GetBoolean());
        // Accounts that authenticate through the OS, PAM or LDAP have no password by design.
        Assert.False(Account(("User", "root"), ("Host", "localhost"), ("plugin", "unix_socket"), ("authentication_string", "")).GetProperty("emptyPassword").GetBoolean());
        Assert.False(Account(("User", "ops"), ("Host", "%"), ("plugin", "auth_socket"), ("authentication_string", null)).GetProperty("emptyPassword").GetBoolean());
    }

    [Fact]
    public void Administrators_roles_and_locked_accounts()
    {
        var root = Account(("User", "root"), ("Host", "%"), ("plugin", "mysql_native_password"), ("authentication_string", "*ABC"),
            ("Select_priv", "Y"), ("Super_priv", "Y"), ("Grant_priv", "Y"), ("Create_user_priv", "Y"), ("account_locked", "N"));
        Assert.True(root.GetProperty("allPrivileges").GetBoolean());
        Assert.Equal(["SUPER", "GRANT", "CREATE USER"], root.GetProperty("admin").EnumerateArray().Select(x => x.GetString()));
        Assert.False(root.GetProperty("locked").GetBoolean());

        var role = Account(("User", "reporting"), ("Host", ""), ("is_role", "Y"), ("account_locked", "Y"), ("Select_priv", "N"));
        Assert.True(role.GetProperty("isRole").GetBoolean());
        Assert.True(role.GetProperty("locked").GetBoolean());
        Assert.Equal("", role.GetProperty("host").GetString());
    }
}
