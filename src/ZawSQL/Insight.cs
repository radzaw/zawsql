using System.Globalization;
using System.Text.RegularExpressions;
using MySqlConnector;

namespace ZawSQL;

/// <summary>
/// Slow query and lock insight: statement digests (performance_schema), the slow query log table, InnoDB lock waits,
/// metadata lock waits, open transactions and the latest deadlock. Polled by the UI, so nothing is written to the SQL log.
/// </summary>
public static partial class Insight
{
    static double Num(string? s) => double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : 0;
    static long? Long(string? s) => long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : null;
    const double PicoPerMs = 1e9;

    static async Task<(bool mariaDb, Version version)> ServerAsync(MySqlConnection c, CancellationToken ct)
    {
        var v = await Db.ScalarAsync(c, null, "SELECT VERSION()", ct) ?? "";
        Version.TryParse(Regex.Match(v, @"^\d+\.\d+(\.\d+)?").Value, out var version);
        return (v.Contains("MariaDB", StringComparison.OrdinalIgnoreCase), version ?? new Version(0, 0));
    }

    static async Task<bool> PerformanceSchemaOnAsync(MySqlConnection c, CancellationToken ct) =>
        await Db.ScalarAsync(c, null, "SELECT @@performance_schema", ct) is "1" or "ON";

    // ---------------------------------------------------------------- top queries

    /// <summary>Statement digests ordered by total time, with times in milliseconds.</summary>
    public static async Task<object> TopQueriesAsync(MySqlConnection c, CancellationToken ct)
    {
        var slow = await SlowLogSettingsAsync(c, ct);
        if (!await PerformanceSchemaOnAsync(c, ct))
            return new { available = false, reason = "performance_schema is disabled on this server. Set performance_schema=ON in the server configuration and restart it to collect statement statistics.", slowLog = slow, rows = Array.Empty<object>() };

        var hasSample = await Db.ScalarAsync(c, null,
            "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'performance_schema' AND TABLE_NAME = 'events_statements_summary_by_digest' AND COLUMN_NAME = 'QUERY_SAMPLE_TEXT'", ct) != "0";
        List<Dictionary<string, string?>> rows;
        try
        {
            rows = await Db.RowsAsync(c, null, $"""
                SELECT DIGEST, SCHEMA_NAME, DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT, MAX_TIMER_WAIT, SUM_LOCK_TIME, SUM_ERRORS, SUM_WARNINGS,
                       SUM_ROWS_AFFECTED, SUM_ROWS_SENT, SUM_ROWS_EXAMINED, SUM_CREATED_TMP_DISK_TABLES, SUM_CREATED_TMP_TABLES,
                       SUM_SELECT_FULL_JOIN, SUM_SELECT_SCAN, SUM_SORT_ROWS, SUM_NO_INDEX_USED, SUM_NO_GOOD_INDEX_USED,
                       FIRST_SEEN, LAST_SEEN{(hasSample ? ", LEFT(QUERY_SAMPLE_TEXT, 4000) AS QUERY_SAMPLE_TEXT" : "")}
                FROM performance_schema.events_statements_summary_by_digest
                WHERE DIGEST_TEXT IS NOT NULL
                  AND DIGEST_TEXT NOT LIKE '%events_statements_summary_by_digest%'
                  AND DIGEST_TEXT NOT LIKE '%INNODB_TRX%'
                ORDER BY SUM_TIMER_WAIT DESC
                LIMIT 500
                """, ct);
        }
        catch (MySqlException ex) when (ex.Number is 1142 or 1044 or 1227)
        {
            return new { available = false, reason = $"No access to performance_schema: {ex.Message}", slowLog = slow, rows = Array.Empty<object>() };
        }
        string? since = null;
        try { since = await Db.ScalarAsync(c, null, "SELECT NOW() - INTERVAL VARIABLE_VALUE SECOND FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime'", ct); }
        catch (MySqlException) { /* only informational */ }
        return new
        {
            available = true,
            reason = (string?)null,
            hasSample,
            serverStart = since,
            slowLog = slow,
            rows = rows.Select(r => new
            {
                digest = r["DIGEST"],
                schema = r["SCHEMA_NAME"],
                text = r["DIGEST_TEXT"],
                sample = hasSample ? r.GetValueOrDefault("QUERY_SAMPLE_TEXT") : null,
                count = Num(r["COUNT_STAR"]),
                totalMs = Num(r["SUM_TIMER_WAIT"]) / PicoPerMs,
                maxMs = Num(r["MAX_TIMER_WAIT"]) / PicoPerMs,
                lockMs = Num(r["SUM_LOCK_TIME"]) / PicoPerMs,
                errors = Num(r["SUM_ERRORS"]),
                warnings = Num(r["SUM_WARNINGS"]),
                rowsAffected = Num(r["SUM_ROWS_AFFECTED"]),
                rowsSent = Num(r["SUM_ROWS_SENT"]),
                rowsExamined = Num(r["SUM_ROWS_EXAMINED"]),
                tmpDisk = Num(r["SUM_CREATED_TMP_DISK_TABLES"]),
                tmpTables = Num(r["SUM_CREATED_TMP_TABLES"]),
                fullJoins = Num(r["SUM_SELECT_FULL_JOIN"]),
                scans = Num(r["SUM_SELECT_SCAN"]),
                sortRows = Num(r["SUM_SORT_ROWS"]),
                noIndex = Num(r["SUM_NO_INDEX_USED"]),
                noGoodIndex = Num(r["SUM_NO_GOOD_INDEX_USED"]),
                firstSeen = r["FIRST_SEEN"],
                lastSeen = r["LAST_SEEN"],
            }).ToList(),
        };
    }

