using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using MySqlConnector;

namespace ZawSQL;

public sealed class ApiException(string message) : Exception(message);

/// <summary>Collects the SQL executed while serving one request, shown in the UI's log panel.</summary>
public sealed class SqlLog
{
    public List<string> Items { get; } = [];
    /// <summary>When each item was logged (Unix time in milliseconds), for the timestamps in the UI's SQL log.</summary>
    public List<long> Times { get; } = [];
    public void Add(string sql)
    {
        lock (Items)
        {
            Items.Add(sql);
            Times.Add(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }
    }
    /// <summary>Adds a line logged elsewhere, keeping the time it was logged there.</summary>
    public void Add(string sql, long time)
    {
        lock (Items)
        {
            Items.Add(sql);
            Times.Add(time);
        }
    }
}

/// <summary>A result column. Schema/Table/BaseName identify the underlying table column, if any (null for expressions).</summary>
public sealed record ColumnInfo(string Name, string Type, string Kind, string? Table, string? BaseName, string? Schema = null);

public sealed class ResultSet
{
    public ColumnInfo[] Columns { get; init; } = [];
    public List<string?[]> Rows { get; init; } = [];
    public bool Truncated { get; set; }

    public static ResultSet From(string[] names, List<string?[]> rows) => new()
    {
        Columns = names.Select(n => new ColumnInfo(n, "VARCHAR", "text", null, null)).ToArray(),
        Rows = rows,
    };
}

public static partial class Db
{
    public static string Q(string ident) => "`" + ident.Replace("`", "``") + "`";
    public static string Q(string db, string name) => Q(db) + "." + Q(name);

    [GeneratedRegex(@"@p(\d+)")]
    private static partial Regex ParamRegex();

    /// <summary>Creates a command with positional parameters @p0, @p1, ... and logs it with literals substituted.</summary>
    public static MySqlCommand Cmd(MySqlConnection c, SqlLog? log, string sql, object?[] args)
    {
        var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        for (var i = 0; i < args.Length; i++)
            cmd.Parameters.AddWithValue("@p" + i, args[i] ?? DBNull.Value);
        log?.Add(args.Length == 0 ? sql : ParamRegex().Replace(sql, m => SqlLiteral.FromValue(args[int.Parse(m.Groups[1].Value)], "")));
        return cmd;
    }

    public static async Task<ResultSet> QueryAsync(MySqlConnection c, SqlLog? log, string sql, CancellationToken ct, params object?[] args)
    {
        await using var cmd = Cmd(c, log, sql, args);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        return await Values.ReadAsync(r, int.MaxValue, ct);
    }

    public static async Task<List<Dictionary<string, string?>>> RowsAsync(MySqlConnection c, SqlLog? log, string sql, CancellationToken ct, params object?[] args)
    {
        var rs = await QueryAsync(c, log, sql, ct, args);
        return rs.Rows.Select(row =>
        {
            var d = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
            for (var i = 0; i < rs.Columns.Length; i++) d[rs.Columns[i].Name] = row[i];
            return d;
        }).ToList();
    }

    public static async Task<List<string>> ColumnAsync(MySqlConnection c, SqlLog? log, string sql, CancellationToken ct, params object?[] args)
    {
        var rs = await QueryAsync(c, log, sql, ct, args);
        return rs.Rows.Select(r => r[0] ?? "").ToList();
    }

    public static async Task<string?> ScalarAsync(MySqlConnection c, SqlLog? log, string sql, CancellationToken ct, params object?[] args)
    {
        await using var cmd = Cmd(c, log, sql, args);
        var v = await cmd.ExecuteScalarAsync(ct);
        return Values.Format(v, "");
    }

    public static async Task<int> ExecAsync(MySqlConnection c, SqlLog? log, string sql, CancellationToken ct, params object?[] args)
    {
        await using var cmd = Cmd(c, log, sql, args);
        return await cmd.ExecuteNonQueryAsync(ct);
    }
}

/// <summary>Converts MySQL values to the display strings the UI works with.</summary>
public static partial class Values
{
    [GeneratedRegex(@"^((TINY|SMALL|MEDIUM|BIG)?INT|INTEGER|BIT|YEAR|BOOL)", RegexOptions.IgnoreCase)]
    private static partial Regex IntRegex();

    public static string KindOf(string typeName)
    {
        var t = typeName.Trim().ToUpperInvariant();
        if (t.Contains("GEOMETRY") || t.Contains("POINT") || t.Contains("POLYGON") || t.Contains("LINESTRING")) return "spatial";
        if (t.Contains("BLOB") || t.Contains("BINARY")) return "binary";
        if (t.StartsWith("DATE") || t.StartsWith("TIME")) return "date";
        if (IntRegex().IsMatch(t)) return "int";
        if (t.StartsWith("DECIMAL") || t.StartsWith("NUMERIC") || t.StartsWith("FLOAT") || t.StartsWith("DOUBLE") || t.StartsWith("REAL")) return "real";
        return "text";
    }

