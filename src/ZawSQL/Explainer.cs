using System.Text.RegularExpressions;
using MySqlConnector;

namespace ZawSQL;

public sealed record ExplainRequest(string Sql, string? Database, bool Analyze = false, string? Tab = null);

/// <summary>
/// Visual EXPLAIN: the JSON plan (parsed in the UI), the classic tabular EXPLAIN and the optimizer's notes for one
/// statement. With Analyze, the statement is executed to measure it (ANALYZE FORMAT=JSON on MariaDB, EXPLAIN ANALYZE
/// on MySQL 8.0.18+), so that is offered for read-only statements only.
/// </summary>
public static partial class Explainer
{
    [GeneratedRegex(@"^\s*(?:(?:EXPLAIN|DESCRIBE|DESC)(?:\s+(?:EXTENDED|PARTITIONS|ANALYZE|FORMAT\s*=\s*\w+))*|ANALYZE(?:\s+FORMAT\s*=\s*\w+)?)\s+(?=\S)", RegexOptions.IgnoreCase)]
    private static partial Regex PrefixRe();

    [GeneratedRegex(@"^(?:\s|/\*(?!!).*?\*/|--[^\n]*\n|#[^\n]*\n)*", RegexOptions.Singleline)]
    private static partial Regex LeadingCommentsRe();

    [GeneratedRegex(@"^\(*\s*(SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE|TABLE|VALUES)\b", RegexOptions.IgnoreCase)]
    private static partial Regex ExplainableRe();

    [GeneratedRegex(@"^\(*\s*(SELECT|WITH|TABLE|VALUES)\b", RegexOptions.IgnoreCase)]
    private static partial Regex ReadRe();

    /// <summary>The statement itself: comments, a trailing ";" and an EXPLAIN / ANALYZE prefix removed.</summary>
    public static string Statement(string sql)
    {
        var s = LeadingCommentsRe().Replace(sql, "").Trim().TrimEnd(';').TrimEnd();
        return PrefixRe().Replace(s, "", 1);
    }

    public static bool IsExplainable(string stmt) => ExplainableRe().IsMatch(stmt);

    /// <summary>ANALYZE executes the statement: only plain reads qualify.</summary>
    public static bool CanAnalyze(string stmt) => ReadRe().IsMatch(stmt) && ReadOnlyGuard.Check(stmt) == null;

    public static async Task<object> ExplainAsync(MySqlConnection c, SqlLog log, string sql, bool analyze, CancellationToken ct)
    {
        try
        {
            return await ExplainCoreAsync(c, log, sql, analyze, ct);
        }
        catch (MySqlException ex) when (ex.Number == 1792) // ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION
        {
            throw new ApiException("This session is read-only, and the server refuses to explain data changes in a read-only transaction. SELECT statements can be explained.");
        }
    }

    static async Task<object> ExplainCoreAsync(MySqlConnection c, SqlLog log, string sql, bool analyze, CancellationToken ct)
    {
        var stmt = Statement(sql);
        if (stmt.Length == 0) throw new ApiException("There is no statement to explain.");
        if (!IsExplainable(stmt)) throw new ApiException("Only SELECT, INSERT, UPDATE, DELETE, REPLACE and TABLE statements can be explained.");
        if (analyze && !CanAnalyze(stmt)) throw new ApiException("Analyze runs the statement to measure it, so it is only available for SELECT statements.");
        var mariaDb = c.ServerVersion.Contains("MariaDB", StringComparison.OrdinalIgnoreCase);

        string? json;
        string? analyzeText = null;
        if (analyze && mariaDb)
        {
            // Estimates and measurements (r_rows, r_total_time_ms …) in one JSON document.
            json = await Db.ScalarAsync(c, log, "ANALYZE FORMAT=JSON " + stmt, ct);
        }
        else
        {
            json = await Db.ScalarAsync(c, log, "EXPLAIN FORMAT=JSON " + stmt, ct);
        }
        var notes = (await Db.RowsAsync(c, null, "SHOW WARNINGS", ct))
            .Select(r => new { level = r["Level"], code = r["Code"], message = r["Message"] }).ToList();

        ResultSet table;
        await using (var cmd = Db.Cmd(c, log, "EXPLAIN " + stmt, [], out var line))
        {
            try
            {
                await using var r = await cmd.ExecuteReaderAsync(ct);
                table = await Values.ReadAsync(r, 1000, ct);
            }
            finally { log.Finish(line); }
        }

        if (analyze && !mariaDb)
        {
            try
            {
                analyzeText = await Db.ScalarAsync(c, log, "EXPLAIN ANALYZE " + stmt, ct);
            }
            catch (MySqlException ex) when (ex.Number == 1064)
            {
                throw new ApiException("This server doesn't support EXPLAIN ANALYZE (MySQL 8.0.18 or later is needed).");
            }
        }
        return new
        {
            server = mariaDb ? "mariadb" : "mysql",
            statement = stmt,
            json,
            table,
            notes,
            analyzed = analyze,
            analyzeTree = analyzeText,
            canAnalyze = CanAnalyze(stmt),
        };
    }
}
