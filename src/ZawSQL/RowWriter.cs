using System.Globalization;
using System.Text.RegularExpressions;
using MySqlConnector;

namespace ZawSQL;

public sealed record RowOp(string Op, Dictionary<string, string?>? Original, Dictionary<string, string?>? Values);

/// <summary>Applies grid edits (insert / update / delete of single rows) to a table.</summary>
public static partial class RowWriter
{
    [GeneratedRegex("^0x([0-9a-fA-F]{2})*$")]
    private static partial Regex HexRegex();

    [GeneratedRegex("^b'([01]*)'$", RegexOptions.IgnoreCase)]
    private static partial Regex BitRegex();

    public static async Task<object> ApplyAsync(MySqlConnection c, SqlLog log, TableMetaInfo m, string db, string table, RowOp op, CancellationToken ct)
    {
        var tbl = Db.Q(db, table);
        var args = new List<object?>();
        var limit = m.KeySource == "none" ? " LIMIT 1" : "";
        string sql;
        switch (op.Op)
        {
            case "update":
            {
                var vals = op.Values ?? [];
                if (vals.Count == 0) return new { affected = 0 };
                var sets = vals.Select(kv => $"{Db.Q(kv.Key)} = {Param(args, m, kv.Key, kv.Value)}").ToList();
                sql = $"UPDATE {tbl} SET {string.Join(", ", sets)} WHERE {Where(args, m, op.Original)}{limit}";
                break;
            }
            case "insert":
            {
                var vals = op.Values ?? [];
                sql = vals.Count == 0
                    ? $"INSERT INTO {tbl} () VALUES ()"
                    : $"INSERT INTO {tbl} ({string.Join(", ", vals.Keys.Select(Db.Q))}) VALUES ({string.Join(", ", vals.Select(kv => Param(args, m, kv.Key, kv.Value)))})";
                break;
            }
            case "delete":
                sql = $"DELETE FROM {tbl} WHERE {Where(args, m, op.Original)}{limit}";
                break;
            default:
                throw new ApiException($"Unknown row operation: {op.Op}");
        }

        await using var cmd = Db.Cmd(c, log, sql, args.ToArray());
        var affected = await cmd.ExecuteNonQueryAsync(ct);
        if (affected == 0 && op.Op != "insert")
            throw new ApiException("No row was affected. The row may have been changed or deleted in the meantime - refresh the data and try again.");
        var insertId = cmd.LastInsertedId;

        // Read the row back so the grid shows defaults, triggers' effects and server-side formatting.
        string?[]? row = null;
        if (op.Op != "delete" && m.KeySource != "none")
        {
            var key = new Dictionary<string, string?>();
            foreach (var k in m.KeyColumns)
            {
                if (op.Values != null && op.Values.TryGetValue(k, out var v)) key[k] = v;
                else if (op.Op == "update" && op.Original != null && op.Original.TryGetValue(k, out v)) key[k] = v;
                else if (op.Op == "insert" && insertId > 0 && m.Columns.FirstOrDefault(x => x.Name == k)?.IsAutoIncrement == true)
                    key[k] = insertId.ToString(CultureInfo.InvariantCulture);
                else { key = null; break; }
            }
            if (key != null)
            {
                var a2 = new List<object?>();
                var rs = await Db.QueryAsync(c, log, $"SELECT * FROM {tbl} WHERE {Where(a2, m, key)} LIMIT 1", ct, a2.ToArray());
                row = rs.Rows.FirstOrDefault();
            }
        }
        return new { affected, insertId, row };
    }

    static string Where(List<object?> args, TableMetaInfo m, Dictionary<string, string?>? original)
    {
        if (original == null) throw new ApiException("Missing original row values.");
        var cols = m.KeySource == "none" ? m.Columns.Select(x => x.Name).ToList() : m.KeyColumns;
        var parts = new List<string>();
        foreach (var name in cols)
        {
            if (!original.TryGetValue(name, out var v)) throw new ApiException($"Missing value for key column {name}.");
            parts.Add(v == null ? $"{Db.Q(name)} IS NULL" : $"{Db.Q(name)} = {Param(args, m, name, v)}");
        }
        return string.Join(" AND ", parts);
    }

    static string Param(List<object?> args, TableMetaInfo m, string column, string? value)
    {
        args.Add(Convert(m.Columns.FirstOrDefault(x => x.Name.Equals(column, StringComparison.OrdinalIgnoreCase)), value));
        return "@p" + (args.Count - 1);
    }

    /// <summary>Turns the grid's display string back into a parameter value of the right kind.</summary>
    static object? Convert(ColumnMeta? col, string? v)
    {
        if (v == null) return DBNull.Value;
        if (col == null) return v;
        var kind = Values.KindOf(col.Type);
        if (kind is "binary" or "spatial")
        {
            if (v.Length == 0) return Array.Empty<byte>();
            if (HexRegex().IsMatch(v)) return System.Convert.FromHexString(v.AsSpan(2));
        }
        if (col.Type.StartsWith("bit", StringComparison.OrdinalIgnoreCase))
        {
            if (ulong.TryParse(v, NumberStyles.None, CultureInfo.InvariantCulture, out var u)) return u;
            var bm = BitRegex().Match(v);
            if (bm.Success) return bm.Groups[1].Value.Length == 0 ? 0UL : System.Convert.ToUInt64(bm.Groups[1].Value, 2);
        }
        return v;
    }
}
