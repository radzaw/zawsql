using MySqlConnector;

namespace ZawSQL;

/// <summary>
/// What the test data generator needs to know about a table: its columns and unique keys, a sample of the key values
/// each foreign key can point at (so generated rows reference existing parents), and the current maximum of integer
/// key columns without AUTO_INCREMENT (so generated keys continue after it). The rows themselves are generated in the
/// UI and inserted with ordinary INSERT statements.
/// </summary>
public static class DataGen
{
    /// <summary>Distinct parent keys read per foreign key; generated rows pick from these.</summary>
    public const int MaxSample = 5000;

    public static async Task<object> InfoAsync(MySqlConnection c, string db, string table, CancellationToken ct)
    {
        var m = await TableMeta.LoadAsync(c, null, db, table, ct);
        if (m.IsView) throw new ApiException("Test data can only be generated for tables, not views.");
        var fks = await TableMeta.LoadForeignKeysAsync(c, null, db, table, ct);

        var samples = new List<object>();
        foreach (var fk in fks)
        {
            var cols = string.Join(", ", fk.RefColumns.Select(Db.Q));
            var notNull = string.Join(" AND ", fk.RefColumns.Select(x => $"{Db.Q(x)} IS NOT NULL"));
            try
            {
                var rs = await Db.QueryAsync(c, null, $"SELECT DISTINCT {cols} FROM {Db.Q(fk.RefDb, fk.RefTable)} WHERE {notNull} LIMIT {MaxSample}", ct);
                samples.Add(new { name = fk.Name, rows = rs.Rows, kinds = rs.Columns.Select(x => x.Kind).ToList(), error = (string?)null });
            }
            catch (MySqlException ex)
            {
                // No SELECT privilege on the parent, say: those columns get no values, and the dialog says why.
                samples.Add(new { name = fk.Name, rows = new List<string?[]>(), kinds = new List<string>(), error = ex.Message });
            }
        }

        // Integer key columns filled by the generator rather than AUTO_INCREMENT continue after the current maximum.
        var keyCols = m.Indexes.Where(i => i.Type is "PRIMARY" or "UNIQUE").SelectMany(i => i.Columns).Select(x => x.Name).OfType<string>().ToHashSet(StringComparer.OrdinalIgnoreCase);
        var maxima = new Dictionary<string, string?>();
        foreach (var col in m.Columns.Where(x => keyCols.Contains(x.Name) && !x.IsAutoIncrement && IsInteger(x.Type)))
            maxima[col.Name] = await Db.ScalarAsync(c, null, $"SELECT MAX({Db.Q(col.Name)}) FROM {Db.Q(db, table)}", ct);

        return new
        {
            columns = m.Columns,
            indexes = m.Indexes,
            foreignKeys = fks,
            samples,
            maxima,
            estimatedRows = m.EstimatedRows,
        };
    }

    static bool IsInteger(string type) =>
        type.StartsWith("int", StringComparison.OrdinalIgnoreCase) || type.StartsWith("bigint", StringComparison.OrdinalIgnoreCase)
        || type.StartsWith("smallint", StringComparison.OrdinalIgnoreCase) || type.StartsWith("mediumint", StringComparison.OrdinalIgnoreCase)
        || type.StartsWith("tinyint", StringComparison.OrdinalIgnoreCase);
}