    static bool IsDateOnly(string typeName) =>
        typeName.StartsWith("DATE", StringComparison.OrdinalIgnoreCase) && !typeName.StartsWith("DATETIME", StringComparison.OrdinalIgnoreCase);

    public static string? Format(object? v, string typeName)
    {
        switch (v)
        {
            case null or DBNull: return null;
            case string s: return s;
            case byte[] b: return b.Length == 0 ? "" : "0x" + Convert.ToHexString(b);
            case bool bo: return bo ? "1" : "0";
            case MySqlDateTime md: return FormatDate(md.Year, md.Month, md.Day, md.Hour, md.Minute, md.Second, md.Microsecond, typeName);
            case DateTime dt: return FormatDate(dt.Year, dt.Month, dt.Day, dt.Hour, dt.Minute, dt.Second, (int)(dt.Ticks % TimeSpan.TicksPerSecond / 10), typeName);
            case DateOnly d: return d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            case TimeSpan ts: return FormatTime(ts);
            case float f: return f.ToString("R", CultureInfo.InvariantCulture);
            case double d: return d.ToString("R", CultureInfo.InvariantCulture);
            case IFormattable fm: return fm.ToString(null, CultureInfo.InvariantCulture);
            default: return v.ToString();
        }
    }

    static string FormatDate(int y, int mo, int d, int h, int mi, int s, int micro, string typeName)
    {
        var sb = new StringBuilder();
        sb.Append(CultureInfo.InvariantCulture, $"{y:0000}-{mo:00}-{d:00}");
        if (IsDateOnly(typeName)) return sb.ToString();
        sb.Append(CultureInfo.InvariantCulture, $" {h:00}:{mi:00}:{s:00}");
        if (micro > 0) sb.Append('.').Append(micro.ToString("D6", CultureInfo.InvariantCulture).TrimEnd('0'));
        return sb.ToString();
    }

    static string FormatTime(TimeSpan ts)
    {
        var neg = ts < TimeSpan.Zero;
        if (neg) ts = ts.Negate();
        var s = string.Create(CultureInfo.InvariantCulture, $"{(neg ? "-" : "")}{(long)ts.TotalHours:00}:{ts.Minutes:00}:{ts.Seconds:00}");
        var micro = ts.Ticks % TimeSpan.TicksPerSecond / 10;
        if (micro > 0) s += "." + micro.ToString("D6", CultureInfo.InvariantCulture).TrimEnd('0');
        return s;
    }

    public static ColumnInfo[] Columns(MySqlDataReader r) =>
        r.GetColumnSchema().Select(c =>
        {
            var t = c.DataTypeName ?? "VARCHAR";
            return new ColumnInfo(c.ColumnName, t, KindOf(t), NullIfEmpty(c.BaseTableName), NullIfEmpty(c.BaseColumnName), NullIfEmpty(c.BaseSchemaName));
        }).ToArray();

    static string? NullIfEmpty(string? s) => string.IsNullOrEmpty(s) ? null : s;

    public static object? GetValueSafe(MySqlDataReader r, int i)
    {
        try { return r.GetValue(i); }
        catch (Exception)
        {
            try { return r.GetString(i); } catch (Exception) { return "(unreadable value)"; }
        }
    }

    public static async Task<ResultSet> ReadAsync(MySqlDataReader r, int maxRows, CancellationToken ct)
    {
        var cols = Columns(r);
        var rows = new List<string?[]>();
        var truncated = false;
        while (await r.ReadAsync(ct))
        {
            if (rows.Count >= maxRows) { truncated = true; break; }
            var row = new string?[cols.Length];
            for (var i = 0; i < cols.Length; i++) row[i] = Format(GetValueSafe(r, i), cols[i].Type);
            rows.Add(row);
        }
        return new ResultSet { Columns = cols, Rows = rows, Truncated = truncated };
    }
}

public static class SqlLiteral
{
    public static string FromValue(object? v, string typeName) => v switch
    {
        null or DBNull => "NULL",
        byte[] b => b.Length == 0 ? "''" : "0x" + Convert.ToHexString(b),
        bool x => x ? "1" : "0",
        sbyte or byte or short or ushort or int or uint or long or ulong or decimal => Convert.ToString(v, CultureInfo.InvariantCulture)!,
        float f => f.ToString("R", CultureInfo.InvariantCulture),
        double d => d.ToString("R", CultureInfo.InvariantCulture),
        _ => Quote(Values.Format(v, typeName) ?? ""),
    };

    public static string Quote(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('\'');
        foreach (var ch in s)
        {
            switch (ch)
            {
                case '\\': sb.Append(@"\\"); break;
                case '\'': sb.Append(@"\'"); break;
                case '\0': sb.Append(@"\0"); break;
                case '\n': sb.Append(@"\n"); break;
                case '\r': sb.Append(@"\r"); break;
                case '\x1a': sb.Append(@"\Z"); break;
                default: sb.Append(ch); break;
            }
        }
        return sb.Append('\'').ToString();
    }
}
