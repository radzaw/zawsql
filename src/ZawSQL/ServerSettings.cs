using System.Text.RegularExpressions;
using MySqlConnector;

namespace ZawSQL;

public sealed record SchedulerRequest(bool On);
public sealed record EventActionRequest(string Db, string Name, string Action);
public sealed record SetVariableRequest(string Name, string Scope, string? Value, bool Default);

/// <summary>
/// Host tab › Events (the event scheduler and every database's events) and Variables (where each global value comes
/// from, and changing it with SET GLOBAL / SET PERSIST).
/// </summary>
public static partial class ServerSettings
{
    // ---- events ----

    /// <summary>
    /// The scheduler state (ON, OFF or DISABLED) and all events. EXECUTE_AT, STARTS and ENDS are in the event's time
    /// zone, so the server's current time in that zone comes along (nowThere) for working out the next run.
    /// </summary>
    public static async Task<object> EventsAsync(MySqlConnection c, SqlLog? log, CancellationToken ct)
    {
        var scheduler = await Db.ScalarAsync(c, log, "SELECT @@global.event_scheduler", ct);
        var events = await Db.RowsAsync(c, log, """
            SELECT EVENT_SCHEMA AS db, EVENT_NAME AS name, STATUS AS status, EVENT_TYPE AS type, EXECUTE_AT AS executeAt,
                   INTERVAL_VALUE AS intervalValue, INTERVAL_FIELD AS intervalField, STARTS AS starts, ENDS AS ends,
                   LAST_EXECUTED AS lastExecuted, ON_COMPLETION AS onCompletion, DEFINER AS definer, TIME_ZONE AS timeZone,
                   EVENT_COMMENT AS comment, COALESCE(CONVERT_TZ(NOW(), @@session.time_zone, TIME_ZONE), NOW()) AS nowThere
            FROM information_schema.EVENTS ORDER BY EVENT_SCHEMA, EVENT_NAME
            """, ct);
        return new { scheduler = scheduler?.ToUpperInvariant(), events };
    }

    /// <summary>Starts or stops the scheduler thread. A server started with --event-scheduler=DISABLED refuses.</summary>
    public static Task SetSchedulerAsync(MySqlConnection c, SqlLog log, bool on, CancellationToken ct) =>
        Db.ExecAsync(c, log, on ? "SET GLOBAL event_scheduler = ON" : "SET GLOBAL event_scheduler = OFF", ct);

    public static string EventStatement(EventActionRequest r)
    {
        var target = Db.Q(r.Db, r.Name);
        return r.Action switch
        {
            "enable" => $"ALTER EVENT {target} ENABLE",
            "disable" => $"ALTER EVENT {target} DISABLE",
            "drop" => $"DROP EVENT {target}",
            _ => throw new ApiException($"Unknown event action: {r.Action}"),
        };
    }

    public static Task EventActionAsync(MySqlConnection c, SqlLog log, EventActionRequest r, CancellationToken ct) =>
        Db.ExecAsync(c, log, EventStatement(r), ct);

    // ---- variables ----

