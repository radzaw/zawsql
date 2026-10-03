using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Integration;

[Collection(DbCollection.Name)]
public class ImportTests(TestDatabase t)
{
    static ImportTests() => Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

    async Task<string> UploadAsync(string name, byte[] bytes)
    {
        using var res = await t.App.Http.PostAsync("/api/import/upload?name=" + Uri.EscapeDataString(name), new ByteArrayContent(bytes));
        var json = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(json.GetProperty("ok").GetBoolean(), json.GetProperty("error").ToString());
        return json.GetProperty("data").GetProperty("id").GetString()!;
    }

    /// <summary>Runs an import to the end in small steps; returns the last step and every error.</summary>
    async Task<(JsonElement last, List<JsonElement> errors, string[] log)> ImportAsync(object start, string? sid = null)
    {
        sid ??= t.Sid;
        var s = await t.App.PostAsync($"/s/{sid}/import/start", start);
        var job = s.Expect().GetProperty("jobId").GetString();
        var errors = new List<JsonElement>();
        var log = new List<string>(s.Log);
        for (var i = 0; i < 100; i++)
        {
            var step = await t.App.PostAsync($"/s/{sid}/import/step", new { jobId = job, rows = 2 });
            log.AddRange(step.Log);
            var r = step.Expect();
            errors.AddRange(r.GetProperty("errors").EnumerateArray());
            if (r.GetProperty("done").GetBoolean()) return (r, errors, log.ToArray());
        }
        throw new Exception("import did not finish");
    }

    string Table(string name) => name + "_" + Guid.NewGuid().ToString("n")[..6];

    [DbFact]
    public async Task Csv_in_windows_1250_with_decimal_commas_and_dates_creates_a_table()
    {
        var csv = "id;name;price;born;note\r\n1;Zażółć;12,50;31.12.1990;\r\n2;\"Gęślą; \"\"jaźń\"\"\nline 2\";3;01.02.2001;\\N\r\n3;Ann;1 000,25;15.06.1985;x\r\n";
        var file = await UploadAsync("people.csv", Encoding.GetEncoding(1250).GetBytes(csv));
        var source = new { encoding = "windows-1250", delimiter = "", quote = "\"", header = true, skipRows = 0 };

        var p = (await t.App.PostAsync("/import/preview", new { fileId = file, source, decimalComma = true })).Expect();
        Assert.Equal(3, p.GetProperty("totalRows").GetInt64());
        Assert.Equal("DMY", p.GetProperty("suggestedDateOrder").GetString());
        var cols = p.GetProperty("columns").EnumerateArray().Select(c => new { name = c.GetProperty("name").GetString(), type = c.GetProperty("type").GetString() }).ToArray();
        Assert.Equal("DECIMAL(6,2)", cols[2].type);

        var table = Table("people");
        var (last, errors, log) = await ImportAsync(new
        {
            fileId = file, source, db = t.Db, table, create = cols,
            mapping = cols.Select((c, i) => new { source = i, column = c.name }),
            decimalComma = true, dateOrder = "DMY",
        });
        Assert.Empty(errors);
        Assert.Equal(3, last.GetProperty("processed").GetInt64());
        Assert.Equal(3, last.GetProperty("affected").GetInt64());
        Assert.Contains(log, l => l.StartsWith("CREATE TABLE"));
        Assert.Equal("Gęślą; \"jaźń\"\nline 2", await t.ScalarAsync($"SELECT name FROM `{table}` WHERE id = 2"));
        Assert.Equal("1000.25|1985-06-15", await t.ScalarAsync($"SELECT CONCAT(price, '|', born) FROM `{table}` WHERE id = 3"));
        // \N is NULL; an empty cell in a text column is an empty string ("Empty cells: auto").
        Assert.Equal("1/1", await t.ScalarAsync($"SELECT CONCAT(SUM(note IS NULL), '/', SUM(note = '')) FROM `{table}`"));
        Assert.Equal("int", await t.ScalarAsync($"SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{table}' AND COLUMN_NAME = 'id'"));
    }

