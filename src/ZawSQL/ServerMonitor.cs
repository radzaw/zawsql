using MySqlConnector;

namespace ZawSQL;

/// <summary>
/// One sample of server activity for the live monitor: selected global status counters, a few
/// variables and the currently active queries. Polled every few seconds, so nothing is written to the SQL log.
/// </summary>
public static class ServerMonitor
{
    /// <summary>Statements one sample executes; the UI subtracts them so the monitor doesn't inflate "queries per second".</summary>
    public const int OwnStatements = 3;

    static readonly string[] StatusNames =
    [
        "Uptime", "Questions", "Com_select", "Com_insert", "Com_update", "Com_delete", "Com_replace",
        "Threads_connected", "Threads_running", "Max_used_connections", "Connections",
        "Bytes_received", "Bytes_sent", "Slow_queries", "Aborted_connects", "Aborted_clients",
        "Created_tmp_disk_tables", "Created_tmp_tables", "Select_full_join",
        "Innodb_buffer_pool_read_requests", "Innodb_buffer_pool_reads",
        "Innodb_buffer_pool_pages_total", "Innodb_buffer_pool_pages_free", "Innodb_buffer_pool_pages_dirty",
        "Innodb_rows_read", "Innodb_rows_inserted", "Innodb_rows_updated", "Innodb_rows_deleted", "Innodb_row_lock_waits",
        // Engine-independent row counters; MariaDB has dropped Innodb_rows_*, so the UI falls back to these.
        "Handler_read_first", "Handler_read_key", "Handler_read_last", "Handler_read_next", "Handler_read_prev",
        "Handler_read_rnd", "Handler_read_rnd_next", "Handler_write", "Handler_update", "Handler_delete",
    ];

    static readonly string[] VariableNames = ["max_connections", "innodb_buffer_pool_size", "long_query_time", "slow_query_log"];

    static string InList(IEnumerable<string> names) => string.Join(", ", names.Select(SqlLiteral.Quote));

    public static async Task<object> SampleAsync(MySqlConnection c, CancellationToken ct)
    {
        var status = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        foreach (var r in await Db.RowsAsync(c, null, $"SHOW GLOBAL STATUS WHERE Variable_name IN ({InList(StatusNames)})", ct))
            if (long.TryParse(r["Value"], out var v)) status[r["Variable_name"] ?? ""] = v;
        var t = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        var variables = (await Db.RowsAsync(c, null, $"SHOW GLOBAL VARIABLES WHERE Variable_name IN ({InList(VariableNames)})", ct))
            .ToDictionary(r => r["Variable_name"] ?? "", r => r["Value"], StringComparer.OrdinalIgnoreCase);

        ResultSet active;
        try
        {
            active = await Db.QueryAsync(c, null, """
                SELECT ID AS Id, USER AS User, HOST AS Host, DB AS Db, COMMAND AS Command, TIME AS Time, STATE AS State, LEFT(INFO, 500) AS Query
                FROM information_schema.PROCESSLIST
                WHERE COMMAND NOT IN ('Sleep', 'Daemon', 'Binlog Dump', 'Binlog Dump GTID') AND ID <> CONNECTION_ID()
                ORDER BY TIME DESC LIMIT 25
                """, ct);
        }
        catch (MySqlException)
        {
            active = new ResultSet(); // no PROCESS privilege / table unavailable: charts still work
        }
        return new { t, status, variables, active, ownStatements = OwnStatements };
    }
}
