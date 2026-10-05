using System.Text;
using MySqlConnector;

namespace ZawSQL;

/// <summary>One privilege target of an account: global, database, table, column or routine.</summary>
public sealed class GrantObject
{
    /// <summary>global | db | table | column | routine</summary>
    public string Level { get; set; } = "global";
    public string? Db { get; set; }
    public string? Table { get; set; }
    public string? Column { get; set; }
    /// <summary>PROCEDURE or FUNCTION for routine grants.</summary>
    public string? RoutineType { get; set; }
    public List<string> Privs { get; set; } = [];
    /// <summary>True when the grant said ALL [PRIVILEGES]; the UI expands it to the level's privileges.</summary>
    public bool All { get; set; }
    public bool GrantOption { get; set; }
}

public sealed class UserDetail
{
    public string User { get; set; } = "";
    public string Host { get; set; } = "";
    public string? Plugin { get; set; }
    public bool Locked { get; set; }
    public bool PasswordExpired { get; set; }
    public Dictionary<string, long> Limits { get; set; } = [];
    public List<GrantObject> Grants { get; set; } = [];
    public List<string> Roles { get; set; } = [];
    /// <summary>Grant lines the editor doesn't model (e.g. PROXY); shown read-only.</summary>
    public List<string> Other { get; set; } = [];
}

public sealed record ApplyUserRequest(string[] Statements, string? Password);

public static class UserAdmin
{
    public const string PasswordToken = "{{PASSWORD}}";

    static readonly (string Key, string Column)[] LimitColumns =
    [
        ("maxQueries", "max_questions"), ("maxUpdates", "max_updates"),
        ("maxConnections", "max_connections"), ("maxUserConnections", "max_user_connections"),
    ];

    public static string Account(string user, string host) => SqlLiteral.Quote(user) + "@" + SqlLiteral.Quote(host);

    public static async Task<List<object>> ListAsync(MySqlConnection c, SqlLog log, CancellationToken ct)
    {
        var rows = await Db.RowsAsync(c, log, "SELECT * FROM mysql.user ORDER BY User, Host", ct);
        return rows.Select(r => (object)new
        {
            user = r.GetValueOrDefault("User") ?? "",
            host = r.GetValueOrDefault("Host") ?? "",
            plugin = r.GetValueOrDefault("plugin"),
            locked = r.GetValueOrDefault("account_locked") == "Y",
            expired = r.GetValueOrDefault("password_expired") == "Y",
        }).ToList();
    }

    public static async Task<UserDetail> LoadAsync(MySqlConnection c, SqlLog log, string user, string host, CancellationToken ct)
    {
        var row = (await Db.RowsAsync(c, log, "SELECT * FROM mysql.user WHERE User = @p0 AND Host = @p1", ct, user, host)).FirstOrDefault()
            ?? throw new ApiException($"Account {user}@{host} was not found.");
        var d = new UserDetail
        {
            User = user,
            Host = host,
            Plugin = row.GetValueOrDefault("plugin"),
            Locked = row.GetValueOrDefault("account_locked") == "Y",
            PasswordExpired = row.GetValueOrDefault("password_expired") == "Y",
        };
        foreach (var (key, col) in LimitColumns)
            d.Limits[key] = long.TryParse(row.GetValueOrDefault(col), out var n) ? n : 0;

        var lines = await Db.ColumnAsync(c, log, $"SHOW GRANTS FOR {Account(user, host)}", ct);
        ParseGrants(lines, d);
        return d;
    }