    [DbFact]
    public async Task Duplicate_keys_error_skip_replace_or_update()
    {
        var table = Table("stock");
        await t.ExecRootAsync($"CREATE TABLE `{table}` (sku VARCHAR(10) PRIMARY KEY, qty INT NOT NULL, note VARCHAR(20) DEFAULT 'old')");
        await t.ExecRootAsync($"INSERT INTO `{table}` VALUES ('A', 1, 'keep'), ('B', 2, 'keep')");
        var file = await UploadAsync("stock.csv", Encoding.UTF8.GetBytes("sku,qty\nA,10\nC,30\nB,20\n"));
        object Start(string mode, bool stop) => new
        {
            fileId = file, source = new { header = true }, db = t.Db, table, mode, stopOnError = stop,
            mapping = new[] { new { source = 0, column = "sku" }, new { source = 1, column = "qty" } },
        };

        // Plain INSERT, continue on errors: duplicates are reported with their row number in the file.
        var (last, errors, _) = await ImportAsync(Start("insert", false));
        Assert.Equal(2, last.GetProperty("errorCount").GetInt64());
        Assert.Equal([2L, 4L], errors.Select(e => e.GetProperty("row").GetInt64()));
        Assert.Contains("Duplicate", errors[0].GetProperty("message").GetString());
        Assert.Equal("1,2,30", await t.ScalarAsync($"SELECT GROUP_CONCAT(qty ORDER BY sku) FROM `{table}`"));

        await t.ExecRootAsync($"DELETE FROM `{table}` WHERE sku = 'C'");
        (last, errors, _) = await ImportAsync(Start("ignore", true));
        Assert.Empty(errors);
        Assert.Equal(1, last.GetProperty("affected").GetInt64());
        Assert.Equal("1,2,30", await t.ScalarAsync($"SELECT GROUP_CONCAT(qty ORDER BY sku) FROM `{table}`"));

        (_, errors, _) = await ImportAsync(Start("update", true));
        Assert.Empty(errors);
        Assert.Equal("10:keep,20:keep,30:old", await t.ScalarAsync($"SELECT GROUP_CONCAT(CONCAT(qty, ':', note) ORDER BY sku) FROM `{table}`"));

        (_, errors, _) = await ImportAsync(Start("replace", true));
        Assert.Empty(errors);
        Assert.Equal("10:old,20:old,30:old", await t.ScalarAsync($"SELECT GROUP_CONCAT(CONCAT(qty, ':', note) ORDER BY sku) FROM `{table}`")); // REPLACE re-creates rows
    }

    [DbFact]
    public async Task Stop_on_error_keeps_earlier_rows_unless_all_or_nothing()
    {
        var table = Table("nums");
        await t.ExecRootAsync($"CREATE TABLE `{table}` (id INT PRIMARY KEY, v INT NOT NULL)");
        var csv = new StringBuilder("id,v\n");
        for (var i = 1; i <= 1200; i++) csv.Append(i).Append(',').Append(i == 900 ? "" : i.ToString()).Append('\n'); // row 901: v NULL → error
        var file = await UploadAsync("nums.csv", Encoding.UTF8.GetBytes(csv.ToString()));
        object Start(bool tx, bool truncate = false) => new
        {
            fileId = file, source = new { header = true }, db = t.Db, table, stopOnError = true, transaction = tx, truncate,
            mapping = new[] { new { source = 0, column = "id" }, new { source = 1, column = "v" } },
        };

        var s = await t.App.PostAsync($"/s/{t.Sid}/import/start", Start(tx: false));
        var job = s.Expect().GetProperty("jobId").GetString();
        var r = (await t.App.PostAsync($"/s/{t.Sid}/import/step", new { jobId = job, rows = 5000 })).Expect();
        Assert.True(r.GetProperty("failed").GetBoolean());
        Assert.Equal(901, r.GetProperty("errors")[0].GetProperty("row").GetInt64());
        Assert.Equal("899", await t.ScalarAsync($"SELECT COUNT(*) FROM `{table}`"));

        s = await t.App.PostAsync($"/s/{t.Sid}/import/start", Start(tx: true, truncate: true));
        Assert.Contains(s.Log, l => l.StartsWith("DELETE FROM")); // inside the transaction, not TRUNCATE
        job = s.Expect().GetProperty("jobId").GetString();
        r = (await t.App.PostAsync($"/s/{t.Sid}/import/step", new { jobId = job, rows = 5000 })).Expect();
        Assert.True(r.GetProperty("rolledBack").GetBoolean());
        Assert.Equal("899", await t.ScalarAsync($"SELECT COUNT(*) FROM `{table}`")); // untouched, delete rolled back too

        // Cancelling an all-or-nothing import rolls it back.
        s = await t.App.PostAsync($"/s/{t.Sid}/import/start", Start(tx: true, truncate: true));
        job = s.Expect().GetProperty("jobId").GetString();
        (await t.App.PostAsync($"/s/{t.Sid}/import/step", new { jobId = job, rows = 100 })).Expect();
        (await t.App.PostAsync($"/s/{t.Sid}/import/cancel", new { jobId = job })).Expect();
        Assert.Equal("899", await t.ScalarAsync($"SELECT COUNT(*) FROM `{table}`"));
        Assert.False((await t.App.PostAsync($"/s/{t.Sid}/import/step", new { jobId = job })).Ok);
    }

