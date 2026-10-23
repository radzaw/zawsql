using System.Text.Json;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

[Collection(DbCollection.Name)]
public class ServerSettingsTests(TestDatabase t)
{
    static JsonElement Event(JsonElement list, string name) =>
        list.GetProperty("events").EnumerateArray().Single(e => e.GetProperty("name").GetString() == name);

    [DbFact]
    public async Task Events_are_listed_enabled_disabled_and_dropped()
    {
        await t.ExecRootAsync("CREATE EVENT ev_hourly ON SCHEDULE EVERY 1 HOUR STARTS '2030-01-01 00:00:00' DO DELETE FROM logs WHERE level > 99");
        await t.ExecRootAsync("CREATE EVENT ev_once ON SCHEDULE AT '2030-06-01 12:00:00' ON COMPLETION PRESERVE DISABLE COMMENT 'later' DO SELECT 1");

        var list = (await t.App.GetAsync($"/s/{t.Sid}/events")).Expect();
        Assert.Contains(list.GetProperty("scheduler").GetString(), new[] { "ON", "OFF", "DISABLED" });
        var hourly = Event(list, "ev_hourly");
        Assert.Equal(t.Db, hourly.GetProperty("db").GetString());
        Assert.Equal("RECURRING", hourly.GetProperty("type").GetString());
        Assert.Equal("HOUR", hourly.GetProperty("intervalField").GetString());
        Assert.Equal("1", hourly.GetProperty("intervalValue").GetString());
        Assert.StartsWith("2030-01-01 00:00:00", hourly.GetProperty("starts").GetString());
        Assert.NotNull(hourly.GetProperty("nowThere").GetString());
        var once = Event(list, "ev_once");
        Assert.Equal("ONE TIME", once.GetProperty("type").GetString());
        Assert.Equal("DISABLED", once.GetProperty("status").GetString());
        Assert.Equal("PRESERVE", once.GetProperty("onCompletion").GetString());
        Assert.Equal("later", once.GetProperty("comment").GetString());

        (await t.App.PostAsync($"/s/{t.Sid}/events/action", new { db = t.Db, name = "ev_once", action = "enable" })).Expect();
        (await t.App.PostAsync($"/s/{t.Sid}/events/action", new { db = t.Db, name = "ev_hourly", action = "disable" })).Expect();
        list = (await t.App.GetAsync($"/s/{t.Sid}/events")).Expect();
        Assert.Equal("ENABLED", Event(list, "ev_once").GetProperty("status").GetString());
        Assert.Equal("DISABLED", Event(list, "ev_hourly").GetProperty("status").GetString());

        foreach (var name in new[] { "ev_once", "ev_hourly" })
            (await t.App.PostAsync($"/s/{t.Sid}/events/action", new { db = t.Db, name, action = "drop" })).Expect();
        Assert.Equal("0", await t.ScalarAsync($"SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = '{t.Db}' AND EVENT_NAME LIKE 'ev\\_%'"));
    }

    [DbFact]
    public async Task Event_scheduler_can_be_switched_and_is_restored()
    {
        var before = (await t.ScalarAsync("SELECT @@global.event_scheduler"))!.ToUpperInvariant();
        if (before == "DISABLED") return; // can't be switched on such a server
        try
        {
            (await t.App.PostAsync($"/s/{t.Sid}/events/scheduler", new { on = before != "ON" })).Expect();
            Assert.Equal(before == "ON" ? "OFF" : "ON", (await t.App.GetAsync($"/s/{t.Sid}/events")).Expect().GetProperty("scheduler").GetString());
        }
        finally
        {
            await t.ExecRootAsync($"SET GLOBAL event_scheduler = {before}");
        }
    }

    [DbFact]
    public async Task Variables_show_where_they_come_from_and_can_be_changed()
    {
        var before = await t.ScalarAsync("SELECT @@global.net_read_timeout");
        try
        {
            (await t.App.PostAsync($"/s/{t.Sid}/variables/set", new { name = "net_read_timeout", scope = "global", value = "47", @default = false })).Expect();
            Assert.Equal("47", await t.ScalarAsync("SELECT @@global.net_read_timeout"));

            var rs = (await t.App.GetAsync($"/s/{t.Sid}/host?kind=variables")).Expect();
            var names = rs.GetProperty("columns").EnumerateArray().Select(c => c.GetProperty("name").GetString()).ToList();
            Assert.Equal(["Variable", "Session", "Global", "Set by", "Default", "Range", "Note"], names);
            var row = rs.GetProperty("rows").EnumerateArray().Single(r => r[0].GetString() == "net_read_timeout");
            Assert.Equal("47", row[2].GetString());
            Assert.Equal("SET GLOBAL", row[3].GetString());

            (await t.App.PostAsync($"/s/{t.Sid}/variables/set", new { name = "net_read_timeout", scope = "global", value = (string?)null, @default = true })).Expect();
            Assert.Equal("30", await t.ScalarAsync("SELECT @@global.net_read_timeout"));
        }
        finally
        {
            await t.ExecRootAsync($"SET GLOBAL net_read_timeout = {before}");
        }
    }

    [DbFact]
    public async Task Read_only_sessions_cannot_change_settings()
    {
        var sid = await t.ConnectAsync(await t.SaveSessionAsync("RO settings " + t.Suffix, readOnly: true));
        Assert.True((await t.App.GetAsync($"/s/{sid}/events")).Ok);
        Assert.False((await t.App.PostAsync($"/s/{sid}/events/scheduler", new { on = true })).Ok);
        Assert.False((await t.App.PostAsync($"/s/{sid}/events/action", new { db = t.Db, name = "x", action = "drop" })).Ok);
        Assert.False((await t.App.PostAsync($"/s/{sid}/variables/set", new { name = "net_read_timeout", scope = "global", value = "40", @default = false })).Ok);
    }
}