    /// <summary>Parses SHOW GRANTS output (MySQL and MariaDB) into grant objects, roles and unsupported lines.</summary>
    public static void ParseGrants(IEnumerable<string> lines, UserDetail d)
    {
        foreach (var line in lines)
        {
            if (!line.StartsWith("GRANT ", StringComparison.OrdinalIgnoreCase)) { d.Other.Add(line); continue; }
            var rest = line[6..];
            var on = FindTopLevel(rest, " ON ");
            var to = FindTopLevel(rest, " TO ");
            if (on < 0 || (to >= 0 && to < on))
            {
                // Role grant: GRANT `role`@`%`, `r2` TO `user`@`host`
                if (to > 0) d.Roles.AddRange(SplitTopLevel(rest[..to], ','));
                else d.Other.Add(line);
                continue;
            }
            var privPart = rest[..on].Trim();
            if (privPart.StartsWith("PROXY", StringComparison.OrdinalIgnoreCase)) { d.Other.Add(line); continue; }

            var after = rest[(on + 4)..];
            var toIdx = FindTopLevel(after, " TO ");
            var target = (toIdx >= 0 ? after[..toIdx] : after).Trim();
            var grantOption = toIdx >= 0 && after[toIdx..].Contains("WITH GRANT OPTION", StringComparison.OrdinalIgnoreCase);
            string? routineType = null;
            foreach (var kw in new[] { "PROCEDURE ", "FUNCTION ", "TABLE " })
            {
                if (target.StartsWith(kw, StringComparison.OrdinalIgnoreCase))
                {
                    if (kw != "TABLE ") routineType = kw.Trim().ToUpperInvariant();
                    target = target[kw.Length..].Trim();
                }
            }

            var parts = SplitTopLevel(target, '.');
            var p1 = Unquote(parts.ElementAtOrDefault(0) ?? "*");
            var p2 = Unquote(parts.ElementAtOrDefault(1) ?? "*");
            var baseObj = p1 == "*" && p2 == "*" ? new GrantObject { Level = "global" }
                : p2 == "*" ? new GrantObject { Level = "db", Db = p1 }
                : routineType != null ? new GrantObject { Level = "routine", Db = p1, Table = p2, RoutineType = routineType }
                : new GrantObject { Level = "table", Db = p1, Table = p2 };
            var obj = Merge(d.Grants, baseObj);
            obj.GrantOption |= grantOption;

            foreach (var priv in SplitTopLevel(privPart, ','))
            {
                var paren = priv.IndexOf('(');
                var name = (paren >= 0 ? priv[..paren] : priv).Trim().ToUpperInvariant();
                if (name == "USAGE") continue;
                if (name is "ALL" or "ALL PRIVILEGES") { obj.All = true; continue; }
                if (paren >= 0 && baseObj.Level == "table")
                {
                    var cols = SplitTopLevel(priv[(paren + 1)..priv.LastIndexOf(')')], ',').Select(Unquote);
                    foreach (var col in cols)
                    {
                        var colObj = Merge(d.Grants, new GrantObject { Level = "column", Db = baseObj.Db, Table = baseObj.Table, Column = col });
                        if (!colObj.Privs.Contains(name)) colObj.Privs.Add(name);
                    }
                    continue;
                }
                if (!obj.Privs.Contains(name)) obj.Privs.Add(name);
            }
        }
        // A table line that only carried column privileges leaves an empty table object behind.
        d.Grants.RemoveAll(g => g.Level == "table" && g.Privs.Count == 0 && !g.All && !g.GrantOption);
    }

    static GrantObject Merge(List<GrantObject> list, GrantObject o)
    {
        var existing = list.FirstOrDefault(g => g.Level == o.Level && g.Db == o.Db && g.Table == o.Table && g.Column == o.Column && g.RoutineType == o.RoutineType);
        if (existing != null) return existing;
        list.Add(o);
        return o;
    }

    /// <summary>Executes account statements; the password is substituted for the token and never logged.</summary>
    public static async Task<object> ApplyAsync(MySqlConnection c, SqlLog log, ApplyUserRequest req, CancellationToken ct)
    {
        var executed = 0;
        foreach (var stmt in req.Statements)
        {
            if (stmt.Contains(PasswordToken) && req.Password == null)
                throw new ApiException("A password is required.");
            var sql = req.Password == null ? stmt : stmt.Replace(PasswordToken, SqlLiteral.Quote(req.Password));
            var line = log.Add(stmt.Replace(PasswordToken, "'***'"));
            try
            {
                await using var cmd = c.CreateCommand();
                cmd.CommandText = sql;
                await cmd.ExecuteNonQueryAsync(ct);
                log.Finish(line);
            }
            catch (MySqlException ex)
            {
                log.Add($"/* SQL Error ({ex.Number}): {ex.Message} */");
                return new { executed, error = new { statement = executed, message = ex.Message, code = ex.Number } };
            }
            executed++;
        }
        return new { executed, error = (object?)null };
    }

    // ---- lexical helpers (respect quotes, backticks and parentheses) ----

    static int FindTopLevel(string s, string token)
    {
        var depth = 0;
        char q = '\0';
        for (var i = 0; i < s.Length; i++)
        {
            var ch = s[i];
            if (q != '\0')
            {
                if (ch == '\\' && q != '`') { i++; continue; }
                if (ch == q) q = '\0';
                continue;
            }
            if (ch is '`' or '\'' or '"') q = ch;
            else if (ch == '(') depth++;
            else if (ch == ')') depth--;
            else if (depth == 0 && string.Compare(s, i, token, 0, token.Length, StringComparison.OrdinalIgnoreCase) == 0) return i;
        }
        return -1;
    }

    static List<string> SplitTopLevel(string s, char sep)
    {
        var list = new List<string>();
        var sb = new StringBuilder();
        var depth = 0;
        char q = '\0';
        for (var i = 0; i < s.Length; i++)
        {
            var ch = s[i];
            if (q != '\0')
            {
                sb.Append(ch);
                if (ch == '\\' && q != '`' && i + 1 < s.Length) { sb.Append(s[++i]); continue; }
                if (ch == q) q = '\0';
                continue;
            }
            if (ch is '`' or '\'' or '"') q = ch;
            else if (ch == '(') depth++;
            else if (ch == ')') depth--;
            else if (ch == sep && depth == 0) { list.Add(sb.ToString().Trim()); sb.Clear(); continue; }
            sb.Append(ch);
        }
        if (sb.ToString().Trim().Length > 0) list.Add(sb.ToString().Trim());
        return list;
    }

    static string Unquote(string s)
    {
        s = s.Trim();
        if (s.Length >= 2 && s[0] == '`' && s[^1] == '`') return s[1..^1].Replace("``", "`");
        if (s.Length >= 2 && (s[0] == '\'' || s[0] == '"') && s[^1] == s[0]) return s[1..^1].Replace(@"\'", "'").Replace("''", "'");
        return s;
    }
}
