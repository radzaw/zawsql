using System.Text.RegularExpressions;
using MySqlConnector;

namespace ZawSQL;

public sealed class ColumnMeta
{
    public string Name { get; set; } = "";
    public string Type { get; set; } = "";
    public string? Collation { get; set; }
    public bool Nullable { get; set; }
    public string? Key { get; set; }
    public string? Default { get; set; }
    public string? Extra { get; set; }
    public string? Comment { get; set; }

    public bool IsGenerated =>
        Extra != null && Regex.IsMatch(Extra, @"\b(VIRTUAL|STORED|PERSISTENT)\b", RegexOptions.IgnoreCase);
    public bool IsAutoIncrement => Extra?.Contains("auto_increment", StringComparison.OrdinalIgnoreCase) == true;
}

public sealed record IndexColumn(string? Name, string? SubPart, string? Expression, bool Desc);

public sealed class IndexMeta
{
    public string Name { get; set; } = "";
    public string Type { get; set; } = "KEY";
    public List<IndexColumn> Columns { get; set; } = [];
    public string? Comment { get; set; }
}

public sealed class ForeignKeyMeta
{
    public string Name { get; set; } = "";
    public List<string> Columns { get; set; } = [];
    public string RefDb { get; set; } = "";
    public string RefTable { get; set; } = "";
    public List<string> RefColumns { get; set; } = [];
    public string? OnUpdate { get; set; }
    public string? OnDelete { get; set; }
}

public sealed class TableMetaInfo
{
    public List<ColumnMeta> Columns { get; set; } = [];
    public List<IndexMeta> Indexes { get; set; } = [];
    /// <summary>Columns identifying a row for UPDATE/DELETE: primary key, else a NOT NULL unique key.</summary>
    public List<string> KeyColumns { get; set; } = [];
    public string KeySource { get; set; } = "none";
    public bool IsView { get; set; }
    public long? EstimatedRows { get; set; }
}

public static class TableMeta
{
    public static async Task<TableMetaInfo> LoadAsync(MySqlConnection c, SqlLog? log, string db, string table, CancellationToken ct)
    {
        var info = new TableMetaInfo();
        var t = (await Db.RowsAsync(c, log,
            "SELECT TABLE_TYPE AS t, TABLE_ROWS AS r FROM information_schema.TABLES WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1",
            ct, db, table)).FirstOrDefault() ?? throw new ApiException($"Table {db}.{table} was not found.");
        info.IsView = t["t"]?.Contains("VIEW", StringComparison.OrdinalIgnoreCase) == true;
        info.EstimatedRows = long.TryParse(t["r"], out var n) ? n : null;

        foreach (var r in await Db.RowsAsync(c, log, $"SHOW FULL COLUMNS FROM {Db.Q(db, table)}", ct))
        {
            info.Columns.Add(new ColumnMeta
            {
                Name = r["Field"] ?? "",
                Type = r["Type"] ?? "",
                Collation = r["Collation"],
                Nullable = r["Null"] == "YES",
                Key = r["Key"],
                Default = r["Default"],
                Extra = r["Extra"],
                Comment = r["Comment"],
            });
        }

        if (!info.IsView)
        {
            info.Indexes = await LoadIndexesAsync(c, log, db, table, ct);
            var key = info.Indexes.FirstOrDefault(i => i.Type == "PRIMARY")
                ?? info.Indexes.FirstOrDefault(i => i.Type == "UNIQUE" && i.Columns.All(ic =>
                    ic.Name != null && ic.SubPart == null && info.Columns.Any(col => col.Name == ic.Name && !col.Nullable)));
            if (key != null && key.Columns.All(ic => ic.Name != null))
            {
                info.KeyColumns = key.Columns.Select(x => x.Name!).ToList();
                info.KeySource = key.Type == "PRIMARY" ? "primary" : "unique";
            }
        }
        return info;
    }

    public static async Task<List<IndexMeta>> LoadIndexesAsync(MySqlConnection c, SqlLog? log, string db, string table, CancellationToken ct)
    {
        var list = new List<IndexMeta>();
        foreach (var r in await Db.RowsAsync(c, log, $"SHOW INDEX FROM {Db.Q(db, table)}", ct))
        {
            var name = r["Key_name"] ?? "";
            var idx = list.FirstOrDefault(i => i.Name == name);
            if (idx == null)
            {
                var indexType = r["Index_type"] ?? "";
                idx = new IndexMeta
                {
                    Name = name,
                    Type = name == "PRIMARY" ? "PRIMARY"
                        : indexType is "FULLTEXT" or "SPATIAL" ? indexType
                        : r["Non_unique"] == "0" ? "UNIQUE" : "KEY",
                    Comment = r.GetValueOrDefault("Index_comment"),
                };
                list.Add(idx);
            }
            idx.Columns.Add(new IndexColumn(r["Column_name"], r["Sub_part"], r.GetValueOrDefault("Expression"), r["Collation"] == "D"));
        }
        return list;
    }

    public static async Task<List<ForeignKeyMeta>> LoadForeignKeysAsync(MySqlConnection c, SqlLog? log, string db, string table, CancellationToken ct)
    {
        var list = new List<ForeignKeyMeta>();
        var rows = await Db.RowsAsync(c, log, """
            SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS refDb,
                   k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refCol,
                   r.UPDATE_RULE AS onUpdate, r.DELETE_RULE AS onDelete
            FROM information_schema.KEY_COLUMN_USAGE k
            JOIN information_schema.REFERENTIAL_CONSTRAINTS r
              ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
            WHERE k.TABLE_SCHEMA = @p0 AND k.TABLE_NAME = @p1 AND k.REFERENCED_TABLE_NAME IS NOT NULL
            ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION
            """, ct, db, table);
        foreach (var r in rows)
        {
            var name = r["name"] ?? "";
            var fk = list.FirstOrDefault(f => f.Name == name);
            if (fk == null)
            {
                fk = new ForeignKeyMeta { Name = name, RefDb = r["refDb"] ?? db, RefTable = r["refTable"] ?? "", OnUpdate = r["onUpdate"], OnDelete = r["onDelete"] };
                list.Add(fk);
            }
            fk.Columns.Add(r["col"] ?? "");
            fk.RefColumns.Add(r["refCol"] ?? "");
        }
        return list;
    }

    static readonly HashSet<string> ObjectTypes = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"];

    public static async Task<string?> ShowCreateAsync(MySqlConnection c, SqlLog? log, string db, string type, string name, CancellationToken ct)
    {
        type = type.ToUpperInvariant();
        if (!ObjectTypes.Contains(type)) throw new ApiException($"Invalid object type: {type}");
        var rs = await Db.QueryAsync(c, log, $"SHOW CREATE {type} {Db.Q(db, name)}", ct);
        if (rs.Rows.Count == 0) return null;
        for (var i = 0; i < rs.Columns.Length; i++)
        {
            var col = rs.Columns[i].Name;
            if (col.StartsWith("Create ", StringComparison.OrdinalIgnoreCase) || col == "SQL Original Statement")
                return rs.Rows[0][i];
        }
        return null;
    }
}
