using MySqlConnector;

namespace ZawSQL;

/// <summary>
/// What a statement did on the server (rows read by index or by scanning, rows written, temporary tables, sorts),
/// from the session's status counters before and after it. Reading the counters is itself a statement that moves some
/// of them, so that cost is measured once per run and taken off every statement's numbers.
/// </summary>
public static class QueryStats
{
    /// <summary>Only the first statements of a script are measured, so long scripts don't pay for it.</summary>
    public const int MaxStatements = 50;

    public static readonly string[] Counters =
    [
        "Handler_read_first", "Handler_read_key", "Handler_read_last", "Handler_read_next", "Handler_read_prev",
        "Handler_read_rnd", "Handler_read_rnd_next", "Handler_write", "Handler_update", "Handler_delete",
        "Created_tmp_tables", "Created_tmp_disk_tables", "Sort_rows", "Sort_merge_passes", "Sort_scan", "Sort_range",
        "Select_scan", "Select_full_join", "Select_range", "Select_full_range_join",
    ];

    static readonly string ReadSql = "SHOW SESSION STATUS WHERE Variable_name IN (" + string.Join(", ", Counters.Select(n => $"'{n}'")) + ")";

    /// <summary>The session's counters; not written to the SQL log.</summary>
    public static async Task<Dictionary<string, long>> ReadAsync(MySqlConnection c, CancellationToken ct)
    {
        var d = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        foreach (var r in await Db.RowsAsync(c, null, ReadSql, ct))
            if (r.GetValueOrDefault("Variable_name") is { } name && long.TryParse(r.GetValueOrDefault("Value"), out var v)) d[name] = v;
        return d;
    }

    /// <summary>How much each counter moved, less what reading them costs; counters that didn't move are left out.</summary>
    public static Dictionary<string, long> Delta(IReadOnlyDictionary<string, long> before, IReadOnlyDictionary<string, long> after, IReadOnlyDictionary<string, long>? overhead)
    {
        var d = new Dictionary<string, long>();
        foreach (var (name, now) in after)
        {
            var moved = now - before.GetValueOrDefault(name) - (overhead?.GetValueOrDefault(name) ?? 0);
            if (moved > 0) d[name] = moved;
        }
        return d;
    }
}
