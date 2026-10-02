namespace ZawSQL;

public sealed record MaintenanceRequest(string Db, string[] Tables, string Op, string[]? Options);

/// <summary>
/// Builds table maintenance statements (CHECK, ANALYZE, CHECKSUM, OPTIMIZE, REPAIR) from a whitelist of
/// operations and options; table names are always quoted, so no free-form SQL reaches the server.
/// </summary>
public static class Maintenance
{
    sealed record OpDef(string Keyword, string[] Options, bool ReadOnly, bool LocalBeforeTable);

    static readonly Dictionary<string, OpDef> Ops = new(StringComparer.OrdinalIgnoreCase)
    {
        ["check"] = new("CHECK TABLE", ["QUICK", "FAST", "MEDIUM", "EXTENDED", "CHANGED", "FOR UPGRADE"], ReadOnly: true, LocalBeforeTable: false),
        ["checksum"] = new("CHECKSUM TABLE", ["QUICK", "EXTENDED"], ReadOnly: true, LocalBeforeTable: false),
        ["analyze"] = new("ANALYZE TABLE", ["LOCAL"], ReadOnly: false, LocalBeforeTable: true),
        ["optimize"] = new("OPTIMIZE TABLE", ["LOCAL"], ReadOnly: false, LocalBeforeTable: true),
        ["repair"] = new("REPAIR TABLE", ["LOCAL", "QUICK", "EXTENDED", "USE_FRM"], ReadOnly: false, LocalBeforeTable: true),
    };

    /// <summary>True for operations that don't change anything (allowed in read-only sessions).</summary>
    public static bool IsReadOnly(string op) => Ops.TryGetValue(op, out var d) && d.ReadOnly;

    public static string BuildSql(MaintenanceRequest req)
    {
        var op = req.Op ?? "";
        if (!Ops.TryGetValue(op, out var def)) throw new ApiException($"Unknown maintenance operation: {op}");
        if (req.Tables is not { Length: > 0 }) throw new ApiException("Select at least one table.");
        if (string.IsNullOrEmpty(req.Db)) throw new ApiException("No database selected.");

        var options = (req.Options ?? []).Select(o => o.Trim().ToUpperInvariant()).Distinct().ToList();
        var invalid = options.FirstOrDefault(o => !def.Options.Contains(o));
        if (invalid != null) throw new ApiException($"Option {invalid} is not valid for {def.Keyword}.");
        // CHECK accepts one mode; CHECKSUM either QUICK or EXTENDED.
        if (op.Equals("check", StringComparison.OrdinalIgnoreCase) && options.Count > 1)
            throw new ApiException("CHECK TABLE takes a single option.");
        if (op.Equals("checksum", StringComparison.OrdinalIgnoreCase) && options.Count > 1)
            throw new ApiException("CHECKSUM TABLE takes QUICK or EXTENDED, not both.");

        var local = def.LocalBeforeTable && options.Remove("LOCAL");
        var keyword = local ? def.Keyword.Replace(" TABLE", " LOCAL TABLE") : def.Keyword;
        var tables = string.Join(", ", req.Tables.Select(t => Db.Q(req.Db, t)));
        return options.Count > 0 ? $"{keyword} {tables} {string.Join(" ", options)}" : $"{keyword} {tables}";
    }
}
