using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MySqlConnector;

namespace ZawSQL;

public sealed record ConnectRequest(string? SessionId, SessionProfile? Profile, string? Password, string? SshSecret = null);
public sealed record HostKeyRequest(string? Fingerprint);
public sealed record ExecRequest(string[] Statements, string? Database, int MaxRows = 10000, bool StopOnError = true);
public sealed record RowsRequest(string Db, string Table, List<RowOp> Ops);
public sealed record KillRequest(long Id);

public static class Api
{
    /// <summary>Error code for an SSH host key the user hasn't trusted yet; data carries the fingerprint.</summary>
    public const int SshHostKeyUnknown = 9001;

    const string ReadOnlyMessage = "This session is in read-only mode; changes are not allowed.";

    sealed record Response(bool Ok, object? Data, string? Error, int? Code, List<string> Log);

    static async Task<IResult> Run(Func<SqlLog, Task<object?>> body)
    {
        var log = new SqlLog();
        try
        {
            return Results.Json(new Response(true, await body(log), null, null, log.Items));
        }
        catch (MySqlException ex)
        {
            log.Add($"/* SQL Error ({ex.Number}): {ex.Message} */");
            return Results.Json(new Response(false, null, ex.Message, ex.Number, log.Items));
        }
        catch (SshHostKeyUnknownException ex)
        {
            log.Add($"/* {ex.Message} Fingerprint: {ex.Fingerprint} */");
            return Results.Json(new Response(false, new { host = ex.Host, port = ex.Port, fingerprint = ex.Fingerprint }, ex.Message, SshHostKeyUnknown, log.Items));
        }
        catch (OperationCanceledException)
        {
            return Results.Json(new Response(false, null, "The operation was cancelled.", null, log.Items));
        }
        catch (Exception ex)
        {
            return Results.Json(new Response(false, null, ex.Message, null, log.Items));
        }
    }

    static Task<IResult> RunSync(Func<object?> body) => Run(_ => Task.FromResult(body()));

    /// <summary>Runs a request on a fresh pooled metadata connection of the given session.</summary>
    static Task<IResult> Meta(ConnectionManager cm, string sid, CancellationToken ct, Func<MySqlConnection, DbSession, SqlLog, Task<object?>> body) =>
        Run(async log =>
        {
            var ses = cm.Get(sid);
            await using var c = await cm.OpenMetaAsync(ses, ct);
            return await body(c, ses, log);
        });

    static (SessionProfile, string, string?) ResolveProfile(ConnectRequest r, SessionStore st)
    {
        var p = r.Profile ?? (r.SessionId != null ? st.Get(r.SessionId) : null) ?? throw new ApiException("Session not found.");
        var pwd = r.Password ?? p.Password ?? (p.Id != null ? st.GetPassword(p.Id) : null) ?? "";
        var sshSecret = r.SshSecret ?? (string.IsNullOrEmpty(p.SshSecret) ? null : p.SshSecret) ?? (p.Id != null ? st.GetSshSecret(p.Id) : null);
        // An unsaved profile (connection test) may not carry the host key the user trusted earlier.
        if (p.SshHostKey == null && p.Id != null) p.SshHostKey = st.Get(p.Id)?.SshHostKey;
        return (p, pwd, sshSecret);
    }

    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api");

        // ---- application ----
        api.MapPost("/ping", (string? page, Heartbeat hb) => { hb.Ping(page); return Results.Ok(); });
        api.MapPost("/bye", (string? page, Heartbeat hb) => { hb.Bye(page); return Results.Ok(); });
        api.MapPost("/exit", (IHostApplicationLifetime life) =>
        {
            _ = Task.Delay(300).ContinueWith(_ => life.StopApplication());
            return RunSync(() => null);
        });
        api.MapGet("/state", (SessionStore st) => RunSync(() => st.LoadState()));
        api.MapPut("/state", async (HttpRequest req, SessionStore st) =>
        {
            using var doc = await JsonDocument.ParseAsync(req.Body);
            st.SaveState(doc.RootElement.GetRawText());
            return Results.Json(new Response(true, null, null, null, []));
        });

