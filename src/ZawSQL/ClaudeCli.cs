using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MySqlConnector;

namespace ZawSQL;

/// <summary>
/// Prompt: what the user wants. Sql: the editor's text (or selection) to change, if they chose to include it.
/// Schema: send the table and column names of <paramref name="Database"/> along. Model: a Claude Code model alias or
/// name; empty for the CLI's default. ClaudePath: the claude executable, empty to look it up.
/// </summary>
public sealed record ClaudeSqlRequest(string Prompt, string? Database, string? Sql = null, bool Schema = true, string? Model = null, string? ClaudePath = null);

/// <summary>
/// Writes SQL with the Claude Code command line (<c>claude -p</c>), so it runs on the user's own Claude subscription
/// login rather than an API key. Only the request, the server version and, when asked, table and column names (never
/// row data) are sent. The SQL is returned for the editor; nothing generated is ever run here.
/// </summary>
public static partial class ClaudeCli
{
    /// <summary>Larger schemas are cut off with a note, so the prompt stays a reasonable size.</summary>
    public const int MaxSchemaChars = 60_000;
    static readonly TimeSpan Timeout = TimeSpan.FromMinutes(3);

    [GeneratedRegex(@"^[A-Za-z0-9._\-\[\]]{1,80}$")]
    private static partial Regex ModelRe();

    [GeneratedRegex(@"```[ \t]*([A-Za-z]*)[^\n]*\n(.*?)```", RegexOptions.Singleline)]
    private static partial Regex FenceRe();