    public static async Task ResetDigestsAsync(MySqlConnection c, SqlLog log, CancellationToken ct) =>
        await Db.ExecAsync(c, log, "TRUNCATE TABLE performance_schema.events_statements_summary_by_digest", ct);

    // ---------------------------------------------------------------- slow query log

    public static async Task<object> SlowLogSettingsAsync(MySqlConnection c, CancellationToken ct)
    {
        var v = (await Db.RowsAsync(c, null, "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('slow_query_log', 'long_query_time', 'log_output', 'log_queries_not_using_indexes')", ct))
            .ToDictionary(r => r["Variable_name"] ?? "", r => r["Value"], StringComparer.OrdinalIgnoreCase);
        var output = v.GetValueOrDefault("log_output") ?? "";
        return new
        {
            enabled = v.GetValueOrDefault("slow_query_log") is "ON" or "1",
            longQueryTime = Num(v.GetValueOrDefault("long_query_time")),
            output,
            toTable = output.Contains("TABLE", StringComparison.OrdinalIgnoreCase),
            notUsingIndexes = v.GetValueOrDefault("log_queries_not_using_indexes") is "ON" or "1",
        };
    }

    /// <summary>The newest entries of mysql.slow_log (only filled when log_output includes TABLE).</summary>
    public static async Task<object> SlowLogAsync(MySqlConnection c, int limit, CancellationToken ct)
    {
        var rs = await Db.QueryAsync(c, null, $"""
            SELECT start_time AS `Time`, user_host AS `User`, query_time AS `Query time`, lock_time AS `Lock time`,
                   rows_sent AS `Rows sent`, rows_examined AS `Rows examined`, db AS `Database`, CONVERT(sql_text USING utf8mb4) AS `Query`
            FROM mysql.slow_log ORDER BY start_time DESC LIMIT {Math.Clamp(limit, 1, 5000)}
            """, ct);
        return new { settings = await SlowLogSettingsAsync(c, ct), log = rs };
    }

    // ---------------------------------------------------------------- locks

