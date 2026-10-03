using System.Globalization;
using MySqlConnector;

namespace ZawSQL;

public sealed record ReplicationActionRequest(string? Channel);

/// <summary>
/// Replication status of a server, as a replica (one entry per channel / named connection) and as a primary
/// (binary log, GTIDs, replicas). MySQL 8.x and MariaDB use different statements and column names
/// (Source_* / Replica_* vs. Master_* / Slave_*); this normalizes them. Polled by the UI, so not logged.
/// </summary>
public static class Replication
{
    const int ParseError = 1064, AccessDenied = 1227;

    /// <summary>The first statement the server understands; syntax errors move on to the next one.</summary>
    static async Task<(List<Dictionary<string, string?>> rows, string? denied)> FirstAsync(MySqlConnection c, CancellationToken ct, params string[] statements)
    {
        string? denied = null;
        foreach (var sql in statements)
        {
            try
            {
                return (await Db.RowsAsync(c, null, sql, ct), null);
            }
            catch (MySqlException ex) when (ex.Number is ParseError or 1146 or 1193)
            {
                // Unknown syntax / table / variable on this server version: try the next form.
            }
            catch (MySqlException ex) when (ex.Number is AccessDenied or 1142 or 1044)
            {
                denied = ex.Message;
                break;
            }
        }
        return ([], denied);
    }

    static string? Get(Dictionary<string, string?> r, params string[] names)
    {
        foreach (var n in names)
            if (r.TryGetValue(n, out var v)) return string.IsNullOrEmpty(v) ? null : v;
        return null;
    }

    static long? Long(string? s) => long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : null;

    /// <summary>An applier worker's error (MySQL's multi-threaded replica reports only "Coordinator stopped …" in the status).</summary>
    public sealed record WorkerError(long Worker, long Number, string? Message, string? Time, string? Transaction);

    /// <summary>One replica channel with MySQL's and MariaDB's column names mapped to the same fields.</summary>
    public static object NormalizeChannel(Dictionary<string, string?> r, IReadOnlyList<WorkerError>? workerErrors = null)
    {
        var rows = new Dictionary<string, string?>(r, StringComparer.OrdinalIgnoreCase);
        string? G(params string[] n) => Get(rows, n);
        object? Error(string prefix)
        {
            var no = Long(G($"Last_{prefix}_Errno"));
            if (no is not > 0) return null;
            var message = G($"Last_{prefix}_Error");
            var w = prefix == "SQL" ? workerErrors?.FirstOrDefault() : null;
            // The worker's error says what actually failed; the coordinator's message only points to it.
            return w != null
                ? new { number = w.Number, message = w.Message, time = w.Time ?? G($"Last_{prefix}_Error_Timestamp"), transaction = w.Transaction, coordinator = message }
                : new { number = no ?? 0, message, time = G($"Last_{prefix}_Error_Timestamp"), transaction = (string?)null, coordinator = (string?)null };
        }
        var filters = new[] { "Replicate_Do_DB", "Replicate_Ignore_DB", "Replicate_Do_Table", "Replicate_Ignore_Table", "Replicate_Wild_Do_Table", "Replicate_Wild_Ignore_Table", "Replicate_Rewrite_DB", "Replicate_Do_Domain_Ids", "Replicate_Ignore_Domain_Ids" }
            .Select(f => (f, v: G(f))).Where(x => x.v != null).Select(x => new { name = x.f, value = x.v }).ToList();
        return new
        {
            channel = G("Channel_Name", "Connection_name") ?? "",
            sourceHost = G("Source_Host", "Master_Host"),
            sourcePort = Long(G("Source_Port", "Master_Port")),
            sourceUser = G("Source_User", "Master_User"),
            sourceServerId = Long(G("Source_Server_Id", "Master_Server_Id")),
            sourceUuid = G("Source_UUID", "Master_UUID"),
            ioRunning = G("Replica_IO_Running", "Slave_IO_Running") ?? "No",
            sqlRunning = G("Replica_SQL_Running", "Slave_SQL_Running") ?? "No",
            ioState = G("Replica_IO_State", "Slave_IO_State"),
            sqlState = G("Replica_SQL_Running_State", "Slave_SQL_Running_State"),
            lagSeconds = Long(G("Seconds_Behind_Source", "Seconds_Behind_Master")),
            readFile = G("Source_Log_File", "Master_Log_File"),
            readPos = Long(G("Read_Source_Log_Pos", "Read_Master_Log_Pos")),
            execFile = G("Relay_Source_Log_File", "Relay_Master_Log_File"),
            execPos = Long(G("Exec_Source_Log_Pos", "Exec_Master_Log_Pos")),
            relayFile = G("Relay_Log_File"),
            relayPos = Long(G("Relay_Log_Pos")),
            relaySpace = Long(G("Relay_Log_Space")),
            ioError = Error("IO"),
            sqlError = Error("SQL"),
            retrievedGtid = G("Retrieved_Gtid_Set"),
            executedGtid = G("Executed_Gtid_Set"),
            autoPosition = G("Auto_Position") == "1",
            usingGtid = G("Using_Gtid"),
            gtidIoPos = G("Gtid_IO_Pos"),
            gtidSlavePos = G("Gtid_Slave_Pos"),
            sqlDelay = Long(G("SQL_Delay")) ?? 0,
            sqlRemainingDelay = Long(G("SQL_Remaining_Delay")),
            ssl = G("Source_SSL_Allowed", "Master_SSL_Allowed") == "Yes",
            parallelMode = G("Parallel_Mode"),
            retriedTransactions = Long(G("Retried_transactions")),
            filters,
        };
    }

