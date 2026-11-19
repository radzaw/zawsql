using System.Text.Json;
using MySqlConnector;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

[Collection(DbCollection.Name)]
public class BinlogTests(TestDatabase t)
{
    [Fact]
    public void Events_statements_for_mysql_and_mariadb()
    {
        Assert.Equal("SHOW BINLOG EVENTS LIMIT 11", Binlog.EventsSql(false, false, null, 0, 11, null));
        Assert.Equal("SHOW BINLOG EVENTS IN 'binlog.000002' FROM 157 LIMIT 501", Binlog.EventsSql(false, false, "binlog.000002", 157, 501, "ignored"));
        Assert.Equal("SHOW RELAYLOG EVENTS IN 'r.000003' FROM 4 LIMIT 10 FOR CHANNEL 'eu'", Binlog.EventsSql(false, true, "r.000003", 4, 10, "eu"));
        Assert.Equal("SHOW RELAYLOG EVENTS IN 'r.000003' LIMIT 10", Binlog.EventsSql(false, true, "r.000003", 0, 10, ""));
        Assert.Equal("SHOW RELAYLOG 'eu' EVENTS IN 'r.000003' LIMIT 10", Binlog.EventsSql(true, true, "r.000003", 0, 10, "eu"));
        Assert.Equal("SHOW BINLOG EVENTS IN 'it''s' LIMIT 1", Binlog.EventsSql(false, false, "it's", 0, 1, null));
    }

    [DbFact]
    public async Task Files_and_pages_of_events_of_the_binary_log()
    {
        var f = (await t.App.GetAsync($"/s/{t.Sid}/binlog/files")).Expect();
        if (!f.GetProperty("logBin").GetBoolean())
        {
            Assert.Contains("log_bin", f.GetProperty("reason").GetString());
            return;
        }
        await t.ExecRootAsync("CREATE TABLE bl_probe (id INT PRIMARY KEY)");
        await t.ExecRootAsync("INSERT INTO bl_probe VALUES (1), (2), (3)");
        f = (await t.App.GetAsync($"/s/{t.Sid}/binlog/files")).Expect();
        var files = f.GetProperty("files");
        Assert.True(files.GetArrayLength() >= 1);
        var file = files[files.GetArrayLength() - 1].GetProperty("name").GetString();
        Assert.Equal(file, f.GetProperty("current").GetProperty("file").GetString());

        var r = await t.App.GetAsync($"/s/{t.Sid}/binlog/events?log=binary&file={Uri.EscapeDataString(file!)}&limit=5000");
        Assert.Empty(r.Log); // browsing is not logged
        var all = r.Expect().GetProperty("events").EnumerateArray().ToList();
        Assert.Equal("Format_desc", all[0].GetProperty("type").GetString());
        Assert.Contains(all, e => (e.GetProperty("info").GetString() ?? "").Contains("CREATE TABLE bl_probe"));

        // Pages follow on from each other without gaps or overlaps.
        var p1 = (await t.App.GetAsync($"/s/{t.Sid}/binlog/events?file={Uri.EscapeDataString(file!)}&limit=2")).Expect();
        Assert.Equal(2, p1.GetProperty("events").GetArrayLength());
        var next = p1.GetProperty("next").GetInt64();
        Assert.Equal(all[2].GetProperty("pos").GetInt64(), next);
        var p2 = (await t.App.GetAsync($"/s/{t.Sid}/binlog/events?file={Uri.EscapeDataString(file!)}&from={next}&limit=2")).Expect();
        Assert.Equal(next, p2.GetProperty("events")[0].GetProperty("pos").GetInt64());

        // The end of the file: no next page.
        var last = all[^1].GetProperty("pos").GetInt64();
        var end = (await t.App.GetAsync($"/s/{t.Sid}/binlog/events?file={Uri.EscapeDataString(file!)}&from={last}&limit=10")).Expect();
        Assert.Equal(JsonValueKind.Null, end.GetProperty("next").ValueKind);

        Assert.False((await t.App.GetAsync($"/s/{t.Sid}/binlog/events?log=nope")).Ok);
    }

    [ReplicaFact]
    public async Task The_relay_log_of_a_replica_channel()
    {
        var p = (await t.App.PostAsync("/sessions", new
        {
            name = "Replica binlog", host = TestReplica.Host, port = TestReplica.Port, user = TestServer.User, password = TestServer.Password, savePassword = true,
        })).Expect();
        var sid = await t.ConnectAsync(p.GetProperty("id").GetString()!);
        await t.ExecRootAsync("CREATE TABLE bl_relay (id INT PRIMARY KEY)");
        var f = (await t.App.GetAsync($"/s/{sid}/binlog/files")).Expect();
        var relay = f.GetProperty("relay")[0];
        var file = relay.GetProperty("file").GetString()!;
        JsonElement events = default;
        for (var i = 0; i < 50; i++)
        {
            events = (await t.App.GetAsync($"/s/{sid}/binlog/events?log=relay&channel={Uri.EscapeDataString(relay.GetProperty("channel").GetString()!)}&file={Uri.EscapeDataString(file)}&limit=5000")).Expect().GetProperty("events");
            if (events.EnumerateArray().Any(e => (e.GetProperty("info").GetString() ?? "").Contains("bl_relay"))) return;
            await Task.Delay(100);
            file = (await t.App.GetAsync($"/s/{sid}/binlog/files")).Expect().GetProperty("relay")[0].GetProperty("file").GetString()!;
        }
        Assert.Fail("the CREATE TABLE never showed up in the relay log: " + events);
    }
}
