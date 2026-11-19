using System.Globalization;
using MySqlConnector;

namespace ZawSQL;

/// <summary>
/// The binary log and relay log viewer (Host tab › Binary log): the server's binary log files and replica channels' relay
/// logs, and their events with SHOW BINLOG EVENTS / SHOW RELAYLOG EVENTS. Read-only and not logged (it is browsed).
/// </summary>
public static class Binlog
{
    public const int MaxLimit = 5000;

    static long? Long(string? s) => long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : null;

    static string? Get(Dictionary<string, string?> r, params string[] names)
    {
        foreach (var n in names)
            if (r.TryGetValue(n, out var v)) return string.IsNullOrEmpty(v) ? null : v;
        return null;
    }

    /// <summary>The binary log files (with the current position) and each replica channel's relay log.</summary>
    public static async Task<object> FilesAsync(MySqlConnection c, CancellationToken ct)
    {
        var mariaDb = c.ServerVersion.Contains("MariaDB", StringComparison.OrdinalIgnoreCase);
        var logBin = await Db.ScalarAsync(c, null, "SELECT @@GLOBAL.log_bin", ct) is "1" or "ON";
        var format = await Db.ScalarAsync(c, null, "SELECT @@GLOBAL.binlog_format", ct);
        string? reason = null;
        var files = new List<object>();
        object? current = null;
        if (!logBin) reason = "The binary log is off on this server (log_bin = OFF), so there are no binary log events to show.";
        else
        {
            try
            {
                foreach (var r in await Db.RowsAsync(c, null, "SHOW BINARY LOGS", ct))
                    files.Add(new { name = Get(r, "Log_name"), size = Long(Get(r, "File_size")), encrypted = Get(r, "Encrypted") == "Yes" });
            }
            catch (MySqlException ex) when (ex.Number is 1227 or 1142 or 1044)
            {
                reason = $"Listing the binary logs needs the REPLICATION CLIENT (or BINLOG MONITOR / SUPER) privilege: {ex.Message}";
            }
            foreach (var sql in new[] { "SHOW BINARY LOG STATUS", "SHOW BINLOG STATUS", "SHOW MASTER STATUS" })
            {
                try
                {
                    if ((await Db.RowsAsync(c, null, sql, ct)).FirstOrDefault() is { } b)
                        current = new { file = Get(b, "File"), position = Long(Get(b, "Position")) };
                    break;
                }
                catch (MySqlException ex) when (ex.Number == 1064) { /* older syntax */ }
                catch (MySqlException) { break; }
            }
        }

        var relay = new List<object>();
        foreach (var sql in mariaDb ? new[] { "SHOW ALL REPLICAS STATUS", "SHOW ALL SLAVES STATUS" } : new[] { "SHOW REPLICA STATUS", "SHOW SLAVE STATUS" })
        {
            try
            {
                foreach (var r in await Db.RowsAsync(c, null, sql, ct))
                    relay.Add(new
                    {
                        channel = Get(r, "Channel_Name", "Connection_name") ?? "",
                        file = Get(r, "Relay_Log_File"),
                        position = Long(Get(r, "Relay_Log_Pos")),
                        sourceFile = Get(r, "Relay_Source_Log_File", "Relay_Master_Log_File"),
                        sourcePosition = Long(Get(r, "Exec_Source_Log_Pos", "Exec_Master_Log_Pos")),
                    });
                break;
            }
            catch (MySqlException ex) when (ex.Number == 1064) { /* older syntax */ }
            catch (MySqlException) { break; }
        }
        return new { server = mariaDb ? "mariadb" : "mysql", logBin, format, reason, files, current, relay };
    }

    /// <summary>The SHOW BINLOG / RELAYLOG EVENTS statement for one page.</summary>
    public static string EventsSql(bool mariaDb, bool relay, string? file, long from, int limit, string? channel)
    {
        var named = relay && !string.IsNullOrEmpty(channel);
        var head = !relay ? "SHOW BINLOG EVENTS"
            : mariaDb && named ? $"SHOW RELAYLOG {SqlLiteral.Quote(channel!)} EVENTS"
            : "SHOW RELAYLOG EVENTS";
        var sql = head;
        if (!string.IsNullOrEmpty(file)) sql += $" IN {SqlLiteral.Quote(file)}";
        if (from > 0) sql += $" FROM {from.ToString(CultureInfo.InvariantCulture)}";
        sql += $" LIMIT {limit.ToString(CultureInfo.InvariantCulture)}";
        if (named && !mariaDb) sql += $" FOR CHANNEL {SqlLiteral.Quote(channel!)}";
        return sql;
    }

    /// <summary>
    /// Up to <paramref name="limit"/> events from <paramref name="from"/> (an event's start position; 0 or 4 = the file's
    /// start). One more event is read to learn where the next page starts: in a relay log, End_log_pos is the source's
    /// position, not the relay log's.
    /// </summary>
    public static async Task<object> EventsAsync(MySqlConnection c, string? log, string? file, long? from, int? limit, string? channel, CancellationToken ct)
    {
        var relay = log == "relay";
        if (!relay && log is not (null or "binary")) throw new ApiException($"Unknown log: {log}");
        var mariaDb = c.ServerVersion.Contains("MariaDB", StringComparison.OrdinalIgnoreCase);
        var n = Math.Clamp(limit ?? 500, 1, MaxLimit);
        var sql = EventsSql(mariaDb, relay, file, Math.Max(0, from ?? 0), n + 1, channel);
        List<Dictionary<string, string?>> rows;
        try
        {
            rows = await Db.RowsAsync(c, null, sql, ct);
        }
        catch (MySqlException ex)
        {
            throw new ApiException(ex.Number switch
            {
                1220 => $"The log can't be read from this position: {ex.Message}. Start at an event's position (the Position column), or at the start of the file.",
                1227 or 1142 or 1044 => $"Reading the log needs the REPLICATION SLAVE (or BINLOG MONITOR / REPLICATION CLIENT) privilege: {ex.Message}",
                _ => ex.Message,
            });
        }
        var events = rows.Take(n).Select(r => new
        {
            file = Get(r, "Log_name"),
            pos = Long(Get(r, "Pos")),
            type = Get(r, "Event_type"),
            serverId = Long(Get(r, "Server_id")),
            endPos = Long(Get(r, "End_log_pos")),
            info = Get(r, "Info"),
        }).ToList();
        var next = rows.Count > n ? Long(Get(rows[n], "Pos")) : null;
        return new { sql, file = events.FirstOrDefault()?.file ?? file, events, next };
    }
}