    [DbFact]
    public async Task Xlsx_import_dry_run_and_read_only_sessions()
    {
        var file = await UploadAsync("orders.xlsx", Xlsx.Build(("Orders", [
            ["order no", "placed", "total", "paid"],
            [1001, new DateTime(2024, 5, 6, 10, 15, 0), 99.95, true],
            [1002, new DateTime(2024, 5, 7), 5, false],
        ])));
        var p = (await t.App.PostAsync("/import/preview", new { fileId = file, source = new { header = true } })).Expect();
        Assert.Equal("Orders", p.GetProperty("sheets")[0].GetString());
        var cols = p.GetProperty("columns").EnumerateArray().Select(c => new { name = c.GetProperty("name").GetString(), type = c.GetProperty("type").GetString() }).ToArray();
        Assert.Equal("order no|placed|total|paid", string.Join("|", cols.Select(c => c.name)));
        Assert.Equal("INT|DATETIME|DECIMAL(4,2)|TINYINT(1)", string.Join("|", cols.Select(c => c.type)));

        var table = Table("orders_x");
        var start = new { fileId = file, source = new { header = true }, db = t.Db, table, create = cols, mapping = cols.Select((c, i) => new { source = i, column = c.name }), dryRun = true };
        var dry = (await t.App.PostAsync($"/s/{t.Sid}/import/start", start)).Expect();
        Assert.StartsWith("CREATE TABLE", dry.GetProperty("createSql").GetString());
        Assert.Contains("('1001', '2024-05-06 10:15:00', '99.95', '1')", dry.GetProperty("insertSql").GetString());
        Assert.Null(await t.ScalarAsync($"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{table}'"));

        var roSid = await t.ConnectAsync(await t.SaveSessionAsync("RO import", readOnly: true));
        var ro = await t.App.PostAsync($"/s/{roSid}/import/start", start with { });
        Assert.False(ro.Ok);
        Assert.Contains("read-only", ro.Error);

        var (last, errors, _) = await ImportAsync(new { start.fileId, start.source, start.db, start.table, start.create, start.mapping });
        Assert.Empty(errors);
        Assert.Equal(2, last.GetProperty("processed").GetInt64());
        Assert.Equal("1001|2024-05-06 10:15:00|99.95|1", await t.ScalarAsync($"SELECT CONCAT_WS('|', `order no`, placed, total, paid) FROM `{table}` ORDER BY 1 LIMIT 1"));
        (await t.App.CallAsync(HttpMethod.Delete, $"/import/{file}")).Expect();
        Assert.False((await t.App.PostAsync("/import/preview", new { fileId = file })).Ok);
    }
}