        api.MapGet("/library", (SessionStore st) => RunSync(() => st.LoadLibrary()));
        api.MapPut("/library", async (HttpRequest req, SessionStore st) =>
        {
            using var doc = await JsonDocument.ParseAsync(req.Body);
            return await RunSync(() => { st.SaveLibrary(doc.RootElement); return null; });
        });

        // ---- saved sessions ----
        api.MapGet("/sessions", (SessionStore st) => RunSync(() => st.List()));
        api.MapPost("/sessions", (SessionProfile p, SessionStore st) => RunSync(() => st.Save(p)));
        api.MapPost("/sessions/{id}/hostkey", (string id, HostKeyRequest r, SessionStore st) => RunSync(() =>
        {
            if (r.Fingerprint != null && !r.Fingerprint.StartsWith("SHA256:", StringComparison.Ordinal)) throw new ApiException("Invalid host key fingerprint.");
            st.SetSshHostKey(id, r.Fingerprint);
            return null;
        }));
        api.MapDelete("/sessions/{id}", (string id, SessionStore st) => RunSync(() => { st.Delete(id); return null; }));

        api.MapPost("/connect", (ConnectRequest r, SessionStore st, ConnectionManager cm, CancellationToken ct) => Run(async log =>
        {
            var (p, pwd, sshSecret) = ResolveProfile(r, st);
            var s = await cm.ConnectAsync(p, pwd, sshSecret, log, ct);
            return await cm.InfoAsync(s, log, ct);
        }));

        api.MapPost("/test", (ConnectRequest r, SessionStore st, CancellationToken ct) => Run(async log =>
        {
            var (p, pwd, sshSecret) = ResolveProfile(r, st);
            using var tunnel = p.SshEnabled ? await SshTunnel.OpenAsync(p, sshSecret, log, ct) : null;
            await using var c = new MySqlConnection(ConnectionManager.BuildConnectionString(p, pwd, false, 30, tunnel?.LocalPort));
            log.Add($"/* Testing connection to {p.Host}:{p.Port}{(tunnel != null ? " through SSH" : "")} as {p.User} */");
            await c.OpenAsync(ct);
            return new { version = c.ServerVersion, ssh = tunnel != null };
        }));

        // ---- per connected session ----
        var s = api.MapGroup("/s/{sid}");

        s.MapPost("/disconnect", (string sid, ConnectionManager cm) => Run(async _ => { await cm.DisconnectAsync(sid); return null; }));

        s.MapGet("/info", (string sid, ConnectionManager cm, CancellationToken ct) => Run(log => cm.InfoAsync(cm.Get(sid), log, ct)));

        s.MapGet("/databases", (string sid, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, ses, log) =>
        {
            var dbs = await Db.ColumnAsync(c, log, "SHOW DATABASES", ct);
            var filter = ses.Profile.Databases?.Split([';', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            return filter is { Length: > 0 } ? dbs.Where(d => filter.Contains(d, StringComparer.OrdinalIgnoreCase)).ToList() : dbs;
        }));

        s.MapGet("/objects", (string sid, string db, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, log) =>
        {
            var list = await Db.RowsAsync(c, log, """
                SELECT TABLE_NAME AS name, IF(TABLE_TYPE LIKE '%VIEW%', 'view', 'table') AS type, ENGINE AS engine,
                       TABLE_ROWS AS `rows`, DATA_LENGTH + INDEX_LENGTH AS size, CREATE_TIME AS created,
                       UPDATE_TIME AS updated, TABLE_COLLATION AS collation, TABLE_COMMENT AS comment
                FROM information_schema.TABLES WHERE TABLE_SCHEMA = @p0 ORDER BY TABLE_NAME
                """, ct, db);
            async Task TryAdd(string sql)
            {
                try { list.AddRange(await Db.RowsAsync(c, log, sql, ct, db)); }
                catch (MySqlException ex) { log.Add($"/* {ex.Message} */"); }
            }
            await TryAdd("SELECT ROUTINE_NAME AS name, LOWER(ROUTINE_TYPE) AS type, CREATED AS created, LAST_ALTERED AS updated, ROUTINE_COMMENT AS comment FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = @p0 ORDER BY ROUTINE_NAME");
            await TryAdd("SELECT TRIGGER_NAME AS name, 'trigger' AS type, CREATED AS created, CONCAT(ACTION_TIMING, ' ', EVENT_MANIPULATION, ' ON ', EVENT_OBJECT_TABLE) AS comment FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = @p0 ORDER BY TRIGGER_NAME");
            await TryAdd("SELECT EVENT_NAME AS name, 'event' AS type, CREATED AS created, LAST_ALTERED AS updated, EVENT_COMMENT AS comment FROM information_schema.EVENTS WHERE EVENT_SCHEMA = @p0 ORDER BY EVENT_NAME");
            return list;
        }));

