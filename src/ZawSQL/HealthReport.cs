using System.Diagnostics;
using System.Globalization;
using MySqlConnector;

namespace ZawSQL;

/// <summary>
/// Collects the facts for the server health report in one go: variables, status counters, tables, indexes,
/// auto-increment headroom, unused indexes and statements without an index (performance_schema), accounts and the
/// replication status. The checks themselves (what is a problem, how bad, how to fix it) run in the UI
/// (healthlogic.js), so they are unit-tested without a server. Read-only; not logged.
/// </summary>
public static class HealthReport
{
    const string SystemSchemas = "'mysql', 'information_schema', 'performance_schema', 'sys'";
    public const int MaxTables = 20_000, MaxIndexColumns = 100_000, MaxRows = 1_000;

    static long? Long(string? s) => long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : null;
    static decimal? Dec(string? s) => decimal.TryParse(s, NumberStyles.Number, CultureInfo.InvariantCulture, out var n) ? n : null;

    /// <summary>Runs a query; a missing privilege or table becomes a note instead of failing the whole report.</summary>
    static async Task<List<Dictionary<string, string?>>?> TryRowsAsync(MySqlConnection c, string sql, List<string> notes, string what, CancellationToken ct)
    {
        try
        {
            return await Db.RowsAsync(c, null, sql, ct);
        }
        catch (MySqlException ex) when (ex.Number is 1142 or 1143 or 1044 or 1227 or 1146 or 1054 or 1109)
        {
            notes.Add($"{what}: {ex.Message}");
            return null;
        }
    }

    /// <summary>Global privileges that make an account an administrator.</summary>
    static readonly string[] AdminPrivileges = ["Super_priv", "Grant_priv", "Shutdown_priv", "File_priv", "Create_user_priv", "Process_priv"];

    /// <summary>Authentication plugins that check a password (as opposed to the OS user, PAM, LDAP, Kerberos …).</summary>
    static readonly HashSet<string> PasswordPlugins = new(StringComparer.OrdinalIgnoreCase)
        { "", "mysql_native_password", "caching_sha2_password", "sha256_password", "mysql_old_password", "ed25519" };

    /// <summary>One mysql.user row (MySQL table or MariaDB view) as the facts the checks need.</summary>
    public static object NormalizeAccount(Dictionary<string, string?> r)
    {
        var row = new Dictionary<string, string?>(r, StringComparer.OrdinalIgnoreCase);
        string? G(string n) => row.TryGetValue(n, out var v) ? v : null;
        bool Y(string n) => string.Equals(G(n), "Y", StringComparison.OrdinalIgnoreCase);
        var plugin = G("plugin") ?? "";
        var privs = row.Keys.Where(k => k.EndsWith("_priv", StringComparison.OrdinalIgnoreCase)).ToList();
        return new
        {
            user = G("User") ?? "",
            host = G("Host") ?? "",
            plugin,
            // MariaDB keeps old-style hashes in Password; MySQL only has authentication_string.
            emptyPassword = PasswordPlugins.Contains(plugin) && string.IsNullOrEmpty(G("authentication_string")) && string.IsNullOrEmpty(G("Password")),
            locked = Y("account_locked"),
            isRole = Y("is_role"),
            allPrivileges = privs.Count > 0 && privs.All(Y),
            admin = AdminPrivileges.Where(Y).Select(p => p[..^5].Replace('_', ' ').ToUpperInvariant()).ToList(),
            passwordExpired = Y("password_expired"),
        };
    }