    /// <summary>The claude executable: the configured path, else the first one on PATH or in the installers' usual places.</summary>
    public static string? Find(string? configured)
    {
        if (!string.IsNullOrWhiteSpace(configured))
        {
            var p = Environment.ExpandEnvironmentVariables(configured.Trim().Trim('"'));
            return File.Exists(p) ? p : null;
        }
        var names = OperatingSystem.IsWindows() ? new[] { "claude.exe", "claude.cmd" } : ["claude"];
        var dirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries).ToList();
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        // The native installer, the older local install and npm's global folder; a GUI app may not see the shell's PATH.
        dirs.Add(Path.Combine(home, ".local", "bin"));
        dirs.Add(Path.Combine(home, ".claude", "local"));
        if (OperatingSystem.IsWindows()) dirs.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm"));
        else { dirs.Add("/opt/homebrew/bin"); dirs.Add("/usr/local/bin"); }
        foreach (var d in dirs)
            foreach (var n in names)
            {
                try
                {
                    var p = Path.Combine(d.Trim('"'), n);
                    if (File.Exists(p)) return p;
                }
                catch (ArgumentException) { /* a malformed PATH entry */ }
            }
        return null;
    }

    /// <summary>Whether Claude Code is installed, and its version.</summary>
    public static async Task<object> StatusAsync(string? configured, CancellationToken ct)
    {
        var exe = Find(configured);
        if (exe == null) return new { found = false, path = (string?)null, version = (string?)null };
        var (code, stdout, stderr) = await RunAsync(exe, ["--version"], null, TimeSpan.FromSeconds(20), ct);
        return new { found = true, path = exe, version = code == 0 ? stdout.Trim() : null, error = code == 0 ? null : stderr.Trim() };
    }

    /// <summary>The table and column names (with types, keys and foreign keys) of one database, as compact text.</summary>
    public static async Task<(string Text, int Tables)> SchemaAsync(MySqlConnection c, string db, CancellationToken ct)
    {
        var cols = await Db.RowsAsync(c, null,
            "SELECT c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE, c.COLUMN_KEY, c.IS_NULLABLE, t.TABLE_TYPE FROM information_schema.COLUMNS c " +
            "JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME " +
            "WHERE c.TABLE_SCHEMA = @p0 ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION", ct, db);
        var fks = await Db.RowsAsync(c, null,
            "SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE " +
            "WHERE TABLE_SCHEMA = @p0 AND REFERENCED_TABLE_NAME IS NOT NULL", ct, db);
        var tables = cols.GroupBy(r => r["TABLE_NAME"] ?? "")
            .Select(g => new SchemaTable(g.Key, g.First()["TABLE_TYPE"]?.Contains("VIEW", StringComparison.OrdinalIgnoreCase) == true,
                g.Select(r => new SchemaColumn(r["COLUMN_NAME"] ?? "", r["COLUMN_TYPE"] ?? "", r["COLUMN_KEY"] ?? "", r["IS_NULLABLE"] == "YES")).ToList()))
            .ToList();
        var refs = fks.Select(r => new SchemaRef(r["TABLE_NAME"] ?? "", r["COLUMN_NAME"] ?? "",
            r["REFERENCED_TABLE_SCHEMA"] == db ? r["REFERENCED_TABLE_NAME"] ?? "" : $"{r["REFERENCED_TABLE_SCHEMA"]}.{r["REFERENCED_TABLE_NAME"]}",
            r["REFERENCED_COLUMN_NAME"] ?? "")).ToList();
        return (FormatSchema(tables, refs), tables.Count);
    }

    public sealed record SchemaColumn(string Name, string Type, string Key, bool Nullable);
    public sealed record SchemaTable(string Name, bool IsView, List<SchemaColumn> Columns);
    public sealed record SchemaRef(string Table, string Column, string RefTable, string RefColumn);

    /// <summary>One line per table: <c>orders(id int PK, customer_id int → customers.id, note text NULL)</c>.</summary>
    public static string FormatSchema(IEnumerable<SchemaTable> tables, IEnumerable<SchemaRef> refs, int maxChars = MaxSchemaChars)
    {
        var fk = refs.ToLookup(r => (r.Table, r.Column));
        var sb = new StringBuilder();
        var all = tables.ToList();
        for (var i = 0; i < all.Count; i++)
        {
            var t = all[i];
            var line = new StringBuilder(t.IsView ? "view " : "").Append(t.Name).Append('(');
            line.AppendJoin(", ", t.Columns.Select(col =>
            {
                var s = $"{col.Name} {col.Type}";
                if (col.Key == "PRI") s += " PK";
                else if (col.Key == "UNI") s += " UNIQUE";
                foreach (var r in fk[(t.Name, col.Name)]) s += $" → {r.RefTable}.{r.RefColumn}";
                if (col.Nullable) s += " NULL";
                return s;
            }));
            line.Append(')');
            if (sb.Length + line.Length > maxChars)
            {
                sb.Append($"… and {all.Count - i} more table{(all.Count - i == 1 ? "" : "s")} not listed.\n");
                break;
            }
            sb.Append(line).Append('\n');
        }
        return sb.ToString();
    }

    /// <summary>The whole prompt sent on stdin: instructions, the server, the schema, the SQL to change and the request.</summary>
    public static string BuildPrompt(string request, string serverVersion, string? database, string? schema, string? sql, bool readOnly)
    {
        var mariaDb = serverVersion.Contains("MariaDB", StringComparison.OrdinalIgnoreCase);
        var sb = new StringBuilder();
        sb.Append("You write SQL for the ZawSQL database client. Answer with one ```sql code block holding the SQL and nothing else: ")
          .Append("no explanation before or after it. Short comments inside the SQL (-- …) are fine where they help. ")
          .Append("End every statement with a semicolon. Quote identifiers with backticks only where needed. ")
          .Append("Use only tables and columns from the schema below; if the request needs something that isn't there, say so in a -- comment. ")
          .Append("Do not use tools or read files: everything you need is in this message.\n\n");
        sb.Append($"Server: {(mariaDb ? "MariaDB" : "MySQL")} {serverVersion}. Write SQL this server accepts.\n");
        if (readOnly) sb.Append("The connection is read-only: write only SELECT (or WITH … SELECT, SHOW, EXPLAIN) statements.\n");
        if (!string.IsNullOrEmpty(database)) sb.Append($"Current database: {database}\n");
        if (!string.IsNullOrWhiteSpace(schema))
            sb.Append("\nSchema (table(column type …); PK = primary key, → = foreign key, NULL = nullable):\n").Append(schema.TrimEnd()).Append('\n');
        if (!string.IsNullOrWhiteSpace(sql))
            sb.Append("\nThe SQL currently in the editor. Change it as requested and return the whole new version:\n```sql\n").Append(sql.TrimEnd()).Append("\n```\n");
        sb.Append("\nRequest:\n").Append(request.Trim()).Append('\n');
        return sb.ToString();
    }

    /// <summary>The SQL in Claude's answer: the contents of its code blocks (sql ones first), else the whole text.</summary>
    public static string ExtractSql(string answer)
    {
        var blocks = FenceRe().Matches(answer).Select(m => (Lang: m.Groups[1].Value, Body: m.Groups[2].Value.Trim())).Where(b => b.Body.Length > 0).ToList();
        var sql = blocks.Where(b => b.Lang.Equals("sql", StringComparison.OrdinalIgnoreCase) || b.Lang.Equals("mysql", StringComparison.OrdinalIgnoreCase)).ToList();
        var pick = sql.Count > 0 ? sql : blocks;
        return pick.Count > 0 ? string.Join("\n\n", pick.Select(b => b.Body)) : answer.Trim();
    }

    /// <summary>Asks Claude Code for SQL. Returns the SQL, the full answer and what it cost (as the CLI reports it).</summary>
    public static async Task<object> AskAsync(ClaudeSqlRequest req, string prompt, CancellationToken ct)
    {
        if (req.Model is { Length: > 0 } m && !ModelRe().IsMatch(m)) throw new ApiException("The Claude model name isn't valid.");
        var exe = Find(req.ClaudePath) ?? throw new ApiException(string.IsNullOrWhiteSpace(req.ClaudePath)
            ? "Claude Code isn't installed, or ZawSQL can't find it. Install it (https://claude.com/claude-code), sign in once by running \"claude\" in a terminal, or set its path in Preferences."
            : $"Claude Code wasn't found at \"{req.ClaudePath}\". Check the path in Preferences.");
        // No tools: the answer comes from the prompt alone, and nothing is read or run on this machine.
        List<string> args = ["-p", "--output-format", "json", "--tools", ""];
        if (req.Model is { Length: > 0 }) { args.Add("--model"); args.Add(req.Model); }
        var (code, stdout, stderr) = await RunAsync(exe, args, prompt, Timeout, ct);
        return ParseResult(code, stdout, stderr);
    }

    /// <summary>Reads <c>--output-format json</c> output: {"type":"result","is_error":…,"result":"…","total_cost_usd":…}.</summary>
    public static object ParseResult(int exitCode, string stdout, string stderr)
    {
        JsonElement? root = null;
        // The JSON result is the last line that parses; anything printed before it is ignored.
        foreach (var line in stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Reverse())
        {
            if (!line.StartsWith('{')) continue;
            try { root = JsonDocument.Parse(line).RootElement; break; } catch (JsonException) { }
        }
        if (root is not { } r || !r.TryGetProperty("result", out var res))
        {
            var msg = (stderr.Trim().Length > 0 ? stderr : stdout).Trim();
            throw new ApiException($"Claude Code failed{(exitCode != 0 ? $" (exit code {exitCode})" : "")}: {(msg.Length > 0 ? Shorten(msg) : "no answer")}");
        }
        var text = res.ValueKind == JsonValueKind.String ? res.GetString() ?? "" : res.GetRawText();
        var isError = r.TryGetProperty("is_error", out var e) && e.ValueKind == JsonValueKind.True;
        if (isError || exitCode != 0)
            throw new ApiException($"Claude Code: {Shorten(text.Length > 0 ? text : stderr.Trim())}{(LooksLikeLogin(text + stderr) ? " Run \"claude\" in a terminal once and sign in with your Claude account." : "")}");
        double? cost = r.TryGetProperty("total_cost_usd", out var cu) && cu.ValueKind == JsonValueKind.Number ? cu.GetDouble() : null;
        long? ms = r.TryGetProperty("duration_ms", out var d) && d.ValueKind == JsonValueKind.Number ? d.GetInt64() : null;
        return new { sql = ExtractSql(text), answer = text, costUsd = cost, durationMs = ms };
    }

    static bool LooksLikeLogin(string s) => s.Contains("login", StringComparison.OrdinalIgnoreCase) || s.Contains("log in", StringComparison.OrdinalIgnoreCase)
        || s.Contains("API key", StringComparison.OrdinalIgnoreCase) || s.Contains("authenticat", StringComparison.OrdinalIgnoreCase);

    static string Shorten(string s) => s.Length > 600 ? s[..600] + "…" : s;

    static async Task<(int Code, string Stdout, string Stderr)> RunAsync(string exe, IEnumerable<string> args, string? stdin, TimeSpan timeout, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            StandardInputEncoding = new UTF8Encoding(false),
            // An empty folder of its own, so no project's CLAUDE.md or settings are picked up.
            WorkingDirectory = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "zawsql-claude")).FullName,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        // With an API key in the environment the CLI would bill that key; the point here is the subscription login.
        psi.Environment.Remove("ANTHROPIC_API_KEY");
        psi.Environment["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";

        using var p = new Process { StartInfo = psi };
        try { p.Start(); }
        catch (Exception ex) { throw new ApiException($"Claude Code couldn't be started ({exe}): {ex.Message}"); }
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        var outTask = p.StandardOutput.ReadToEndAsync(cts.Token);
        var errTask = p.StandardError.ReadToEndAsync(cts.Token);
        try
        {
            if (stdin != null) await p.StandardInput.WriteAsync(stdin.AsMemory(), cts.Token);
            p.StandardInput.Close();
            await p.WaitForExitAsync(cts.Token);
            return (p.ExitCode, await outTask, await errTask);
        }
        catch (Exception ex) when (ex is OperationCanceledException or IOException)
        {
            try { if (!p.HasExited) p.Kill(entireProcessTree: true); } catch { /* already gone */ }
            if (ct.IsCancellationRequested) throw new OperationCanceledException(ct);
            if (ex is IOException) throw new ApiException($"Claude Code stopped unexpectedly: {ex.Message}");
            throw new ApiException($"Claude Code didn't answer within {timeout.TotalMinutes:0} minutes.");
        }
    }
}
