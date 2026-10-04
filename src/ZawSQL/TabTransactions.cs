using System.Data;
using System.Text;
using MySqlConnector;

namespace ZawSQL;

/// <summary>What a statement does to the transaction of a manual-commit connection.</summary>
public enum TxEffect
{
    /// <summary>Reads only (SELECT, SHOW, SET …): nothing to commit.</summary>
    Read,
    /// <summary>Changes data or takes locks (INSERT, UPDATE, SELECT … FOR UPDATE, CALL …): part of the open transaction.</summary>
    Change,
    Commit,
    Rollback,
    /// <summary>START TRANSACTION / BEGIN: commits what is open, then starts anew.</summary>
    Begin,
    /// <summary>DDL, GRANT, LOCK TABLES …: the server commits the open transaction before running it.</summary>
    ImplicitCommit,
    /// <summary>SET autocommit = …: would take the connection out of manual-commit mode.</summary>
    Autocommit,
}

/// <summary>A query tab's own connection in manual-commit mode, with what its open transaction holds.</summary>
public sealed class TabConnection
{
    public required MySqlConnection Conn { get; set; }
    /// <summary>The window (heartbeat page id) that opened it; closed when that window goes away.</summary>
    public string? Page { get; init; }
    public SemaphoreSlim Gate { get; } = new(1, 1);
    public MySqlCommand? Running { get; set; }
    /// <summary>When the first change of the open transaction ran; null when there is nothing to commit.</summary>
    public DateTime? Since { get; set; }
    /// <summary>Statements (and grid edits) in the open transaction that changed data or took locks.</summary>
    public int Changes { get; set; }

    public void Reset() => (Since, Changes) = (null, 0);

    public void Changed()
    {
        Since ??= DateTime.UtcNow;
        Changes++;
    }

    public object State() => new { manual = true, open = Changes > 0, changes = Changes, since = Since?.ToString("o"), threadId = Conn.ServerThread };

    public async Task<IAsyncDisposable> AcquireAsync(CancellationToken ct)
    {
        if (!await Gate.WaitAsync(TimeSpan.FromSeconds(3), ct))
            throw new ApiException("This tab's connection is busy executing another query. Wait for it to finish or stop it.");
        return new Lease(Gate);
    }

    sealed class Lease(SemaphoreSlim gate) : IAsyncDisposable
    {
        int released;
        public ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref released, 1) == 0) gate.Release();
            return ValueTask.CompletedTask;
        }
    }
}

/// <summary>
/// Manual-commit mode for query tabs: each such tab gets its own connection with autocommit off, so its changes stay
/// in a transaction until it commits or rolls back, without affecting other tabs. The effect of every statement is
/// tracked (changes, COMMIT/ROLLBACK typed in the editor, statements that commit implicitly) so the UI can show
/// what is open. Closing the connection, or losing it, makes the server roll the transaction back.
/// </summary>
public static class TabTransactions
{
    /// <summary>The words of a statement outside strings, quoted names and comments, upper-cased ("(" kept as a token).</summary>
    static List<string> Words(string sql, int max = 400)
    {
        var words = new List<string>();
        var n = sql.Length;
        var i = 0;
        while (i < n && words.Count < max)
        {
            var c = sql[i];
            if (c is '\'' or '"' or '`')
            {
                i++;
                while (i < n && sql[i] != c) i += sql[i] == '\\' && c != '`' ? 2 : 1;
                i++;
                words.Add("'");
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
                {
                    // Executable comment: its content is code ("/*!40101 SET … */").
                    i += 3;
                    while (i < n && char.IsDigit(sql[i])) i++;
                    continue;
                }
                var e = sql.IndexOf("*/", i + 2, StringComparison.Ordinal);
                i = e < 0 ? n : e + 2;
                continue;
            }
            if (c == '(') { words.Add("("); i++; continue; }
            if (char.IsLetterOrDigit(c) || c is '_' or '$' or '@')
            {
                var sb = new StringBuilder();
                while (i < n && (char.IsLetterOrDigit(sql[i]) || sql[i] is '_' or '$' or '@' or '.')) sb.Append(char.ToUpperInvariant(sql[i++]));
                words.Add(sb.ToString());
                continue;
            }
            if (c == '=') { words.Add("="); i++; continue; }
            i++;
        }
        return words;
    }

