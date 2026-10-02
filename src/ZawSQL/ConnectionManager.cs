using System.Collections.Concurrent;
using System.Data;
using MySqlConnector;

namespace ZawSQL;

/// <summary>
/// One open server connection in the UI. The "main" connection keeps session state (USE, variables,
/// transactions) for the query tabs and row edits; metadata requests use short-lived pooled connections
/// so browsing the tree never waits for a long running query.
/// </summary>
public sealed class DbSession
{
    public required string Id { get; init; }
    public required SessionProfile Profile { get; init; }
    public required string MainConnectionString { get; init; }
    public required string MetaConnectionString { get; init; }
    public MySqlConnection? Main { get; set; }
    public MySqlCommand? Running { get; set; }
    public SemaphoreSlim Gate { get; } = new(1, 1);

    public async Task<IAsyncDisposable> AcquireAsync(CancellationToken ct)
    {
        if (!await Gate.WaitAsync(TimeSpan.FromSeconds(3), ct))
            throw new ApiException("The connection is busy executing another query. Wait for it to finish or stop it.");
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

public sealed class ConnectionManager : IAsyncDisposable
{
    readonly ConcurrentDictionary<string, DbSession> sessions = new();

    public static string BuildConnectionString(SessionProfile p, string password, bool pooling, int commandTimeout)
    {
        var b = new MySqlConnectionStringBuilder
        {
            Server = p.Host,
            Port = (uint)p.Port,
            UserID = p.User,
            Password = password,
            SslMode = Enum.TryParse<MySqlSslMode>(p.SslMode, true, out var ssl) ? ssl : MySqlSslMode.Preferred,
            AllowPublicKeyRetrieval = true,
            AllowUserVariables = true,
            AllowZeroDateTime = true,
            ConvertZeroDateTime = false,
            TreatTinyAsBoolean = false,
            GuidFormat = MySqlGuidFormat.None,
            ConnectionTimeout = (uint)Math.Clamp(p.ConnectTimeout, 1, 600),
            DefaultCommandTimeout = (uint)commandTimeout,
            Pooling = pooling,
            AllowLoadLocalInfile = false,
            ApplicationName = "ZawSQL",
            UseCompression = p.Compression,
        };
        if (p.Host.StartsWith('/'))
            b.ConnectionProtocol = MySqlConnectionProtocol.UnixSocket;
        if (pooling)
        {
            b.MinimumPoolSize = 0;
            b.MaximumPoolSize = 10;
            b.ConnectionIdleTimeout = 60;
        }
        return b.ConnectionString;
    }

    public async Task<DbSession> ConnectAsync(SessionProfile p, string password, SqlLog log, CancellationToken ct)
    {
        var s = new DbSession
        {
            Id = Guid.NewGuid().ToString("n")[..12],
            Profile = p,
            MainConnectionString = BuildConnectionString(p, password, pooling: false, commandTimeout: 0),
            MetaConnectionString = BuildConnectionString(p, password, pooling: true, commandTimeout: 120),
        };
        log.Add($"/* Connecting to {p.Host}{(p.Host.StartsWith('/') ? "" : ":" + p.Port)} as {p.User}, using password: {(password.Length > 0 ? "Yes" : "No")} ... */");
        s.Main = await OpenMainAsync(s, log, ct);
        log.Add($"/* Connected. Thread-ID: {s.Main.ServerThread}{(p.ReadOnly ? ", read-only mode" : "")} */");
        sessions[s.Id] = s;
        return s;
    }

    /// <summary>Opens a main connection; read-only sessions make the server itself reject data changes.</summary>
    static async Task<MySqlConnection> OpenMainAsync(DbSession s, SqlLog log, CancellationToken ct)
    {
        var c = new MySqlConnection(s.MainConnectionString);
        await c.OpenAsync(ct);
        if (s.Profile.ReadOnly)
        {
            try
            {
                await Db.ExecAsync(c, log, "SET SESSION TRANSACTION READ ONLY", ct);
            }
            catch
            {
                await c.DisposeAsync();
                throw;
            }
        }
        return c;
    }

    public DbSession Get(string id) =>
        sessions.TryGetValue(id, out var s) ? s : throw new ApiException("This session is not connected. Open it again from the session manager.");

    public async Task<MySqlConnection> OpenMetaAsync(DbSession s, CancellationToken ct)
    {
        var c = new MySqlConnection(s.MetaConnectionString);
        await c.OpenAsync(ct);
        return c;
    }

    /// <summary>Returns the main connection, transparently reconnecting if the server dropped it.</summary>
    public async Task<MySqlConnection> EnsureMainAsync(DbSession s, SqlLog log, CancellationToken ct)
    {
        var c = s.Main!;
        if (c.State == ConnectionState.Open && await c.PingAsync(ct)) return c;
        log.Add("/* Connection to server lost, reconnecting ... */");
        var db = c.Database;
        await c.DisposeAsync();
        c = await OpenMainAsync(s, log, ct);
        if (!string.IsNullOrEmpty(db)) await c.ChangeDatabaseAsync(db, ct);
        s.Main = c;
        log.Add($"/* Reconnected. Thread-ID: {c.ServerThread} */");
        return c;
    }

    public async Task<object?> InfoAsync(DbSession s, SqlLog log, CancellationToken ct)
    {
        await using var c = await OpenMetaAsync(s, ct);
        var r = (await Db.RowsAsync(c, log, "SELECT VERSION() AS version, @@version_comment AS comment, CURRENT_USER() AS user", ct))[0];
        var up = await Db.RowsAsync(c, log, "SHOW GLOBAL STATUS LIKE 'Uptime'", ct);
        var version = r["version"] ?? "";
        return new
        {
            sid = s.Id,
            profileId = s.Profile.Id,
            name = s.Profile.Name,
            host = s.Profile.Host,
            port = s.Profile.Port,
            user = r["user"],
            version,
            versionComment = r["comment"],
            uptime = up.FirstOrDefault()?["Value"],
            threadId = s.Main?.ServerThread,
            isMariaDb = version.Contains("MariaDB", StringComparison.OrdinalIgnoreCase),
            readOnly = s.Profile.ReadOnly,
            color = s.Profile.Color,
            production = s.Profile.Production,
        };
    }

    public async Task DisconnectAsync(string id)
    {
        if (!sessions.TryRemove(id, out var s)) return;
        try { s.Running?.Cancel(); } catch (Exception) { /* best effort */ }
        if (s.Main != null) await s.Main.DisposeAsync();
        await using var pooled = new MySqlConnection(s.MetaConnectionString);
        await MySqlConnection.ClearPoolAsync(pooled);
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var id in sessions.Keys.ToList())
        {
            try { await DisconnectAsync(id); } catch (Exception) { /* shutting down */ }
        }
    }
}