    public static async Task<object> CollectAsync(MySqlConnection c, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var mariaDb = c.ServerVersion.Contains("MariaDB", StringComparison.OrdinalIgnoreCase);
        var notes = new List<string>();

        static Dictionary<string, string?> Pairs(List<Dictionary<string, string?>> rows) =>
            rows.GroupBy(r => r["Variable_name"] ?? "", StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First()["Value"], StringComparer.OrdinalIgnoreCase);
        var variables = Pairs(await Db.RowsAsync(c, null, "SHOW GLOBAL VARIABLES", ct));
        var status = Pairs(await Db.RowsAsync(c, null, "SHOW GLOBAL STATUS", ct));
        var version = await Db.ScalarAsync(c, null, "SELECT VERSION()", ct);

        var schemas = await Db.ColumnAsync(c, null, $"SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ({SystemSchemas}) ORDER BY 1", ct);

        var tableRows = await Db.RowsAsync(c, null, $"""
            SELECT TABLE_SCHEMA, TABLE_NAME, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, DATA_FREE, TABLE_COLLATION, CREATE_OPTIONS
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA NOT IN ({SystemSchemas}) AND TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED')
            ORDER BY DATA_LENGTH + INDEX_LENGTH DESC LIMIT {MaxTables + 1}
            """, ct);
        if (tableRows.Count > MaxTables)
        {
            notes.Add($"Only the {MaxTables:N0} largest tables are checked.");
            tableRows.RemoveAt(MaxTables);
        }
        var tables = tableRows.Select(r => new
        {
            schema = r["TABLE_SCHEMA"],
            name = r["TABLE_NAME"],
            engine = r["ENGINE"],
            rows = Long(r["TABLE_ROWS"]) ?? 0,
            dataBytes = Long(r["DATA_LENGTH"]) ?? 0,
            indexBytes = Long(r["INDEX_LENGTH"]) ?? 0,
            freeBytes = Long(r["DATA_FREE"]) ?? 0,
            collation = r["TABLE_COLLATION"],
            partitioned = (r["CREATE_OPTIONS"] ?? "").Contains("partitioned", StringComparison.OrdinalIgnoreCase),
        }).ToList();

        // Index columns in order; grouped into indexes here so the UI gets one entry per index.
        var indexRows = await Db.RowsAsync(c, null, $"""
            SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART, INDEX_TYPE
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA NOT IN ({SystemSchemas})
            ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX LIMIT {MaxIndexColumns + 1}
            """, ct);
        if (indexRows.Count > MaxIndexColumns)
        {
            notes.Add($"Only the first {MaxIndexColumns:N0} index columns are checked for redundant indexes.");
            indexRows.RemoveAt(MaxIndexColumns);
        }
        var indexes = indexRows
            .GroupBy(r => (r["TABLE_SCHEMA"], r["TABLE_NAME"], r["INDEX_NAME"]))
            .Select(g => new
            {
                schema = g.Key.Item1,
                table = g.Key.Item2,
                name = g.Key.Item3,
                unique = g.First()["NON_UNIQUE"] == "0",
                type = g.First()["INDEX_TYPE"],
                // A functional index part (MySQL 8) has no column name; it never matches another index.
                columns = g.Select(r => r["COLUMN_NAME"] is { } col ? (Long(r["SUB_PART"]) is { } len ? $"{col}({len})" : col) : $"(expression {r["SEQ_IN_INDEX"]})").ToList(),
            }).ToList();

        var autoIncrement = (await Db.RowsAsync(c, null, $"""
            SELECT t.TABLE_SCHEMA, t.TABLE_NAME, col.COLUMN_NAME, col.COLUMN_TYPE, col.DATA_TYPE, t.AUTO_INCREMENT
            FROM information_schema.TABLES t
            JOIN information_schema.COLUMNS col ON col.TABLE_SCHEMA = t.TABLE_SCHEMA AND col.TABLE_NAME = t.TABLE_NAME AND col.EXTRA LIKE '%auto_increment%'
            WHERE t.TABLE_SCHEMA NOT IN ({SystemSchemas}) AND t.AUTO_INCREMENT IS NOT NULL
            ORDER BY t.AUTO_INCREMENT DESC LIMIT {MaxTables}
            """, ct)).Select(r => new
        {
            schema = r["TABLE_SCHEMA"],
            table = r["TABLE_NAME"],
            column = r["COLUMN_NAME"],
            type = r["DATA_TYPE"],
            unsigned = (r["COLUMN_TYPE"] ?? "").Contains("unsigned", StringComparison.OrdinalIgnoreCase),
            next = Dec(r["AUTO_INCREMENT"]) ?? 0,
        }).ToList();

        // performance_schema: indexes not read since the server started, and statements that ran without an index.
        var psOn = variables.GetValueOrDefault("performance_schema") is "ON" or "1";
        object? unusedIndexes = null, noIndexStatements = null;
        if (psOn)
        {
            unusedIndexes = (await TryRowsAsync(c, $"""
                SELECT OBJECT_SCHEMA, OBJECT_NAME, INDEX_NAME FROM performance_schema.table_io_waits_summary_by_index_usage
                WHERE INDEX_NAME IS NOT NULL AND INDEX_NAME <> 'PRIMARY' AND COUNT_STAR = 0 AND OBJECT_SCHEMA NOT IN ({SystemSchemas})
                ORDER BY OBJECT_SCHEMA, OBJECT_NAME, INDEX_NAME LIMIT {MaxRows}
                """, notes, "Unused indexes can't be read", ct))
                ?.Select(r => new { schema = r["OBJECT_SCHEMA"], table = r["OBJECT_NAME"], index = r["INDEX_NAME"] }).ToList();
            noIndexStatements = (await TryRowsAsync(c, $"""
                SELECT SCHEMA_NAME, DIGEST_TEXT, COUNT_STAR, ROUND(SUM_TIMER_WAIT / 1000000000, 1) AS total_ms, SUM_ROWS_EXAMINED, SUM_ROWS_SENT
                FROM performance_schema.events_statements_summary_by_digest
                WHERE (SUM_NO_INDEX_USED > 0 OR SUM_NO_GOOD_INDEX_USED > 0) AND SCHEMA_NAME IS NOT NULL AND SCHEMA_NAME NOT IN ({SystemSchemas})
                  AND (DIGEST_TEXT LIKE 'SELECT%' OR DIGEST_TEXT LIKE 'UPDATE%' OR DIGEST_TEXT LIKE 'DELETE%' OR DIGEST_TEXT LIKE 'WITH%')
                  AND DIGEST_TEXT NOT LIKE '%information_schema%' AND DIGEST_TEXT NOT LIKE '%performance_schema%'
                ORDER BY SUM_TIMER_WAIT DESC LIMIT 10
                """, notes, "Statement statistics can't be read", ct))
                ?.Select(r => new
                {
                    schema = r["SCHEMA_NAME"],
                    query = r["DIGEST_TEXT"],
                    count = Long(r["COUNT_STAR"]) ?? 0,
                    totalMs = Dec(r["total_ms"]) ?? 0,
                    rowsExamined = Long(r["SUM_ROWS_EXAMINED"]) ?? 0,
                    rowsSent = Long(r["SUM_ROWS_SENT"]) ?? 0,
                }).ToList();
        }

        var accounts = (await TryRowsAsync(c, "SELECT * FROM mysql.user ORDER BY User, Host", notes, "Accounts can't be checked (needs SELECT on mysql.user)", ct))
            ?.Select(NormalizeAccount).ToList();

        object? replication = null;
        try
        {
            replication = await Replication.StatusAsync(c, ct);
        }
        catch (MySqlException ex)
        {
            notes.Add($"Replication can't be checked: {ex.Message}");
        }

        return new
        {
            server = mariaDb ? "mariadb" : "mysql",
            version,
            collectedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
            tookMs = sw.ElapsedMilliseconds,
            variables,
            status,
            schemas,
            tables,
            indexes,
            autoIncrement,
            performanceSchema = psOn,
            unusedIndexes,
            noIndexStatements,
            accounts,
            replication,
            notes,
        };
    }
}
