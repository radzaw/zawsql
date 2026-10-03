using System.Text;
using System.Text.Json;
using ZawSQL.Tests.Infrastructure;

namespace ZawSQL.Tests.Unit;

/// <summary>Reading CSV / .xlsx files, detection, type guessing and value conversion (no database needed).</summary>
public sealed class ImporterTests : IDisposable
{
    readonly string dir = Path.Combine(Path.GetTempPath(), "zawsql-tests", Guid.NewGuid().ToString("n"));

    static ImporterTests() => Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    public ImporterTests() => Directory.CreateDirectory(dir);
    public void Dispose() => Directory.Delete(dir, true);

    ImportFile File(string name, byte[] bytes)
    {
        var path = Path.Combine(dir, Guid.NewGuid().ToString("n"));
        System.IO.File.WriteAllBytes(path, bytes);
        return new ImportFile { Id = "x", Path = path, Name = name, Kind = name.EndsWith(".xlsx") ? "xlsx" : "csv", Size = bytes.Length };
    }

    static List<string?[]> ReadAll(IRowSource src)
    {
        var rows = new List<string?[]>();
        while (src.Next() is { } r) rows.Add(r);
        return rows;
    }

    static string J(string?[] row) => string.Join("|", row.Select(x => x ?? "<null>"));

    static JsonElement Json(object o) => JsonSerializer.SerializeToElement(o, new JsonSerializerOptions(JsonSerializerDefaults.Web));

    [Fact]
    public void Csv_handles_quotes_line_breaks_doubled_quotes_and_blank_lines()
    {
        var csv = "a,b,c\r\n1,\"x, y\",\"say \"\"hi\"\"\"\n\n2,\"two\nlines\",\r\n3,plain\"quote,\"\"";
        var rows = ReadAll(new CsvRowSource(new StringReader(csv), ',', '"'));
        Assert.Equal(4, rows.Count);
        Assert.Equal(J(["1", "x, y", "say \"hi\""]), J(rows[1]));
        Assert.Equal(J(["2", "two\nlines", ""]), J(rows[2]));
        Assert.Equal(J(["3", "plain\"quote", ""]), J(rows[3])); // a quote inside an unquoted field is just text
        Assert.Equal(J(["a;b", "c"]), J(ReadAll(new CsvRowSource(new StringReader("'a;b';c"), ';', '\''))[0]));
        Assert.Equal(J(["\"a", "b\""]), J(ReadAll(new CsvRowSource(new StringReader("\"a\tb\""), '\t', null))[0]));
    }

    [Theory]
    [InlineData("id,name,price\n1,Ann,2.5\n2,Bob,3\n", ',')]
    [InlineData("id;name;price\n1;\"Ann, Jr\";2,5\n2;Bob;3\n", ';')]
    [InlineData("id\tname\n1\tAnn\n", '\t')]
    [InlineData("a|b|c\n1|2|3\n", '|')]
    public void Delimiter_is_detected(string sample, char expected) => Assert.Equal(expected, Importer.DetectDelimiter(sample, '"'));

    [Fact]
    public void Encoding_is_detected_from_bom_or_valid_utf8_and_falls_back_to_windows_1252()
    {
        Assert.Equal("utf-8", Importer.DetectEncoding(File("a.csv", Encoding.UTF8.GetBytes("név;ár\nÁrvíztűrő;1\n")).Path).WebName);
        Assert.Equal("utf-16", Importer.DetectEncoding(File("b.csv", [.. Encoding.Unicode.GetPreamble(), .. Encoding.Unicode.GetBytes("a;b")]).Path).WebName);
        Assert.Equal("Windows-1252", Importer.DetectEncoding(File("c.csv", Encoding.GetEncoding(1250).GetBytes("nazwa\nZażółć gęślą jaźń\n")).Path).WebName, ignoreCase: true);
    }

    [Fact]
    public void Preview_reads_header_rows_and_guesses_types()
    {
        var csv = "id;name;price;born;zip;active;note\n1;Anna;12,50;31.12.1990;00123;TRUE;\n2;Bob;3;01.02.2001;45000;false;x\n3;Zażółć;1000,25;15.06.1985;12345;true;\\N\n";
        var f = File("p.csv", Encoding.GetEncoding(1250).GetBytes(csv));
        var p = Json(Importer.Preview(f, new ImportPreviewRequest { Source = new ImportSourceOptions { Encoding = "windows-1250" }, DecimalComma = true }));
        Assert.Equal(";", p.GetProperty("delimiter").GetString());
        Assert.Equal(3, p.GetProperty("totalRows").GetInt64());
        Assert.Equal("DMY", p.GetProperty("suggestedDateOrder").GetString());
        Assert.True(p.GetProperty("suggestedDecimalComma").GetBoolean());
        var types = p.GetProperty("columns").EnumerateArray().ToDictionary(c => c.GetProperty("name").GetString()!, c => c.GetProperty("type").GetString());
        Assert.Equal("INT", types["id"]);
        Assert.Equal("VARCHAR(16)", types["name"]);
        Assert.Equal("DECIMAL(6,2)", types["price"]);
        Assert.Equal("DATE", types["born"]);
        Assert.Equal("VARCHAR(16)", types["zip"]); // leading zeros must survive
        Assert.Equal("TINYINT(1)", types["active"]);
        Assert.Equal("Zażółć", p.GetProperty("rows")[2][1].GetString());
    }