    static readonly HashSet<string> ReadFirst = new(StringComparer.Ordinal)
        { "SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "USE", "TABLE", "VALUES", "HELP", "SET", "DO", "SAVEPOINT", "RELEASE", "PREPARE", "DEALLOCATE", "KILL", "(" };

    // Statements the server commits the open transaction for (MySQL "Statements That Cause an Implicit Commit").
    static readonly HashSet<string> CommitFirst = new(StringComparer.Ordinal)
        { "ALTER", "CREATE", "DROP", "RENAME", "TRUNCATE", "GRANT", "REVOKE", "LOCK", "UNLOCK", "INSTALL", "UNINSTALL", "ANALYZE", "CHECK", "OPTIMIZE", "REPAIR", "CACHE", "FLUSH", "RESET", "START", "BEGIN", "LOAD" };

    static readonly HashSet<string> ChangeWords = new(StringComparer.Ordinal) { "INSERT", "UPDATE", "DELETE", "REPLACE" };

    /// <summary>What the statement does to the open transaction (decided from its words, like the server's parser would).</summary>
    public static TxEffect Classify(string sql)
    {
        var w = Words(sql);
        if (w.Count == 0) return TxEffect.Read;
        string At(int k) => k < w.Count ? w[k] : "";
        switch (w[0])
        {
            case "COMMIT": return TxEffect.Commit;
            case "ROLLBACK": return At(1) == "TO" || (At(1) == "WORK" && At(2) == "TO") ? TxEffect.Read : TxEffect.Rollback;
            case "BEGIN": return At(1) is "" or "WORK" ? TxEffect.Begin : TxEffect.Change; // BEGIN NOT ATOMIC is a compound statement
            case "START": return At(1) == "TRANSACTION" ? TxEffect.Begin : TxEffect.ImplicitCommit; // START REPLICA/SLAVE commits too
            case "SET":
                for (var k = 1; k + 1 < w.Count; k++)
                    if (w[k] is "AUTOCOMMIT" or "@@AUTOCOMMIT" or "@@SESSION.AUTOCOMMIT" && w[k + 1] == "=") return TxEffect.Autocommit;
                return At(1) == "PASSWORD" ? TxEffect.ImplicitCommit : TxEffect.Read;
            case "CREATE" or "DROP" when At(1) == "TEMPORARY": return TxEffect.Change; // temporary tables don't commit
            case "LOAD" when At(1) is "DATA" or "XML": return TxEffect.Change; // only LOAD INDEX commits
            case "UNLOCK" or "LOCK" when At(1) is "INSTANCE": return TxEffect.Read;
        }
        if (CommitFirst.Contains(w[0])) return TxEffect.ImplicitCommit;
        if (ReadFirst.Contains(w[0]))
        {
            // Locking reads hold row locks until the transaction ends; WITH … UPDATE/DELETE changes data.
            for (var k = 1; k < w.Count; k++)
            {
                if (w[k] == "FOR" && At(k + 1) is "UPDATE" or "SHARE") return TxEffect.Change;
                if (w[k] == "LOCK" && At(k + 1) == "IN" && At(k + 2) == "SHARE") return TxEffect.Change;
                if (w[0] == "WITH" && ChangeWords.Contains(w[k]) && At(k + 1) != "(") return TxEffect.Change;
            }
            return TxEffect.Read;
        }
        return TxEffect.Change; // INSERT, UPDATE, DELETE, REPLACE, CALL, HANDLER, XA …
    }

    /// <summary>Applies a statement that ran; returns a note for the user when it ended or reset the transaction.</summary>
    public static string? Apply(TabConnection t, string sql, TxEffect effect)
    {
        var had = t.Changes;
        string Pending() => $"{had} change{(had == 1 ? "" : "s")}";
        switch (effect)
        {
            case TxEffect.Change:
                t.Changed();
                return null;
            case TxEffect.Commit:
                t.Reset();
                return had > 0 ? $"COMMIT made the open transaction ({Pending()}) permanent." : null;
            case TxEffect.Rollback:
                t.Reset();
                return had > 0 ? $"ROLLBACK undid the open transaction ({Pending()})." : null;
            case TxEffect.Begin:
                t.Reset();
                return had > 0 ? $"START TRANSACTION first committed the open transaction ({Pending()})." : null;
            case TxEffect.ImplicitCommit:
                t.Reset();
                var verb = string.Join(' ', Words(sql, 2));
                return had > 0 ? $"{verb} committed the open transaction ({Pending()}) – the server does that before this kind of statement." : null;
            default:
                return null;
        }
    }

    /// <summary>Opens the tab's own connection (autocommit off) if it hasn't one yet.</summary>
    public static async Task<TabConnection> StartAsync(DbSession s, string tab, string? database, string? page, SqlLog log, CancellationToken ct)
    {
        if (s.Tabs.TryGetValue(tab, out var existing)) return existing;
        s.Tunnel?.EnsureConnected(log);
        var c = await ConnectionManager.OpenMainAsync(s, log, ct);
        try
        {
            if (!string.IsNullOrEmpty(database)) await c.ChangeDatabaseAsync(database, ct);
            await Db.ExecAsync(c, log, "SET autocommit = 0", ct);
        }
        catch
        {
            await c.DisposeAsync();
            throw;
        }
        log.Add($"/* Manual commit: this tab has its own connection (Thread-ID: {c.ServerThread}); changes stay uncommitted until Commit. */");
        var t = new TabConnection { Conn = c, Page = page };
        if (!s.Tabs.TryAdd(tab, t))
        {
            await c.DisposeAsync();
            return s.Tabs[tab];
        }
        return t;
    }

    /// <summary>
    /// The tab's connection, ready to use. If the server dropped it (wait_timeout, restart), a new one is opened and
    /// the user is told what was lost instead of running anything on it.
    /// </summary>
    public static async Task<MySqlConnection> EnsureAsync(DbSession s, TabConnection t, SqlLog log, CancellationToken ct)
    {
        s.Tunnel?.EnsureConnected(log);
        if (t.Conn.State == ConnectionState.Open && await t.Conn.PingAsync(ct)) return t.Conn;
        var lost = t.Changes;
        var db = t.Conn.Database;
        await t.Conn.DisposeAsync();
        var c = await ConnectionManager.OpenMainAsync(s, log, ct);
        if (!string.IsNullOrEmpty(db)) await c.ChangeDatabaseAsync(db, ct);
        await Db.ExecAsync(c, log, "SET autocommit = 0", ct);
        t.Conn = c;
        t.Reset();
        log.Add($"/* The tab's connection was lost and has been reopened (Thread-ID: {c.ServerThread}). */");
        if (lost > 0)
            throw new ApiException($"This tab's connection to the server was lost, so the server rolled back its open transaction ({lost} change{(lost == 1 ? "" : "s")}). Nothing was run; run the statements again.");
        return c;
    }

    /// <summary>COMMIT or ROLLBACK the tab's open transaction.</summary>
    public static async Task<object> FinishAsync(DbSession s, string tab, bool commit, SqlLog log, CancellationToken ct)
    {
        if (!s.Tabs.TryGetValue(tab, out var t)) throw new ApiException("This tab is not in manual-commit mode.");
        await using var lease = await t.AcquireAsync(ct);
        var c = await EnsureAsync(s, t, log, ct);
        var changes = t.Changes;
        await Db.ExecAsync(c, log, commit ? "COMMIT" : "ROLLBACK", ct);
        t.Reset();
        return new { done = commit ? "commit" : "rollback", changes, transaction = t.State() };
    }

    /// <summary>Leaves manual-commit mode: commits or rolls back what is open, then closes the tab's connection.</summary>
    public static async Task<object> CloseAsync(DbSession s, string tab, string? then, SqlLog log, CancellationToken ct)
    {
        if (!s.Tabs.TryGetValue(tab, out var t)) return new { manual = false };
        await using (var lease = await t.AcquireAsync(ct))
        {
            if (t.Changes > 0)
            {
                if (then is not ("commit" or "rollback")) throw new ApiException("The tab has an open transaction; commit or roll it back first.");
                if (t.Conn.State == ConnectionState.Open) await Db.ExecAsync(t.Conn, log, then == "commit" ? "COMMIT" : "ROLLBACK", ct);
            }
            s.Tabs.TryRemove(tab, out _);
            await t.Conn.DisposeAsync();
        }
        log.Add("/* Auto-commit: the tab uses the session's connection again. */");
        return new { manual = false };
    }
}