    [GeneratedRegex(@"LATEST DETECTED DEADLOCK\s*\n-+\n([\s\S]*?)\n-{4,}\s*\nTRANSACTIONS")]
    private static partial Regex DeadlockRe();

    /// <summary>"`shop`.`orders`" (information_schema.INNODB_LOCKS) → (shop, orders).</summary>
    public static (string? db, string? table) SplitLockTable(string? lockTable)
    {
        if (string.IsNullOrEmpty(lockTable)) return (null, null);
        var m = Regex.Match(lockTable, @"^`((?:[^`]|``)*)`\.`((?:[^`]|``)*)`");
        return m.Success ? (m.Groups[1].Value.Replace("``", "`"), m.Groups[2].Value.Replace("``", "`")) : (null, lockTable);
    }

    public static async Task<object> LocksAsync(MySqlConnection c, CancellationToken ct)
    {
        var (mariaDb, version) = await ServerAsync(c, ct);
        var psOn = await PerformanceSchemaOnAsync(c, ct);
        var notes = new List<string>();
        var modern = !mariaDb && version >= new Version(8, 0); // data_lock_waits replaced INNODB_LOCK_WAITS in MySQL 8.0

        var waits = new List<object>();
        try
        {
            if (modern && !psOn) notes.Add("performance_schema is disabled, so row lock waits can't be shown.");
            else if (modern)
            {
                foreach (var r in await Db.RowsAsync(c, null, """
                    SELECT rt.trx_mysql_thread_id AS w_thread, rt.trx_query AS w_query, TIMESTAMPDIFF(SECOND, rt.trx_wait_started, NOW()) AS w_seconds,
                           rl.LOCK_MODE AS w_mode, rl.LOCK_TYPE AS lock_type, rl.OBJECT_SCHEMA AS db, rl.OBJECT_NAME AS tbl, rl.INDEX_NAME AS idx, rl.LOCK_DATA AS lock_data,
                           bt.trx_mysql_thread_id AS b_thread, bt.trx_query AS b_query, bl.LOCK_MODE AS b_mode,
                           TIMESTAMPDIFF(SECOND, bt.trx_started, NOW()) AS b_age, bt.trx_rows_locked AS b_rows_locked, bt.trx_rows_modified AS b_rows_modified,
                           pw.USER AS w_user, pw.HOST AS w_host, pb.USER AS b_user, pb.HOST AS b_host, pb.COMMAND AS b_command, pb.TIME AS b_time
                    FROM performance_schema.data_lock_waits w
                    JOIN information_schema.INNODB_TRX rt ON rt.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
                    JOIN information_schema.INNODB_TRX bt ON bt.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID
                    LEFT JOIN performance_schema.data_locks rl ON rl.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
                    LEFT JOIN performance_schema.data_locks bl ON bl.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID
                    LEFT JOIN information_schema.PROCESSLIST pw ON pw.ID = rt.trx_mysql_thread_id
                    LEFT JOIN information_schema.PROCESSLIST pb ON pb.ID = bt.trx_mysql_thread_id
                    ORDER BY w_seconds DESC
                    LIMIT 200
                    """, ct))
                    waits.Add(Wait(r, r["db"], r["tbl"]));
            }
            else
            {
                foreach (var r in await Db.RowsAsync(c, null, """
                    SELECT rt.trx_mysql_thread_id AS w_thread, rt.trx_query AS w_query, TIMESTAMPDIFF(SECOND, rt.trx_wait_started, NOW()) AS w_seconds,
                           rl.lock_mode AS w_mode, rl.lock_type AS lock_type, rl.lock_table AS lock_table, rl.lock_index AS idx, rl.lock_data AS lock_data,
                           bt.trx_mysql_thread_id AS b_thread, bt.trx_query AS b_query, bl.lock_mode AS b_mode,
                           TIMESTAMPDIFF(SECOND, bt.trx_started, NOW()) AS b_age, bt.trx_rows_locked AS b_rows_locked, bt.trx_rows_modified AS b_rows_modified,
                           pw.USER AS w_user, pw.HOST AS w_host, pb.USER AS b_user, pb.HOST AS b_host, pb.COMMAND AS b_command, pb.TIME AS b_time
                    FROM information_schema.INNODB_LOCK_WAITS w
                    JOIN information_schema.INNODB_TRX rt ON rt.trx_id = w.requesting_trx_id
                    JOIN information_schema.INNODB_TRX bt ON bt.trx_id = w.blocking_trx_id
                    LEFT JOIN information_schema.INNODB_LOCKS rl ON rl.lock_id = w.requested_lock_id
                    LEFT JOIN information_schema.INNODB_LOCKS bl ON bl.lock_id = w.blocking_lock_id
                    LEFT JOIN information_schema.PROCESSLIST pw ON pw.ID = rt.trx_mysql_thread_id
                    LEFT JOIN information_schema.PROCESSLIST pb ON pb.ID = bt.trx_mysql_thread_id
                    ORDER BY w_seconds DESC
                    LIMIT 200
                    """, ct))
                {
                    var (db, tbl) = SplitLockTable(r["lock_table"]);
                    waits.Add(Wait(r, db, tbl));
                }
            }
        }
        catch (MySqlException ex)
        {
            notes.Add($"Row lock waits are not available: {ex.Message}");
        }

        // Metadata locks (e.g. ALTER TABLE waiting for a transaction that read the table).
        var mdl = new List<object>();
        try
        {
            if (!mariaDb && psOn)
            {
                foreach (var r in await Db.RowsAsync(c, null, """
                    SELECT pw.OBJECT_TYPE AS obj_type, pw.OBJECT_SCHEMA AS db, pw.OBJECT_NAME AS name, pw.LOCK_TYPE AS w_mode,
                           tw.PROCESSLIST_ID AS w_thread, tw.PROCESSLIST_USER AS w_user, tw.PROCESSLIST_INFO AS w_query, tw.PROCESSLIST_TIME AS w_seconds,
                           g.LOCK_TYPE AS b_mode, tb.PROCESSLIST_ID AS b_thread, tb.PROCESSLIST_USER AS b_user, tb.PROCESSLIST_INFO AS b_query,
                           tb.PROCESSLIST_COMMAND AS b_command, tb.PROCESSLIST_TIME AS b_time
                    FROM performance_schema.metadata_locks pw
                    JOIN performance_schema.threads tw ON tw.THREAD_ID = pw.OWNER_THREAD_ID
                    JOIN performance_schema.metadata_locks g ON g.OBJECT_TYPE = pw.OBJECT_TYPE AND g.OBJECT_SCHEMA <=> pw.OBJECT_SCHEMA
                         AND g.OBJECT_NAME <=> pw.OBJECT_NAME AND g.LOCK_STATUS = 'GRANTED' AND g.OWNER_THREAD_ID <> pw.OWNER_THREAD_ID
                    JOIN performance_schema.threads tb ON tb.THREAD_ID = g.OWNER_THREAD_ID
                    WHERE pw.LOCK_STATUS = 'PENDING' AND tb.PROCESSLIST_ID IS NOT NULL
                    ORDER BY w_seconds DESC
                    LIMIT 200
                    """, ct))
                {
                    mdl.Add(new
                    {
                        objectType = r["obj_type"], db = r["db"], name = r["name"],
                        waiting = new { thread = Long(r["w_thread"]), user = r["w_user"], query = r["w_query"], seconds = Long(r["w_seconds"]), mode = r["w_mode"] },
                        blocking = new { thread = Long(r["b_thread"]), user = r["b_user"], query = r["b_query"], command = r["b_command"], time = Long(r["b_time"]), mode = r["b_mode"] },
                    });
                }
            }
            else
            {
                // Without performance_schema metadata locks, at least show who is waiting.
                foreach (var r in await Db.RowsAsync(c, null, """
                    SELECT ID, USER, DB, TIME, STATE, LEFT(INFO, 2000) AS INFO FROM information_schema.PROCESSLIST
                    WHERE STATE LIKE 'Waiting for%metadata lock%' ORDER BY TIME DESC LIMIT 200
                    """, ct))
                {
                    mdl.Add(new
                    {
                        objectType = "TABLE", db = r["DB"], name = (string?)null,
                        waiting = new { thread = Long(r["ID"]), user = r["USER"], query = r["INFO"], seconds = Long(r["TIME"]), mode = r["STATE"] },
                        blocking = (object?)null,
                    });
                }
            }
        }
        catch (MySqlException ex)
        {
            notes.Add($"Metadata lock waits are not available: {ex.Message}");
        }

        var transactions = new List<object>();
        try
        {
            foreach (var r in await Db.RowsAsync(c, null, """
                SELECT t.trx_id, t.trx_mysql_thread_id AS thread, t.trx_state AS state, TIMESTAMPDIFF(SECOND, t.trx_started, NOW()) AS age,
                       t.trx_rows_locked AS rows_locked, t.trx_rows_modified AS rows_modified, t.trx_tables_locked AS tables_locked,
                       t.trx_isolation_level AS isolation, LEFT(t.trx_query, 2000) AS query,
                       p.USER AS user, p.HOST AS host, p.DB AS db, p.COMMAND AS command, p.TIME AS time, p.STATE AS thread_state
                FROM information_schema.INNODB_TRX t
                LEFT JOIN information_schema.PROCESSLIST p ON p.ID = t.trx_mysql_thread_id
                WHERE t.trx_mysql_thread_id <> CONNECTION_ID()
                ORDER BY t.trx_started
                LIMIT 200
                """, ct))
            {
                transactions.Add(new
                {
                    id = r["trx_id"], thread = Long(r["thread"]), state = r["state"], age = Long(r["age"]),
                    rowsLocked = Long(r["rows_locked"]), rowsModified = Long(r["rows_modified"]), tablesLocked = Long(r["tables_locked"]),
                    isolation = r["isolation"], query = r["query"], user = r["user"], host = r["host"], db = r["db"],
                    command = r["command"], time = Long(r["time"]), threadState = r["thread_state"],
                });
            }
        }
        catch (MySqlException ex)
        {
            notes.Add($"Transactions are not available: {ex.Message}");
        }

        string? deadlock = null;
        try
        {
            var status = (await Db.RowsAsync(c, null, "SHOW ENGINE INNODB STATUS", ct)).FirstOrDefault()?["Status"] ?? "";
            var m = DeadlockRe().Match(status);
            if (m.Success) deadlock = m.Groups[1].Value.Trim();
        }
        catch (MySqlException ex)
        {
            notes.Add($"The latest deadlock can't be read (SHOW ENGINE INNODB STATUS needs the PROCESS privilege): {ex.Message}");
        }

        return new { waits, metadata = mdl, transactions, deadlock, notes, server = mariaDb ? "mariadb" : "mysql" };
    }

    static object Wait(Dictionary<string, string?> r, string? db, string? table) => new
    {
        db, table, index = r["idx"], lockType = r["lock_type"], lockData = r["lock_data"],
        waiting = new { thread = Long(r["w_thread"]), user = r["w_user"], host = r["w_host"], query = r["w_query"], seconds = Long(r["w_seconds"]), mode = r["w_mode"] },
        blocking = new
        {
            thread = Long(r["b_thread"]), user = r["b_user"], host = r["b_host"], query = r["b_query"], mode = r["b_mode"],
            trxAge = Long(r["b_age"]), rowsLocked = Long(r["b_rows_locked"]), rowsModified = Long(r["b_rows_modified"]),
            command = r["b_command"], time = Long(r["b_time"]),
        },
    };
}
