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

    /// <summary>
    /// Returns null when the statement is allowed, otherwise the reason it is rejected. The text is read twice: with
    /// backslash escapes in strings, and without them (sql_mode NO_BACKSLASH_ESCAPES, where '\' is a whole string, so
    /// "SELECT '\'; SET GLOBAL …" would otherwise hide a second statement). It is allowed only if both readings allow it.
    /// </summary>
    public static string? Check(string sql) => Check(sql, backslashEscapes: true) ?? Check(sql, backslashEscapes: false);

    static string? Check(string sql, bool backslashEscapes)
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
                i = SkipQuoted(sql, i, c, backslashEscapes);
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
                if (IsExecutableComment(sql, i))
                    return "Executable comments (/*! ... */, MariaDB's /*M! ... */) are not allowed in read-only mode.";
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

    /// <summary>
    /// Whether the text holds a second statement: anything but whitespace and comments after a ";" outside quotes and
    /// comments. Text that gets a prefix (EXPLAIN …) must be one statement, or the rest would simply run.
    /// </summary>
    public static bool HasSeveralStatements(string sql) => HasSeveralStatements(sql, true) || HasSeveralStatements(sql, false);

    static bool HasSeveralStatements(string sql, bool backslashEscapes)
    {
        var n = sql.Length;
        var i = 0;
        var ended = false;
        while (i < n)
        {
            var c = sql[i];
            if (c == '#' || (c == '-' && i + 1 < n && sql[i + 1] == '-' && (i + 2 >= n || char.IsWhiteSpace(sql[i + 2]))))
            {
                var e = sql.IndexOf('\n', i);
                i = e < 0 ? n : e;
                continue;
            }
            if (c == '/' && i + 1 < n && sql[i + 1] == '*' && !IsExecutableComment(sql, i))
            {
                var e = sql.IndexOf("*/", i + 2, StringComparison.Ordinal);
                i = e < 0 ? n : e + 2;
                continue;
            }
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (c == ';') { ended = true; i++; continue; }
            if (ended) return true;
            i = c is '\'' or '"' or '`' ? SkipQuoted(sql, i, c, backslashEscapes) : i + 1;
        }
        return false;
    }

    /// <summary>"/*!" (MySQL and MariaDB) or "/*M!" (MariaDB): the server runs what is inside.</summary>
    static bool IsExecutableComment(string s, int i) =>
        i + 2 < s.Length && (s[i + 2] == '!' || (s[i + 2] is 'M' or 'm' && i + 3 < s.Length && s[i + 3] == '!'));

    static int SkipQuoted(string s, int i, char q, bool backslashEscapes)
    {
        i++;
        while (i < s.Length)
        {
            var c = s[i];
            if (c == '\\' && q != '`' && backslashEscapes) { i += 2; continue; }
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
