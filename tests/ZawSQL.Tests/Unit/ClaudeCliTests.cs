using System.Text.Json;

namespace ZawSQL.Tests.Unit;

public class ClaudeCliTests
{
    static JsonElement Json(object o) => JsonDocument.Parse(JsonSerializer.Serialize(o)).RootElement;

    [Fact]
    public void Schema_lists_each_table_with_types_keys_and_references()
    {
        var tables = new[]
        {
            new ClaudeCli.SchemaTable("customers", false, [new("id", "int", "PRI", false), new("email", "varchar(200)", "UNI", false)]),
            new ClaudeCli.SchemaTable("orders", false, [new("id", "int", "PRI", false), new("customer_id", "int", "MUL", false), new("note", "text", "", true)]),
            new ClaudeCli.SchemaTable("v_totals", true, [new("total", "decimal(10,2)", "", true)]),
        };
        var refs = new[] { new ClaudeCli.SchemaRef("orders", "customer_id", "customers", "id") };
        Assert.Equal(
            "customers(id int PK, email varchar(200) UNIQUE)\n" +
            "orders(id int PK, customer_id int → customers.id, note text NULL)\n" +
            "view v_totals(total decimal(10,2) NULL)\n",
            ClaudeCli.FormatSchema(tables, refs));
    }

    [Fact]
    public void A_large_schema_is_cut_off_with_a_note()
    {
        var tables = Enumerable.Range(1, 50).Select(i => new ClaudeCli.SchemaTable($"table_{i:00}", false, [new("id", "int", "PRI", false)])).ToList();
        var text = ClaudeCli.FormatSchema(tables, [], maxChars: 100);
        Assert.True(text.Length < 160);
        Assert.StartsWith("table_01(id int PK)\n", text);
        Assert.EndsWith("more tables not listed.\n", text);
    }

    [Fact]
    public void Prompt_carries_server_schema_editor_sql_and_request()
    {
        var p = ClaudeCli.BuildPrompt("  top 10 customers  ", "10.11.6-MariaDB", "shop", "customers(id int PK)\n", "SELECT 1", readOnly: true);
        Assert.Contains("Server: MariaDB 10.11.6-MariaDB", p);
        Assert.Contains("read-only", p);
        Assert.Contains("Current database: shop", p);
        Assert.Contains("customers(id int PK)", p);
        Assert.Contains("```sql\nSELECT 1\n```", p);
        Assert.EndsWith("Request:\ntop 10 customers\n", p);
    }

    [Fact]
    public void Prompt_without_schema_or_sql_leaves_those_parts_out()
    {
        var p = ClaudeCli.BuildPrompt("count users", "8.4.3", null, null, "  ", readOnly: false);
        Assert.Contains("Server: MySQL 8.4.3", p);
        Assert.DoesNotContain("Schema (", p);
        Assert.DoesNotContain("currently in the editor", p);
        Assert.DoesNotContain("read-only", p);
    }

    [Theory]
    [InlineData("```sql\nSELECT 1;\n```", "SELECT 1;")]
    [InlineData("Here you go:\n\n```sql\nSELECT 1;\n```\nThis selects one.", "SELECT 1;")]
    [InlineData("```\nSELECT 2;\n```", "SELECT 2;")]
    [InlineData("```text\nnote\n```\n```sql\nSELECT 3;\n```", "SELECT 3;")]
    [InlineData("```sql\nSELECT 1;\n```\n```sql\nSELECT 2;\n```", "SELECT 1;\n\nSELECT 2;")]
    [InlineData("  SELECT 4;  ", "SELECT 4;")]
    public void Sql_is_taken_from_the_code_blocks(string answer, string sql) => Assert.Equal(sql, ClaudeCli.ExtractSql(answer));

    [Fact]
    public void Result_json_gives_the_sql()
    {
        var stdout = """{"type":"result","subtype":"success","is_error":false,"duration_ms":2100,"result":"```sql\nSELECT * FROM t;\n```","total_cost_usd":0.01}""";
        var r = Json(ClaudeCli.ParseResult(0, "some banner\n" + stdout + "\n", ""));
        Assert.Equal("SELECT * FROM t;", r.GetProperty("sql").GetString());
        Assert.Equal(2100, r.GetProperty("durationMs").GetInt64());
    }

    [Fact]
    public void An_error_result_suggests_signing_in()
    {
        var stdout = """{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}""";
        var ex = Assert.Throws<ApiException>(() => ClaudeCli.ParseResult(1, stdout, ""));
        Assert.Contains("Invalid API key", ex.Message);
        Assert.Contains("sign in", ex.Message);
    }

    [Fact]
    public void Output_without_a_result_reports_stderr()
    {
        var ex = Assert.Throws<ApiException>(() => ClaudeCli.ParseResult(1, "", "error: unknown option '--tools'"));
        Assert.Contains("exit code 1", ex.Message);
        Assert.Contains("unknown option", ex.Message);
    }

    [Fact]
    public void A_configured_path_that_does_not_exist_is_not_found() =>
        Assert.Null(ClaudeCli.Find(Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"), "claude.exe")));
}