    public static async Task<object> StatusAsync(MySqlConnection c, CancellationToken ct)
    {
        var mariaDb = c.ServerVersion.Contains("MariaDB", StringComparison.OrdinalIgnoreCase);
        var notes = new List<string>();

        var vars = (await Db.RowsAsync(c, null, """
            SHOW GLOBAL VARIABLES WHERE Variable_name IN ('server_id', 'server_uuid', 'log_bin', 'binlog_format', 'read_only', 'super_read_only',
              'gtid_mode', 'gtid_executed', 'gtid_binlog_pos', 'gtid_current_pos', 'gtid_slave_pos', 'gtid_domain_id', 'log_replica_updates',
              'log_slave_updates', 'replica_parallel_workers', 'slave_parallel_threads', 'sync_binlog', 'binlog_expire_logs_seconds', 'expire_logs_days')
            """, ct)).ToDictionary(r => r["Variable_name"] ?? "", r => r["Value"], StringComparer.OrdinalIgnoreCase);
        string? V(string n) => vars.TryGetValue(n, out var v) && !string.IsNullOrEmpty(v) ? v : null;

        var (replicaRows, replicaDenied) = mariaDb
            ? await FirstAsync(c, ct, "SHOW ALL REPLICAS STATUS", "SHOW ALL SLAVES STATUS", "SHOW SLAVE STATUS")
            : await FirstAsync(c, ct, "SHOW REPLICA STATUS", "SHOW SLAVE STATUS");
        if (replicaDenied != null) notes.Add($"Replica status needs the REPLICATION CLIENT (or REPLICATION SLAVE ADMIN) privilege: {replicaDenied}");
        var workers = new Dictionary<string, List<WorkerError>>();
        if (!mariaDb && replicaRows.Any(r => Long(Get(r, "Last_SQL_Errno")) is > 0))
        {
            try
            {
                foreach (var w in await Db.RowsAsync(c, null, """
                    SELECT CHANNEL_NAME, WORKER_ID, LAST_ERROR_NUMBER, LAST_ERROR_MESSAGE, LAST_ERROR_TIMESTAMP, LAST_APPLIED_TRANSACTION, APPLYING_TRANSACTION
                    FROM performance_schema.replication_applier_status_by_worker WHERE LAST_ERROR_NUMBER <> 0 ORDER BY LAST_ERROR_TIMESTAMP DESC
                    """, ct))
                {
                    var key = w["CHANNEL_NAME"] ?? "";
                    if (!workers.TryGetValue(key, out var list)) workers[key] = list = [];
                    list.Add(new WorkerError(Long(w["WORKER_ID"]) ?? 0, Long(w["LAST_ERROR_NUMBER"]) ?? 0, w["LAST_ERROR_MESSAGE"], w["LAST_ERROR_TIMESTAMP"],
                        string.IsNullOrEmpty(w["APPLYING_TRANSACTION"]) ? null : w["APPLYING_TRANSACTION"]));
                }
            }
            catch (MySqlException) { /* performance_schema off: keep the coordinator's message */ }
        }
        var channels = replicaRows.Select(r => NormalizeChannel(r, workers.GetValueOrDefault(Get(r, "Channel_Name") ?? ""))).ToList();

        var logBin = V("log_bin") is "ON" or "1";
        object? binlog = null;
        if (logBin)
        {
            var (rows, denied) = await FirstAsync(c, ct, "SHOW BINARY LOG STATUS", "SHOW BINLOG STATUS", "SHOW MASTER STATUS");
            if (denied != null) notes.Add($"Binary log status needs the REPLICATION CLIENT privilege: {denied}");
            if (rows.FirstOrDefault() is { } b)
                binlog = new { file = Get(b, "File"), position = Long(Get(b, "Position")), doDb = Get(b, "Binlog_Do_DB"), ignoreDb = Get(b, "Binlog_Ignore_DB") };
        }

        var (hostRows, _) = mariaDb
            ? await FirstAsync(c, ct, "SHOW REPLICA HOSTS", "SHOW SLAVE HOSTS")
            : await FirstAsync(c, ct, "SHOW REPLICAS", "SHOW SLAVE HOSTS");
        var registered = hostRows.Select(r => new
        {
            serverId = Long(Get(r, "Server_Id", "Server_id")),
            host = Get(r, "Host"),
            port = Long(Get(r, "Port")),
            uuid = Get(r, "Replica_UUID", "Slave_UUID"),
        }).ToList();

        var connected = new List<object>();
        try
        {
            foreach (var r in await Db.RowsAsync(c, null, """
                SELECT ID, USER, HOST, TIME, STATE FROM information_schema.PROCESSLIST
                WHERE COMMAND IN ('Binlog Dump', 'Binlog Dump GTID') ORDER BY ID
                """, ct))
                connected.Add(new { thread = Long(r["ID"]), user = r["USER"], host = r["HOST"], seconds = Long(r["TIME"]), state = r["STATE"] });
        }
        catch (MySqlException ex)
        {
            notes.Add($"Connected replicas can't be listed: {ex.Message}");
        }

        var semi = (await Db.RowsAsync(c, null, """
            SHOW GLOBAL STATUS WHERE Variable_name IN ('Rpl_semi_sync_source_status', 'Rpl_semi_sync_master_status', 'Rpl_semi_sync_replica_status',
              'Rpl_semi_sync_slave_status', 'Rpl_semi_sync_source_clients', 'Rpl_semi_sync_master_clients')
            """, ct)).ToDictionary(r => (r["Variable_name"] ?? "").Replace("_master_", "_source_").Replace("_slave_", "_replica_"), r => r["Value"]);

        var isReplica = channels.Count > 0;
        var isPrimary = logBin && (connected.Count > 0 || registered.Count > 0);
        return new
        {
            server = mariaDb ? "mariadb" : "mysql",
            version = c.ServerVersion,
            role = isReplica && isPrimary ? "both" : isReplica ? "replica" : isPrimary ? "primary" : "standalone",
            identity = new
            {
                serverId = Long(V("server_id")),
                serverUuid = V("server_uuid"),
                readOnly = V("read_only") is "ON" or "1",
                superReadOnly = V("super_read_only") is "ON" or "1",
                logBin,
                binlogFormat = V("binlog_format"),
                logReplicaUpdates = (V("log_replica_updates") ?? V("log_slave_updates")) is "ON" or "1",
                parallelWorkers = Long(V("replica_parallel_workers") ?? V("slave_parallel_threads")),
                syncBinlog = Long(V("sync_binlog")),
                binlogExpireSeconds = Long(V("binlog_expire_logs_seconds")) ?? (Long(V("expire_logs_days")) is { } d ? d * 86400 : null),
            },
            gtid = new
            {
                mode = V("gtid_mode"),
                executed = V("gtid_executed"),
                binlogPos = V("gtid_binlog_pos"),
                currentPos = V("gtid_current_pos"),
                slavePos = V("gtid_slave_pos"),
                domainId = Long(V("gtid_domain_id")),
            },
            channels,
            binlog,
            registered,
            connected,
            semiSync = semi.Count > 0 ? semi : null,
            notes,
        };
    }

    /// <summary>START / STOP REPLICA for one channel (MySQL) or named connection (MariaDB); empty = the default one.</summary>
    public static async Task ControlAsync(MySqlConnection c, SqlLog log, string action, string? channel, CancellationToken ct)
    {
        var verb = action switch { "start" => "START", "stop" => "STOP", _ => throw new ApiException($"Unknown replication action: {action}") };
        var mariaDb = c.ServerVersion.Contains("MariaDB", StringComparison.OrdinalIgnoreCase);
        var named = !string.IsNullOrEmpty(channel);
        string Sql(string noun) => mariaDb
            ? $"{verb} {noun}{(named ? " " + SqlLiteral.Quote(channel!) : "")}"
            : $"{verb} {noun}{(named ? " FOR CHANNEL " + SqlLiteral.Quote(channel!) : "")}";
        try
        {
            await Db.ExecAsync(c, log, Sql("REPLICA"), ct);
        }
        catch (MySqlException ex) when (ex.Number == ParseError)
        {
            await Db.ExecAsync(c, log, Sql("SLAVE"), ct); // servers before MySQL 8.0.22 / MariaDB 10.5.1
        }
    }
}