    [Fact]
    public void Header_off_skip_rows_and_generated_column_names()
    {
        var f = File("h.csv", Encoding.UTF8.GetBytes("report from 2024\n\n1,a\n2,b\n"));
        var p = Json(Importer.Preview(f, new ImportPreviewRequest { Source = new ImportSourceOptions { Header = false, SkipRows = 1, Delimiter = "," } }));
        Assert.Equal(2, p.GetProperty("totalRows").GetInt64());
        Assert.Equal(["column_1", "column_2"], p.GetProperty("columns").EnumerateArray().Select(c => c.GetProperty("name").GetString()));
        Assert.Equal(["a", "A_2", "column_3", "x y"], Importer.ColumnNames(["a", "A", " ", " x\n y "], 4));
    }

    [Fact]
    public void Xlsx_rows_strings_numbers_booleans_dates_and_gaps()
    {
        var bytes = Xlsx.Build(
            ("Data", [
                ["id", "name", "price", "when", "ok", "stamp"],
                [1, "Anna", 12.5, new DateTime(2024, 3, 1), true, new DateTime(2024, 3, 1, 14, 30, 5)],
                [2, new Xlsx.Inline("Bob & Co"), 0.001, new DateTime(1999, 12, 31), false, null],
                [3, null, 1E-7, null, null, null],
            ]),
            ("Other", [["x"], ["y"]]));
        var f = File("w.xlsx", bytes);
        Assert.Equal(["Data", "Other"], XlsxRowSource.SheetNames(f.Path));
        List<string?[]> rows;
        using (var src = new XlsxRowSource(f.Path, null)) rows = ReadAll(src);
        Assert.Equal(J(["1", "Anna", "12.5", "2024-03-01", "TRUE", "2024-03-01 14:30:05"]), J(rows[1]));
        Assert.Equal(J(["2", "Bob & Co", "0.001", "1999-12-31", "FALSE"]), J(rows[2]));
        Assert.Equal(J(["3", null, "0.0000001"]), J(rows[3]));
        using (var other = new XlsxRowSource(f.Path, "Other")) Assert.Equal("x / y", string.Join(" / ", ReadAll(other).Select(J)));

        var p = Json(Importer.Preview(f, new ImportPreviewRequest()));
        var types = string.Join(" ", p.GetProperty("columns").EnumerateArray().Select(c => c.GetProperty("type").GetString()));
        Assert.Equal("INT VARCHAR(16) DECIMAL(9,7) DATE TINYINT(1) DATETIME", types);
    }

    [Theory]
    [InlineData("31.12.1990", "DMY", "1990-12-31")]
    [InlineData("12/31/1990", "MDY", "1990-12-31")]
    [InlineData("1990/12/31", null, "1990-12-31")]
    [InlineData("5.6.24 7:05", "DMY", "2024-06-05 07:05:00")]
    [InlineData("2024-06-05T07:05:09.5", null, "2024-06-05 07:05:09.5")]
    [InlineData("03/04/2024", null, "03/04/2024")] // ambiguous without an order: left for MySQL
    [InlineData("next tuesday", "DMY", "next tuesday")]
    public void Dates_are_normalized(string input, string? order, string expected) => Assert.Equal(expected, Importer.NormalizeDate(input, order));

    [Theory]
    [InlineData("1 234,50", true, "1234.50")]
    [InlineData("1.234.567,5", true, "1234567.5")]
    [InlineData("1,234,567.5", false, "1234567.5")]
    [InlineData("12,5", true, "12.5")]
    [InlineData("TRUE", false, "1")]
    [InlineData("no", false, "0")]
    public void Numbers_are_normalized(string input, bool comma, string expected) => Assert.Equal(expected, Importer.NormalizeNumber(input, comma));

    [Fact]
    public void Cells_become_literals_by_column_category()
    {
        var o = new ImportStartRequest { DecimalComma = true, DateOrder = "DMY" };
        Assert.Equal("NULL", Importer.Literal("", Importer.Category.Number, o));
        Assert.Equal("''", Importer.Literal("", Importer.Category.Text, o));
        Assert.Equal("NULL", Importer.Literal("\\N", Importer.Category.Text, o));
        Assert.Equal("NULL", Importer.Literal(null, Importer.Category.Text, o));
        Assert.Equal("'12.5'", Importer.Literal("12,5", Importer.Category.Number, o));
        Assert.Equal("'2024-12-31'", Importer.Literal("31.12.2024", Importer.Category.Date, o));
        Assert.Equal("1", Importer.Literal("1", Importer.Category.Bit, o));
        Assert.Equal(@"'it\'s; \\ ok'", Importer.Literal(@"it's; \ ok", Importer.Category.Text, o));
        Assert.Equal("NULL", Importer.Literal("", Importer.Category.Text, new ImportStartRequest { Empty = "null" }));
        Assert.Equal("''", Importer.Literal("", Importer.Category.Number, new ImportStartRequest { Empty = "empty" }));
        Assert.Equal(Importer.Category.Number, Importer.CategoryOf("decimal(10,2) unsigned"));
        Assert.Equal(Importer.Category.DateTime, Importer.CategoryOf("timestamp"));
        Assert.Equal(Importer.Category.Text, Importer.CategoryOf("enum('a','b')"));
    }

    [Fact]
    public void Create_table_sql_validates_names_and_types()
    {
        var sql = Importer.CreateTableSql("db", "t", [new("name", "VARCHAR(50)"), new("price", "DECIMAL(10,2)")], addId: true);
        Assert.Equal("CREATE TABLE `db`.`t` (\n  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  `name` VARCHAR(50) NULL,\n  `price` DECIMAL(10,2) NULL\n)", sql);
        Assert.Throws<ApiException>(() => Importer.CreateTableSql("db", "t", [new("a", "INT; DROP TABLE x")], false));
        Assert.Throws<ApiException>(() => Importer.CreateTableSql("db", "t", [new("a", "INT"), new("A", "INT")], false));
        Assert.Throws<ApiException>(() => Importer.CreateTableSql("db", "t", [new("id", "INT")], true));
    }
}