    /// <summary>
    /// Every variable with its session and global value, what set the global value ("Set by": default, config file,
    /// command line, SET GLOBAL, SET PERSIST …) and, where the server tells, its default (MariaDB) and range.
    /// MySQL 8 reports the source in performance_schema.variables_info, MariaDB in information_schema.SYSTEM_VARIABLES;
    /// without either the columns stay empty.
    /// </summary>
    public static async Task<ResultSet> VariablesAsync(MySqlConnection c, SqlLog? log, CancellationToken ct)
    {
        var session = await Db.RowsAsync(c, log, "SHOW SESSION VARIABLES", ct);
        var global = (await Db.RowsAsync(c, log, "SHOW GLOBAL VARIABLES", ct))
            .GroupBy(r => r["Variable_name"] ?? "").ToDictionary(g => g.Key, g => g.First()["Value"]);
        var info = new Dictionary<string, (string? source, string? def, string? range, bool readOnly)>(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (var r in await Db.RowsAsync(c, null, """
                SELECT VARIABLE_NAME AS n, GLOBAL_VALUE_ORIGIN AS src, DEFAULT_VALUE AS def, READ_ONLY AS ro,
                       NUMERIC_MIN_VALUE AS mn, NUMERIC_MAX_VALUE AS mx, ENUM_VALUE_LIST AS vals
                FROM information_schema.SYSTEM_VARIABLES
                """, ct))
                info[r["n"] ?? ""] = (MariaSource(r["src"]), r["def"], Range(r["mn"], r["mx"], r["vals"]), r["ro"] == "YES");
        }
        catch (MySqlException)
        {
            try
            {
                foreach (var r in await Db.RowsAsync(c, null,
                    "SELECT VARIABLE_NAME AS n, VARIABLE_SOURCE AS src, MIN_VALUE AS mn, MAX_VALUE AS mx FROM performance_schema.variables_info", ct))
                    info[r["n"] ?? ""] = (MySqlSource(r["src"]), null, Range(r["mn"], r["mx"], null), false);
            }
            catch (MySqlException) { /* performance_schema off, or no privilege: values only */ }
        }
        var rows = session.Select(r =>
        {
            var name = r["Variable_name"] ?? "";
            info.TryGetValue(name, out var i);
            return new[] { name, r["Value"], global.GetValueOrDefault(name), i.source, i.def, i.range, i.readOnly ? "read-only" : null };
        }).ToList();
        return ResultSet.From(["Variable", "Session", "Global", "Set by", "Default", "Range", "Note"], rows);
    }

    static string? MySqlSource(string? s) => s switch
    {
        null or "" => null,
        "COMPILED" => "default",
        "GLOBAL" or "SERVER" or "EXPLICIT" or "EXTRA" or "USER" or "LOGIN" => "config file",
        "COMMAND_LINE" => "command line",
        "PERSISTED" => "SET PERSIST",
        "DYNAMIC" => "SET GLOBAL",
        _ => s.ToLowerInvariant(),
    };

    static string? MariaSource(string? s) => s switch
    {
        null or "" => null,
        "COMPILE-TIME" => "default",
        "CONFIG" => "config file",
        "COMMAND-LINE" => "command line",
        "SQL" => "SET GLOBAL",
        "AUTO" => "automatic",
        _ => s.ToLowerInvariant(),
    };

    static string? Range(string? min, string? max, string? values) =>
        !string.IsNullOrEmpty(values) ? values.Replace(",", ", ")
        : !string.IsNullOrEmpty(min) && !string.IsNullOrEmpty(max) && !(min == "0" && max == "0") ? $"{min} … {max}"
        : null;

    [GeneratedRegex(@"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$")]
    private static partial Regex VariableName();

    [GeneratedRegex(@"^-?\d+(\.\d+)?$")]
    private static partial Regex Number();

    /// <summary>
    /// The statement for a change: SET GLOBAL / SET PERSIST / SET PERSIST_ONLY with the value (numbers as they are,
    /// anything else as a string literal, or DEFAULT), or RESET PERSIST to drop a persisted setting.
    /// </summary>
    public static string SetStatement(SetVariableRequest r, bool noBackslashEscapes)
    {
        if (!VariableName().IsMatch(r.Name)) throw new ApiException($"Not a variable name: {r.Name}");
        if (r.Scope == "reset_persist") return $"RESET PERSIST IF EXISTS {r.Name}";
        var scope = r.Scope switch
        {
            "global" => "GLOBAL",
            "persist" => "PERSIST",
            "persist_only" => "PERSIST_ONLY",
            _ => throw new ApiException($"Unknown scope: {r.Scope}"),
        };
        var v = r.Value ?? "";
        var value = r.Default ? "DEFAULT" : Number().IsMatch(v) ? v : SqlLiteral.Quote(v, noBackslashEscapes);
        return $"SET {scope} {r.Name} = {value}";
    }

    public static async Task SetVariableAsync(MySqlConnection c, SqlLog log, SetVariableRequest r, CancellationToken ct) =>
        await Db.ExecAsync(c, log, SetStatement(r, await Db.NoBackslashEscapesAsync(c, ct)), ct);
}
