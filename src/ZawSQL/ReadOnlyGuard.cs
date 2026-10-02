using System.Text;

namespace ZawSQL;

/// <summary>
/// Decides whether a statement may run on a read-only session. This is one of two layers: read-only
/// sessions also run with SET SESSION TRANSACTION READ ONLY, which makes the server reject data changes
/// that this lexical check can't see (e.g. a stored function called from a SELECT).
/// </summary>
public static class ReadOnlyGuard
{
    static readonly HashSet<string> AllowedFirst = new(StringComparer.OrdinalIgnoreCase)
        { "SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "USE", "TABLE", "VALUES", "HELP" };

    // Statements that only read metadata; their syntax legitimately contains words like CREATE (SHOW CREATE TABLE).
    static readonly HashSet<string> NoScan = new(StringComparer.OrdinalIgnoreCase) { "SHOW", "DESCRIBE", "DESC", "USE", "HELP" };

    static readonly HashSet<string> Forbidden = new(StringComparer.OrdinalIgnoreCase)
        { "INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP", "ALTER", "TRUNCATE", "RENAME", "GRANT", "REVOKE", "OUTFILE", "DUMPFILE" };

    // These are also names of harmless string/number functions when followed by "(".
    static readonly HashSet<string> AlsoFunctions = new(StringComparer.OrdinalIgnoreCase) { "INSERT", "REPLACE", "TRUNCATE" };

    /// <summary>Returns null when the statement is allowed, otherwise the reason it is rejected.</summary>
    public static string? Check(string sql)
    {
        // Statement text may contain several statements (e.g. via DELIMITER tricks); each one is checked.
        var segments = new List<List<(string Word, char Next)>> { new() };
        var n = sql.Length;
        var i = 0;
        while (i < n)
        {
            var c = sql[i];
            if (c is '\'' or '"' or '`')
            {
                i = SkipQuoted(sql, i, c);
                segments[^1].Add(("'", ' '));
                continue;
            }
            if (c == '#' || (c == '-' && i + 1 < n && sql[i + 1] == '-' && (i + 2 >= n || char.IsWhiteSpace(sql[i + 2]))))
            {
                var e = sql.IndexOf('\n', i);
                i = e < 0 ? n : e;
                continue;
            }
            if (c == '/' && i + 1 < n && sql[i + 1] == '*')
            {
                if (i + 2 < n && sql[i + 2] == '!')
                    return "Executable comments (/*! ... */) are not allowed in read-only mode.";
                var e = sql.IndexOf("*/", i + 2, StringComparison.Ordinal);
                i = e < 0 ? n : e + 2;
                continue;
            }
            if (c == ';')
            {
                segments.Add([]);
                i++;
                continue;
            }
            if (c == '(')
            {
                segments[^1].Add(("(", ' '));
                i++;
                continue;
            }
            if (char.IsLetterOrDigit(c) || c is '_' or '$')
            {
                var sb = new StringBuilder();
                while (i < n && (char.IsLetterOrDigit(sql[i]) || sql[i] is '_' or '$')) sb.Append(sql[i++]);
                var j = i;
                while (j < n && char.IsWhiteSpace(sql[j])) j++;
                segments[^1].Add((sb.ToString(), j < n ? sql[j] : ' '));
                continue;
            }
            i++;
        }

        foreach (var tokens in segments)
        {
            if (tokens.Count == 0) continue;
            var first = tokens.FirstOrDefault(t => t.Word != "(").Word;
            if (first == null || !AllowedFirst.Contains(first))
                return $"{(first is null or "'" ? "This" : first.ToUpperInvariant())} statement is not allowed in read-only mode. Only SELECT, SHOW, DESCRIBE, EXPLAIN and USE can run.";
            if (NoScan.Contains(first)) continue;
            for (var k = 0; k < tokens.Count; k++)
            {
                var (w, next) = tokens[k];
                if (!Forbidden.Contains(w)) continue;
                if (next == '(' && AlsoFunctions.Contains(w)) continue;
                if (w.Equals("UPDATE", StringComparison.OrdinalIgnoreCase) && k > 0 && tokens[k - 1].Word.Equals("FOR", StringComparison.OrdinalIgnoreCase)) continue;
                return $"{w.ToUpperInvariant()} is not allowed in read-only mode.";
            }
        }
        return null;
    }

    static int SkipQuoted(string s, int i, char q)
    {
        i++;
        while (i < s.Length)
        {
            var c = s[i];
            if (c == '\\' && q != '`') { i += 2; continue; }
            if (c == q)
            {
                if (i + 1 < s.Length && s[i + 1] == q) { i += 2; continue; }
                return i + 1;
            }
            i++;
        }
        return i;
    }
}
