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
    public void Explaining_an_error_sends_the_statement_the_error_and_the_schema()
    {
        var req = new ClaudeExplainRequest("error", "SELECT nam FROM customers;", "shop", Error: "Unknown column 'nam' in 'field list'", ErrorCode: "1054");
        var p = ClaudeCli.BuildExplainPrompt(req, "8.4.3", "customers(id int PK, name varchar(100))\n", [], readOnly: false);
        Assert.Contains("why a SQL statement failed", p);
        Assert.Contains("Server: MySQL 8.4.3", p);
        Assert.Contains("customers(id int PK, name varchar(100))", p);
        Assert.Contains("SELECT nam FROM customers;", p);
        Assert.Contains("error 1054: Unknown column 'nam'", p);
        Assert.DoesNotContain("EXPLAIN FORMAT=JSON", p);
        Assert.DoesNotContain("read-only", p);
    }

    [Fact]
    public void Explaining_a_plan_sends_the_plans_findings_and_table_definitions()
    {
        var req = new ClaudeExplainRequest("plan", "SELECT * FROM orders WHERE total > 5", "shop",
            PlanJson: "{\"query_block\":{}}", AnalyzeTree: "-> Filter (actual rows=3)", Findings: ["orders: full table scan"], Question: "Would an index help?");
        var p = ClaudeCli.BuildExplainPrompt(req, "10.11.6-MariaDB", null, [("shop.orders", "CREATE TABLE `orders` (`id` int)")], readOnly: true);
        Assert.Contains("execution plan", p);
        Assert.Contains("Server: MariaDB", p);
        Assert.Contains("Definition of shop.orders:", p);
        Assert.Contains("CREATE TABLE `orders`", p);
        Assert.Contains("{\"query_block\":{}}", p);
        Assert.Contains("-> Filter (actual rows=3)", p);
        Assert.Contains("- orders: full table scan", p);
        Assert.Contains("Would an index help?", p);
        Assert.Contains("read-only", p);
        // A huge plan is cut off.
        var big = ClaudeCli.BuildExplainPrompt(req with { PlanJson = new string('x', ClaudeCli.MaxPlanChars + 500) }, "8.0.36", null, [], false);
        Assert.Contains("… (cut off)", big);
        Assert.True(big.Length < ClaudeCli.MaxPlanChars + 5000);
    }

    [Fact]
    public void Only_sql_code_blocks_count_as_suggested_sql()
    {
        Assert.Null(ClaudeCli.SuggestedSql("The column is misspelt. Use `name` instead."));
        Assert.Null(ClaudeCli.SuggestedSql("```json\n{}\n```"));
        Assert.Equal("SELECT name FROM t;\n\nCREATE INDEX i ON t (a);", ClaudeCli.SuggestedSql("Fix:\n```sql\nSELECT name FROM t;\n```\nand\n```mysql\nCREATE INDEX i ON t (a);\n```"));
    }

    [Fact]
    public void A_configured_path_that_does_not_exist_is_not_found() =>
        Assert.Null(ClaudeCli.Find(Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"), "claude.exe")));
}