        s.MapGet("/table", (string sid, string db, string table, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, log) =>
        {
            var m = await TableMeta.LoadAsync(c, log, db, table, ct);
            List<ForeignKeyMeta> fks = m.IsView ? [] : await TableMeta.LoadForeignKeysAsync(c, log, db, table, ct);
            var partitions = m.IsView ? null : await TableMeta.LoadPartitionsAsync(c, log, db, table, ct);
            var create = await TableMeta.ShowCreateAsync(c, log, db, m.IsView ? "VIEW" : "TABLE", table, ct);
            var options = (await Db.RowsAsync(c, log,
                "SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_COMMENT AS comment, AUTO_INCREMENT AS autoIncrement, ROW_FORMAT AS rowFormat FROM information_schema.TABLES WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1",
                ct, db, table)).FirstOrDefault() ?? [];
            // information_schema caches AUTO_INCREMENT on MySQL 8; SHOW CREATE TABLE is always current.
            var ai = create != null ? Regex.Match(create, @"\bAUTO_INCREMENT=(\d+)") : Match.Empty;
            options["autoIncrement"] = ai.Success ? ai.Groups[1].Value : m.IsView ? null : options.GetValueOrDefault("autoIncrement");
            return new { columns = m.Columns, indexes = m.Indexes, foreignKeys = fks, partitions, create, options, isView = m.IsView, keyColumns = m.KeyColumns };
        }));

        s.MapGet("/columns", (string sid, string db, string table, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, _) =>
            (await Db.RowsAsync(c, null, $"SHOW COLUMNS FROM {Db.Q(db, table)}", ct)).Select(r => new { name = r["Field"], type = r["Type"] }).ToList()));

        s.MapGet("/create", (string sid, string db, string type, string name, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, log) =>
            new { code = await TableMeta.ShowCreateAsync(c, log, db, type, name, ct) }));

        s.MapGet("/data", (string sid, string db, string table, int? offset, int? limit, string? order, string? dir, string? where,
            ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, log) =>
        {
            var m = await TableMeta.LoadAsync(c, null, db, table, ct);
            var sql = new StringBuilder($"SELECT * FROM {Db.Q(db, table)}");
            if (!string.IsNullOrWhiteSpace(where)) sql.Append(" WHERE (").Append(where).Append("\n)");
            if (!string.IsNullOrEmpty(order) && m.Columns.Any(x => x.Name == order))
                sql.Append(" ORDER BY ").Append(Db.Q(order)).Append(dir == "desc" ? " DESC" : " ASC");
            if (limit is > 0) sql.Append($" LIMIT {Math.Max(0, offset ?? 0)}, {limit}");
            var rs = await Db.QueryAsync(c, log, sql.ToString(), ct);
            var byName = m.Columns.ToDictionary(x => x.Name, StringComparer.OrdinalIgnoreCase);
            var cols = rs.Columns.Select(x =>
            {
                byName.TryGetValue(x.Name, out var mc);
                return new { name = x.Name, kind = x.Kind, type = mc?.Type ?? x.Type.ToLowerInvariant(), nullable = mc?.Nullable ?? true, extra = mc?.Extra, comment = mc?.Comment, generated = mc?.IsGenerated ?? false };
            }).ToList();
            return new { columns = cols, rows = rs.Rows, keyColumns = m.KeyColumns, keySource = m.KeySource, estimatedRows = m.EstimatedRows, isView = m.IsView };
        }));

        s.MapPost("/rows", (string sid, RowsRequest req, ConnectionManager cm, CancellationToken ct) => Run(async log =>
        {
            var ses = cm.Get(sid);
            if (ses.Profile.ReadOnly) throw new ApiException(ReadOnlyMessage);
            TableMetaInfo m;
            await using (var mc = await cm.OpenMetaAsync(ses, ct))
                m = await TableMeta.LoadAsync(mc, null, req.Db, req.Table, ct);
            if (m.IsView) throw new ApiException("Views are read-only in the data grid.");
            await using var lease = await ses.AcquireAsync(ct);
            var c = await cm.EnsureMainAsync(ses, log, ct);
            var results = new List<object>();
            foreach (var op in req.Ops)
                results.Add(await RowWriter.ApplyAsync(c, log, m, req.Db, req.Table, op, ct));
            return results;
        }));

        s.MapPost("/exec", (string sid, ExecRequest req, ConnectionManager cm, CancellationToken ct) => Run(async log =>
        {
            var ses = cm.Get(sid);
            await using var lease = await ses.AcquireAsync(ct);
            var c = await cm.EnsureMainAsync(ses, log, ct);
            if (!string.IsNullOrEmpty(req.Database) && c.Database != req.Database)
            {
                log.Add("USE " + Db.Q(req.Database));
                await c.ChangeDatabaseAsync(req.Database, ct);
            }

            var sets = new List<object>();
            var errors = new List<object>();
            long affected = 0;
            long? insertId = null;
            var executed = 0;
            var sw = Stopwatch.StartNew();
            for (var i = 0; i < req.Statements.Length; i++)
            {
                var sql = req.Statements[i];
                if (ses.Profile.ReadOnly && ReadOnlyGuard.Check(sql) is { } rejected)
                {
                    log.Add($"/* Blocked: {rejected}\n{sql.Replace("*/", "* /")} */");
                    if (errors.Count < 100) errors.Add(new { statement = i, message = rejected, code = 0 });
                    if (req.StopOnError) break;
                    continue;
                }
                if (i < 200) log.Add(sql);
                else if (i == 200) log.Add($"/* ... {req.Statements.Length - 200} more statements not logged */");
                await using var cmd = c.CreateCommand();
                cmd.CommandText = sql;
                cmd.CommandTimeout = 0;
                ses.Running = cmd;
                try
                {
                    await using var r = await cmd.ExecuteReaderAsync(ct);
                    do
                    {
                        if (r.FieldCount > 0)
                        {
                            var rs = await Values.ReadAsync(r, Math.Max(0, req.MaxRows), ct);
                            sets.Add(new { statement = i, sql, columns = rs.Columns, rows = rs.Rows, truncated = rs.Truncated, ms = sw.Elapsed.TotalMilliseconds });
                        }
                    } while (await r.NextResultAsync(ct));
                    if (r.RecordsAffected > 0) affected += r.RecordsAffected;
                    if (cmd.LastInsertedId > 0) insertId = cmd.LastInsertedId;
                    executed++;
                }
                catch (MySqlException ex) when (!ct.IsCancellationRequested)
                {
                    log.Add($"/* SQL Error ({ex.Number}): {ex.Message} */");
                    if (errors.Count < 100) errors.Add(new { statement = i, message = ex.Message, code = ex.Number });
                    if (req.StopOnError) break;
                }
                finally
                {
                    ses.Running = null;
                }
            }
            var ms = sw.Elapsed.TotalMilliseconds;
            var currentDb = await Db.ScalarAsync(c, null, "SELECT DATABASE()", ct);
            return new { resultSets = sets, statements = req.Statements.Length, executed, affected, insertId, errors, database = currentDb, ms };
        }));

        s.MapPost("/cancel", (string sid, ConnectionManager cm) => RunSync(() =>
        {
            cm.Get(sid).Running?.Cancel();
            return null;
        }));

        s.MapGet("/host", (string sid, string kind, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, log) =>
        {
            switch (kind)
            {
                case "databases":
                    return await Db.QueryAsync(c, log, """
                        SELECT s.SCHEMA_NAME AS `Database`, s.DEFAULT_COLLATION_NAME AS `Collation`, COUNT(t.TABLE_NAME) AS `Tables`,
                               SUM(t.DATA_LENGTH + t.INDEX_LENGTH) AS `Size`, MAX(t.UPDATE_TIME) AS `Last modified`
                        FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
                        GROUP BY s.SCHEMA_NAME, s.DEFAULT_COLLATION_NAME ORDER BY s.SCHEMA_NAME
                        """, ct);
                case "variables":
                {
                    var session = await Db.RowsAsync(c, log, "SHOW SESSION VARIABLES", ct);
                    var global = (await Db.RowsAsync(c, log, "SHOW GLOBAL VARIABLES", ct))
                        .GroupBy(r => r["Variable_name"] ?? "").ToDictionary(g => g.Key, g => g.First()["Value"]);
                    var rows = session.Select(r => new[] { r["Variable_name"], r["Value"], global.GetValueOrDefault(r["Variable_name"] ?? "") }).ToList();
                    return ResultSet.From(["Variable", "Session", "Global"], rows);
                }
                case "status": return await Db.QueryAsync(c, log, "SHOW GLOBAL STATUS", ct);
                case "processes": return await Db.QueryAsync(c, log, "SHOW FULL PROCESSLIST", ct);
                case "collations": return await Db.QueryAsync(c, null, "SHOW COLLATION", ct);
                case "charsets": return await Db.QueryAsync(c, null, "SHOW CHARACTER SET", ct);
                case "engines": return await Db.QueryAsync(c, null, "SHOW ENGINES", ct);
                default: throw new ApiException($"Unknown host information: {kind}");
            }
        }));

        // ---- live monitor (one sample per call; not logged) ----
        s.MapGet("/monitor", (string sid, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, _) =>
            await ServerMonitor.SampleAsync(c, ct)));

        // ---- table maintenance ----
        s.MapPost("/maintenance", (string sid, MaintenanceRequest req, ConnectionManager cm, CancellationToken ct) => Run(async log =>
        {
            var ses = cm.Get(sid);
            var sql = Maintenance.BuildSql(req);
            if (ses.Profile.ReadOnly && !Maintenance.IsReadOnly(req.Op))
                throw new ApiException("Only CHECK and CHECKSUM are available in read-only mode.");
            await using var c = await cm.OpenMetaAsync(ses, ct);
            await using var cmd = Db.Cmd(c, log, sql, []);
            cmd.CommandTimeout = 0; // OPTIMIZE / REPAIR can take a long time on big tables
            await using var r = await cmd.ExecuteReaderAsync(ct);
            return await Values.ReadAsync(r, int.MaxValue, ct);
        }));

        // ---- user manager ----
        s.MapGet("/users", (string sid, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, log) =>
            await UserAdmin.ListAsync(c, log, ct)));

        s.MapGet("/user", (string sid, string user, string host, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, log) =>
            await UserAdmin.LoadAsync(c, log, user, host, ct)));

        s.MapPost("/users/apply", (string sid, ApplyUserRequest req, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, ses, log) =>
        {
            if (ses.Profile.ReadOnly) throw new ApiException(ReadOnlyMessage);
            return await UserAdmin.ApplyAsync(c, log, req, ct);
        }));

        s.MapPost("/kill", (string sid, KillRequest req, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, ses, log) =>
        {
            if (ses.Profile.ReadOnly) throw new ApiException(ReadOnlyMessage);
            await Db.ExecAsync(c, log, $"KILL {req.Id}", ct);
            return null;
        }));

        s.MapGet("/dump", async (HttpContext ctx, string sid, string db, string? tables, bool? structure, bool? data, bool? drop, bool? createDb, ConnectionManager cm) =>
        {
            var ct = ctx.RequestAborted;
            var ses = cm.Get(sid);
            var fileName = Regex.Replace(db, @"[^\w\-.]+", "_") + ".sql";
            ctx.Response.ContentType = "application/sql; charset=utf-8";
            ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{fileName}\"";
            await using var c = await cm.OpenMetaAsync(ses, ct);
            await using var w = new StreamWriter(ctx.Response.Body, new UTF8Encoding(false), 1 << 16);
            var dumper = new SqlDumper(c, w)
            {
                Structure = structure ?? true,
                Data = data ?? true,
                DropObjects = drop ?? true,
                CreateDatabase = createDb ?? false,
            };
            var only = tables?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            try
            {
                await dumper.RunAsync(db, only, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                await w.WriteAsync($"\n-- ERROR: dump aborted: {ex.Message}\n");
            }
        });
    }
}
