using System.Text;
using System.Text.RegularExpressions;
using MySqlConnector;

namespace ZawSQL;

/// <summary>Writes a database (or some of its tables) as an SQL script, similar to mysqldump.</summary>
public sealed class SqlDumper(MySqlConnection c, TextWriter w)
{
    public bool Structure { get; init; } = true;
    public bool Data { get; init; } = true;
    public bool DropObjects { get; init; } = true;
    public bool CreateDatabase { get; init; }

    public async Task RunAsync(string db, IReadOnlyCollection<string>? only, CancellationToken ct)
    {
        // With the dumped database as default, SHOW CREATE VIEW leaves same-database names unqualified,
        // so the script can be imported into a database with a different name.
        await c.ChangeDatabaseAsync(db, ct);
        // Dump TIMESTAMPs in UTC; the script sets the same zone before inserting.
        await Db.ExecAsync(c, null, "SET SESSION TIME_ZONE = '+00:00'", ct);
        var version = await Db.ScalarAsync(c, null, "SELECT VERSION()", ct);
        await w.WriteAsync($"""
            -- --------------------------------------------------------
            -- ZawSQL SQL dump
            -- Server version: {version}
            -- Database:       {db}
            -- Date:           {DateTime.Now:yyyy-MM-dd HH:mm:ss}
            -- --------------------------------------------------------

            /*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
            /*!40101 SET NAMES utf8mb4 */;
            /*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
            /*!40103 SET TIME_ZONE='+00:00' */;
            /*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
            /*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;


            """);

        if (CreateDatabase)
        {
            var cr = await Db.QueryAsync(c, null, $"SHOW CREATE DATABASE {Db.Q(db)}", ct);
            var sql = Regex.Replace(cr.Rows[0][1] ?? $"CREATE DATABASE {Db.Q(db)}", @"^CREATE DATABASE\s+(/\*!32312 IF NOT EXISTS\*/\s*)?", "CREATE DATABASE IF NOT EXISTS ", RegexOptions.IgnoreCase);
            await w.WriteAsync($"{sql};\nUSE {Db.Q(db)};\n\n");
        }

        var filter = only is { Count: > 0 } ? new HashSet<string>(only) : null;
        var objects = await Db.RowsAsync(c, null, "SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = @p0 ORDER BY TABLE_NAME", ct, db);
        var selected = objects.Where(o => filter == null || filter.Contains(o["name"]!)).ToList();
        var tables = selected.Where(o => !(o["type"] ?? "").Contains("VIEW")).Select(o => o["name"]!).ToList();
        var views = selected.Where(o => (o["type"] ?? "").Contains("VIEW")).Select(o => o["name"]!).ToList();

        foreach (var t in tables)
        {
            ct.ThrowIfCancellationRequested();
            if (Structure)
            {
                await w.WriteAsync($"-- Structure of table {Db.Q(t)}\n");
                if (DropObjects) await w.WriteAsync($"DROP TABLE IF EXISTS {Db.Q(t)};\n");
                await w.WriteAsync($"{await TableMeta.ShowCreateAsync(c, null, db, "TABLE", t, ct)};\n\n");
            }
            if (Data) await DumpDataAsync(db, t, ct);
        }

        if (Structure)
        {
            foreach (var v in views)
            {
                await w.WriteAsync($"-- Structure of view {Db.Q(v)}\n");
                if (DropObjects) await w.WriteAsync($"DROP VIEW IF EXISTS {Db.Q(v)};\n");
                await w.WriteAsync($"{await TableMeta.ShowCreateAsync(c, null, db, "VIEW", v, ct)};\n\n");
            }
            if (filter == null) await DumpProgramsAsync(db, ct);
        }

        await w.WriteAsync("""
            /*!40103 SET TIME_ZONE=IFNULL(@OLD_TIME_ZONE, 'SYSTEM') */;
            /*!40101 SET SQL_MODE=IFNULL(@OLD_SQL_MODE, '') */;
            /*!40014 SET FOREIGN_KEY_CHECKS=IFNULL(@OLD_FOREIGN_KEY_CHECKS, 1) */;
            /*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;

            """);
        await w.FlushAsync(ct);
    }

    async Task DumpProgramsAsync(string db, CancellationToken ct)
    {
        var programs = new List<(string Type, string Name)>();
        async Task Collect(string type, string sql)
        {
            try { programs.AddRange((await Db.ColumnAsync(c, null, sql, ct, db)).Select(n => (type, n))); }
            catch (MySqlException ex) { await w.WriteAsync($"-- Skipped {type.ToLowerInvariant()}s: {ex.Message}\n"); }
        }
        await Collect("PROCEDURE", "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = @p0 AND ROUTINE_TYPE = 'PROCEDURE' ORDER BY ROUTINE_NAME");
        await Collect("FUNCTION", "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = @p0 AND ROUTINE_TYPE = 'FUNCTION' ORDER BY ROUTINE_NAME");
        await Collect("TRIGGER", "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = @p0 ORDER BY TRIGGER_NAME");
        await Collect("EVENT", "SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = @p0 ORDER BY EVENT_NAME");
        if (programs.Count == 0) return;

        await w.WriteAsync("DELIMITER ;;\n\n");
        foreach (var (type, name) in programs)
        {
            string? code;
            try { code = await TableMeta.ShowCreateAsync(c, null, db, type, name, ct); }
            catch (MySqlException ex) { await w.WriteAsync($"-- Skipped {type.ToLowerInvariant()} {Db.Q(name)}: {ex.Message}\n\n"); continue; }
            if (code == null) continue;
            await w.WriteAsync($"-- {type.ToLowerInvariant()} {Db.Q(name)}\n");
            if (DropObjects) await w.WriteAsync($"DROP {type} IF EXISTS {Db.Q(name)};;\n");
            await w.WriteAsync($"{code};;\n\n");
        }
        await w.WriteAsync("DELIMITER ;\n\n");
    }

    async Task DumpDataAsync(string db, string table, CancellationToken ct)
    {
        var meta = await TableMeta.LoadAsync(c, null, db, table, ct);
        var cols = meta.Columns.Where(x => !x.IsGenerated).Select(x => x.Name).ToList();
        if (cols.Count == 0) return;
        var colList = string.Join(", ", cols.Select(Db.Q));

        await using var cmd = c.CreateCommand();
        cmd.CommandText = $"SELECT {colList} FROM {Db.Q(db, table)}";
        cmd.CommandTimeout = 0;
        await using var r = await cmd.ExecuteReaderAsync(ct);
        var info = Values.Columns(r);
        var head = $"INSERT INTO {Db.Q(table)} ({colList}) VALUES\n\t";
        var sb = new StringBuilder();
        var inBatch = 0;
        long total = 0;
        await w.WriteAsync($"-- Data of table {Db.Q(table)}\n");
        while (await r.ReadAsync(ct))
        {
            sb.Append(inBatch == 0 ? head : ",\n\t").Append('(');
            for (var i = 0; i < info.Length; i++)
            {
                if (i > 0) sb.Append(", ");
                sb.Append(SqlLiteral.FromValue(Values.GetValueSafe(r, i), info[i].Type));
            }
            sb.Append(')');
            inBatch++;
            total++;
            if (sb.Length > 1_000_000 || inBatch >= 5000)
            {
                sb.Append(";\n");
                await w.WriteAsync(sb.ToString());
                sb.Clear();
                inBatch = 0;
            }
        }
        if (inBatch > 0)
        {
            sb.Append(";\n");
            await w.WriteAsync(sb.ToString());
        }
        await w.WriteAsync($"-- {total} rows\n\n");
    }
}
