using System.Text.Json;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

[Collection(DbCollection.Name)]
public class BrowseTests(TestDatabase t)
{
    static string?[] Row(JsonElement rows, int i) => rows[i].EnumerateArray().Select(v => v.ValueKind == JsonValueKind.Null ? null : v.GetString()).ToArray();

    [DbFact]
    public async Task Lists_databases_and_all_object_types()
    {
        var dbs = (await t.App.GetAsync($"/s/{t.Sid}/databases")).Expect().EnumerateArray().Select(x => x.GetString()).ToList();
        Assert.Contains(t.Db, dbs);

        var objs = (await t.App.GetAsync($"/s/{t.Sid}/objects?db={t.Db}")).Expect().EnumerateArray()
            .Select(o => $"{o.GetProperty("type").GetString()}:{o.GetProperty("name").GetString()}").ToList();
        Assert.Contains("table:customers", objs);
        Assert.Contains("view:v_orders", objs);
        Assert.Contains("procedure:top_customers", objs);
        Assert.Contains("function:sneaky", objs);
        Assert.Contains("trigger:trg_orders_bi", objs);
    }

    [DbFact]
    public async Task Table_metadata_includes_columns_indexes_foreign_keys_and_create_code()
    {
        var c = (await t.App.GetAsync($"/s/{t.Sid}/table?db={t.Db}&table=customers")).Expect();
        Assert.Equal(10, c.GetProperty("columns").GetArrayLength());
        var idx = c.GetProperty("indexes").EnumerateArray().ToDictionary(i => i.GetProperty("name").GetString()!, i => i.GetProperty("type").GetString());
        Assert.Equal("PRIMARY", idx["PRIMARY"]);
        Assert.Equal("UNIQUE", idx["uq_email"]);
        Assert.Equal("KEY", idx["idx_name"]);
        Assert.Contains("CREATE TABLE", c.GetProperty("create").GetString());
        Assert.Equal("Customer list", c.GetProperty("options").GetProperty("comment").GetString());

        var o = (await t.App.GetAsync($"/s/{t.Sid}/table?db={t.Db}&table=orders")).Expect();
        var fk = Assert.Single(o.GetProperty("foreignKeys").EnumerateArray());
        Assert.Equal("customers", fk.GetProperty("refTable").GetString());
        Assert.Equal("CASCADE", fk.GetProperty("onDelete").GetString());
    }

    [DbFact]
    public async Task Data_values_are_formatted_for_display()
    {
        var d = (await t.App.GetAsync($"/s/{t.Sid}/data?db={t.Db}&table=customers&limit=1000&order=id")).Expect();
        var alice = Row(d.GetProperty("rows"), 0);
        Assert.Equal("120.50", alice[3]);
        Assert.Equal("0xDEADBEEF", alice[5]);
        Assert.Equal("1", alice[6]);
        Assert.Equal("1990-05-01", alice[8]);
        Assert.Equal("line1\nline2", alice[9]);
        Assert.Matches(@"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d", alice[7]);
        Assert.Null(Row(d.GetProperty("rows"), 1)[2]);
        Assert.Equal("Zoë Ünicode", Row(d.GetProperty("rows"), 2)[1]);
        Assert.Equal("primary", d.GetProperty("keySource").GetString());

        var orders = (await t.App.GetAsync($"/s/{t.Sid}/data?db={t.Db}&table=orders&order=total&dir=desc")).Expect().GetProperty("rows");
        Assert.Equal("1E+20", Row(orders, 0)[2]);
        Assert.Contains(orders.EnumerateArray(), r => r[3].GetString() == "-01:00:00");
    }

    [DbFact]
    public async Task Where_filter_paging_and_tables_without_key()
    {
        var f = (await t.App.GetAsync($"/s/{t.Sid}/data?db={t.Db}&table=customers&where={Uri.EscapeDataString("name LIKE 'Z%'")}")).Expect();
        Assert.Equal(1, f.GetProperty("rows").GetArrayLength());

        // Page within the three seeded rows only; other tests may add customers to the shared schema.
        var page = (await t.App.GetAsync($"/s/{t.Sid}/data?db={t.Db}&table=customers&limit=2&offset=2&order=id&where={Uri.EscapeDataString("id <= 3")}")).Expect();
        Assert.Equal(1, page.GetProperty("rows").GetArrayLength());
        Assert.Equal("3", page.GetProperty("rows")[0][0].GetString());

        var logs = (await t.App.GetAsync($"/s/{t.Sid}/data?db={t.Db}&table=logs")).Expect();
        Assert.Equal("none", logs.GetProperty("keySource").GetString());

        var v = (await t.App.GetAsync($"/s/{t.Sid}/data?db={t.Db}&table=v_orders")).Expect();
        Assert.True(v.GetProperty("isView").GetBoolean());
    }

    [DbFact]
    public async Task Partitions_are_reported()
    {
        var p = (await t.App.GetAsync($"/s/{t.Sid}/table?db={t.Db}&table=sales")).Expect().GetProperty("partitions");
        Assert.Equal("RANGE", p.GetProperty("method").GetString());
        var parts = p.GetProperty("partitions").EnumerateArray().ToList();
        Assert.Equal(["p2023", "pmax"], parts.Select(x => x.GetProperty("name").GetString()));
        Assert.Equal("MAXVALUE", parts[1].GetProperty("description").GetString());
        Assert.Equal("old", parts[0].GetProperty("comment").GetString());

        var none = (await t.App.GetAsync($"/s/{t.Sid}/table?db={t.Db}&table=customers")).Expect().GetProperty("partitions");
        Assert.Equal(JsonValueKind.Null, none.ValueKind);
    }

    [DbFact]
    public async Task Show_create_and_host_information()
    {
        var code = (await t.App.GetAsync($"/s/{t.Sid}/create?db={t.Db}&type=procedure&name=top_customers")).Expect().GetProperty("code").GetString();
        Assert.Contains("top_customers", code);

        foreach (var kind in new[] { "databases", "variables", "status", "processes", "collations", "engines" })
        {
            var rs = (await t.App.GetAsync($"/s/{t.Sid}/host?kind={kind}")).Expect();
            Assert.True(rs.GetProperty("rows").GetArrayLength() > 0, kind);
        }
    }
}
