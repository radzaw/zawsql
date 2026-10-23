namespace ZawSQL.Tests.Unit;

public class ServerSettingsTests
{
    [Theory]
    [InlineData("global", "200", false, "SET GLOBAL max_connections = 200")]
    [InlineData("persist", "ON", false, "SET PERSIST max_connections = 'ON'")]
    [InlineData("persist_only", "x'y", false, "SET PERSIST_ONLY max_connections = 'x''y'")]
    [InlineData("global", "ignored", true, "SET GLOBAL max_connections = DEFAULT")]
    [InlineData("reset_persist", null, false, "RESET PERSIST IF EXISTS max_connections")]
    public void Variable_statements(string scope, string? value, bool toDefault, string expected) =>
        Assert.Equal(expected, ServerSettings.SetStatement(new SetVariableRequest("max_connections", scope, value, toDefault), false));

    [Fact]
    public void Component_variables_have_a_dot()
    {
        Assert.Equal("SET GLOBAL validate_password.length = 12",
            ServerSettings.SetStatement(new SetVariableRequest("validate_password.length", "global", "12", false), false));
    }

    [Theory]
    [InlineData("max_connections = 1; DROP TABLE x")]
    [InlineData("`a`")]
    [InlineData("a.b.c")]
    [InlineData("")]
    public void Only_variable_names_are_accepted(string name) =>
        Assert.Throws<ApiException>(() => ServerSettings.SetStatement(new SetVariableRequest(name, "global", "1", false), false));

    [Fact]
    public void Unknown_scope_is_refused() =>
        Assert.Throws<ApiException>(() => ServerSettings.SetStatement(new SetVariableRequest("x", "session", "1", false), false));

    [Theory]
    [InlineData("enable", "ALTER EVENT `shop`.`nightly` ENABLE")]
    [InlineData("disable", "ALTER EVENT `shop`.`nightly` DISABLE")]
    [InlineData("drop", "DROP EVENT `shop`.`nightly`")]
    public void Event_statements(string action, string expected) =>
        Assert.Equal(expected, ServerSettings.EventStatement(new EventActionRequest("shop", "nightly", action)));

    [Fact]
    public void Event_names_are_quoted_and_unknown_actions_refused()
    {
        Assert.Equal("ALTER EVENT `a``b`.`c` ENABLE", ServerSettings.EventStatement(new EventActionRequest("a`b", "c", "enable")));
        Assert.Throws<ApiException>(() => ServerSettings.EventStatement(new EventActionRequest("a", "b", "run")));
    }
}
