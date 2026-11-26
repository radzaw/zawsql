using System.Diagnostics;
using System.Globalization;
using MySqlConnector;

namespace ZawSQL;

/// <summary>
/// Host tab › Fragmentation: the free (allocated but unused) space of every table, from information_schema.TABLES.
/// MySQL 8 caches those statistics for information_schema_stats_expiry seconds (a day by default); fresh=true reads
/// them from the storage engine instead. MariaDB always reads them live. Read-only; not logged. Which tables to
/// optimize, and the thresholds, are decided in the UI (fraglogic.js); the rebuild itself goes through /maintenance.
/// </summary>
public static class Fragmentation
{
    const string SystemSchemas = "'mysql', 'information_schema', 'performance_schema', 'sys'";
    public const int MaxTables = 20_000;

    static long Long(string? s) => long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : 0;

    public static async Task<object> CollectAsync(MySqlConnection c, bool fresh, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var mariaDb = c.ServerVersion.Contains("MariaDB", StringComparison.OrdinalIgnoreCase);
        var expiry = mariaDb ? null : await TryScalarAsync(c, "SELECT @@session.information_schema_stats_expiry", ct);
        var filePerTable = await TryScalarAsync(c, "SELECT @@global.innodb_file_per_table", ct);
        var cached = expiry != null && expiry != "0";
        var forced = fresh && cached;
        if (forced) await Db.ExecAsync(c, null, "SET SESSION information_schema_stats_expiry = 0", ct);
        List<Dictionary<string, string?>> rows;
        try
        {
            rows = await Db.RowsAsync(c, null, $"""
                SELECT TABLE_SCHEMA, TABLE_NAME, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, DATA_FREE, ROW_FORMAT, CREATE_OPTIONS
                FROM information_schema.TABLES
                WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA NOT IN ({SystemSchemas})
                ORDER BY DATA_FREE DESC, TABLE_SCHEMA, TABLE_NAME
                LIMIT {MaxTables}
                """, ct);
        }
        finally
        {
            // The connection goes back to the pool: don't leave the setting behind.
            if (forced) await Db.ExecAsync(c, null, "SET SESSION information_schema_stats_expiry = DEFAULT", CancellationToken.None);
        }

        return new
        {
            server = mariaDb ? "mariadb" : "mysql",
            fresh = !cached || fresh,
            statsExpiry = expiry == null ? (long?)null : Long(expiry),
            filePerTable = filePerTable == null ? (bool?)null : filePerTable is "1" or "ON",
            truncated = rows.Count >= MaxTables,
            ms = sw.ElapsedMilliseconds,
            tables = rows.Select(r => new
            {
                schema = r["TABLE_SCHEMA"],
                name = r["TABLE_NAME"],
                engine = r["ENGINE"],
                rows = Long(r["TABLE_ROWS"]),
                dataBytes = Long(r["DATA_LENGTH"]),
                indexBytes = Long(r["INDEX_LENGTH"]),
                freeBytes = Long(r["DATA_FREE"]),
                rowFormat = r["ROW_FORMAT"],
                partitioned = (r["CREATE_OPTIONS"] ?? "").Contains("partitioned", StringComparison.OrdinalIgnoreCase),
            }).ToList(),
        };
    }

    static async Task<string?> TryScalarAsync(MySqlConnection c, string sql, CancellationToken ct)
    {
        try { return await Db.ScalarAsync(c, null, sql, ct); }
        catch (MySqlException) { return null; }
    }
}
