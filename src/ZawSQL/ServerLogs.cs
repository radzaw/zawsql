using MySqlConnector;

namespace ZawSQL;

/// <summary>
/// Host tab › Error log and InnoDB: the server's error log as MySQL 8 keeps it in performance_schema.error_log, and
/// the full SHOW ENGINE INNODB STATUS text (split into sections in the UI). Both are polled, so nothing is written to
/// the SQL log.
/// </summary>
public static class ServerLogs
{
    public const int MaxErrorLogRows = 10_000;

    public static async Task<object> ErrorLogAsync(MySqlConnection c, int limit, CancellationToken ct)
    {
        var mariaDb = c.ServerVersion.Contains("MariaDB", StringComparison.OrdinalIgnoreCase);
        var file = await TryScalarAsync(c, "SELECT @@global.log_error", ct);
        var verbosity = await TryScalarAsync(c, mariaDb ? "SELECT @@global.log_warnings" : "SELECT @@global.log_error_verbosity", ct);
        object Unavailable(string reason) => new { available = false, reason, file, verbosity, server = mariaDb ? "mariadb" : "mysql", rows = Array.Empty<object>() };

        if (mariaDb)
            return Unavailable("MariaDB doesn't make its error log readable through SQL. It is written to the file named by log_error (or to the system journal when that is empty); open it on the server.");
        try
        {
            var rows = await Db.RowsAsync(c, null,
                "SELECT LOGGED AS logged, PRIO AS prio, ERROR_CODE AS code, SUBSYSTEM AS subsystem, DATA AS data FROM performance_schema.error_log ORDER BY LOGGED DESC LIMIT @p0",
                ct, Math.Clamp(limit, 1, MaxErrorLogRows));
            var now = await Db.ScalarAsync(c, null, "SELECT NOW(6)", ct); // in the time zone LOGGED is shown in, for "last hour"
            return new { available = true, reason = (string?)null, file, verbosity, server = "mysql", rows, now };
        }
        catch (MySqlException ex) when (ex.Number == 1146) // ER_NO_SUCH_TABLE
        {
            return Unavailable("This server has no performance_schema.error_log table: MySQL 8.0.22 or later is needed to read the error log through SQL. It is written to the file named by log_error.");
        }
        catch (MySqlException ex) when (ex.Number is 1142 or 1044 or 1227) // no SELECT on performance_schema
        {
            return Unavailable($"Reading the error log needs the SELECT privilege on performance_schema.error_log: {ex.Message}");
        }
    }

    public static async Task<object> InnodbStatusAsync(MySqlConnection c, CancellationToken ct)
    {
        try
        {
            var row = (await Db.RowsAsync(c, null, "SHOW ENGINE INNODB STATUS", ct)).FirstOrDefault();
            return new { status = row?.GetValueOrDefault("Status") ?? "", server = c.ServerVersion.Contains("MariaDB", StringComparison.OrdinalIgnoreCase) ? "mariadb" : "mysql" };
        }
        catch (MySqlException ex) when (ex.Number is 1227 or 1044) // ER_SPECIFIC_ACCESS_DENIED_ERROR
        {
            throw new ApiException($"SHOW ENGINE INNODB STATUS needs the PROCESS privilege: {ex.Message}");
        }
    }

    static async Task<string?> TryScalarAsync(MySqlConnection c, string sql, CancellationToken ct)
    {
        try { return await Db.ScalarAsync(c, null, sql, ct); }
        catch (MySqlException) { return null; }
    }
}
