using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MySqlConnector;

namespace ZawSQL;

public sealed record ConnectRequest(string? SessionId, SessionProfile? Profile, string? Password, string? SshSecret = null);
public sealed record HostKeyRequest(string? Fingerprint);
/// <summary>Tab: set when the query tab is in manual-commit mode; the statements then run on its own connection.</summary>
public sealed record ExecRequest(string[] Statements, string? Database, int MaxRows = 10000, bool StopOnError = true, string? Tab = null, bool Stats = false);
public sealed record RowsRequest(string Db, string Table, List<RowOp> Ops, string? Tab = null);
public sealed record TxStartRequest(string? Database, string? Page = null);
public sealed record KillRequest(long Id);

public static class Api
{
    /// <summary>Error code for an SSH host key the user hasn't trusted yet; data carries the fingerprint.</summary>
    public const int SshHostKeyUnknown = 9001;
    public const int LibraryConflict = 9002;

    const string ReadOnlyMessage = "This session is in read-only mode; changes are not allowed.";

    /// <summary>LogTimes: when each Log line was logged (Unix ms), shown as timestamps in the SQL log.
    /// LogMs: how long each statement took (ms), null for comments; the SQL log marks slow ones.</summary>
    sealed record Response(bool Ok, object? Data, string? Error, int? Code, List<string> Log, List<long>? LogTimes = null, List<double?>? LogMs = null);

    static async Task<IResult> Run(Func<SqlLog, Task<object?>> body)
    {
        var log = new SqlLog();
        try
        {
            return Results.Json(new Response(true, await body(log), null, null, log.Items, log.Times, log.Ms));
        }
        catch (MySqlException ex)
        {
            log.Add($"/* SQL Error ({ex.Number}): {ex.Message} */");
            return Results.Json(new Response(false, null, ex.Message, ex.Number, log.Items, log.Times, log.Ms));
        }
        catch (SshHostKeyUnknownException ex)
        {
            log.Add($"/* {ex.Message} Fingerprint: {ex.Fingerprint} */");
            return Results.Json(new Response(false, new { host = ex.Host, port = ex.Port, fingerprint = ex.Fingerprint }, ex.Message, SshHostKeyUnknown, log.Items, log.Times, log.Ms));
        }
        catch (LibraryConflictException ex)
        {
            return Results.Json(new Response(false, null, ex.Message, LibraryConflict, log.Items, log.Times, log.Ms));
        }
        catch (OperationCanceledException)
        {
            return Results.Json(new Response(false, null, "The operation was cancelled.", null, log.Items, log.Times, log.Ms));
        }
        catch (Exception ex)
        {
            return Results.Json(new Response(false, null, ex.Message, null, log.Items, log.Times, log.Ms));
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

    /// <summary>
    /// The manual-commit connection of a query tab, when the request names one. A tab that expects one but has none
    /// (the session reconnected) is an error, never a silent fallback to auto-commit.
    /// </summary>
    static TabConnection? TabFor(DbSession s, string? tab) =>
        tab == null ? null
        : s.Tabs.TryGetValue(tab, out var t) ? t
        : throw new ApiException("This tab's manual-commit connection is gone, so any open transaction was rolled back. Switch manual commit on again.");

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

        // ---- run the same statements on several saved sessions ----
        api.MapPost("/multi/run", (MultiRunRequest req, SessionStore st, ConnectionManager cm, CancellationToken ct) => Run(async log =>
            await MultiRun.RunAsync(req, st, cm, log, ct)));
        api.MapPost("/multi/cancel", (MultiCancelRequest req) => RunSync(() => new { cancelled = MultiRun.Cancel(req.RunId) }));

        api.MapGet("/library", (SessionStore st) => RunSync(() => st.LoadLibrary()));
        api.MapPut("/library", async (HttpRequest req, SessionStore st) =>
        {
            using var doc = await JsonDocument.ParseAsync(req.Body);
            return await RunSync(() => new { revision = st.SaveLibrary(doc.RootElement) });
        });

        // ---- the native window's file dialogs (macOS and Linux web views have none for the page) ----
        api.MapPost("/native/open", (NativeOpenRequest req, AppWindow win) => Run(async _ => await win.OpenDialogAsync(req.Accept, req.Multiple)));
        api.MapGet("/native/file/{id}", (string id, AppWindow win) =>
            win.TakePicked(id) is { } path ? Results.File(path, "application/octet-stream") : Results.NotFound());
        api.MapPost("/native/save", (NativeSaveRequest req, AppWindow win) => Run(async _ =>
        {
            var path = await win.SaveDialogAsync(req.Description ?? "Files", req.Ext ?? "");
            if (path == null) return null;
            await File.WriteAllTextAsync(path, req.Text ?? "", new UTF8Encoding(false));
            return new { name = Path.GetFileName(path) };
        }));

        // ---- self-update ----
        api.MapGet("/version", (Updater u) => RunSync(() => u.Version()));
        api.MapPost("/update/check", (Updater u, CancellationToken ct) => Run(async _ => await u.CheckAsync(ct)));
        api.MapGet("/update/notes", (string? since, Updater u, CancellationToken ct) => Run(async _ => await u.NotesAsync(since, ct)));
        api.MapPost("/update/download", (Updater u) => RunSync(() => u.StartDownload()));
        api.MapGet("/update/status", (Updater u) => RunSync(() => u.Status()));
        api.MapPost("/update/install", (Updater u, IHostApplicationLifetime life, HttpContext ctx) => RunSync(() =>
            new { version = u.InstallAndRestart(life, ctx.Connection.LocalPort), restarting = true }));

        // ---- import files (not tied to a session) ----
        api.MapPost("/import/upload", async (HttpContext ctx, string name, ImportStore store, CancellationToken ct) =>
        {
            if (ctx.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
                limit.MaxRequestBodySize = 8L * 1024 * 1024 * 1024;
            return await Run(async _ =>
            {
                var f = await store.SaveAsync(ctx.Request.Body, name, ct);
                return new { id = f.Id, name = f.Name, kind = f.Kind, size = f.Size, encodings = Importer.Encodings };
            });
        });
        api.MapPost("/import/preview", (ImportPreviewRequest r, ImportStore store) => RunSync(() => Importer.Preview(store.GetFile(r.FileId), r)));
        api.MapDelete("/import/{id}", (string id, ImportStore store) => RunSync(() => { store.DeleteFile(id); return null; }));

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
        api.MapGet("/sessions/import/sources", () => RunSync(() => SessionImport.Detect()));
        api.MapPost("/sessions/import/read", (ImportReadRequest r, SessionStore st) => RunSync(() => SessionImport.Read(r, st)));
        api.MapPost("/sessions/import/save", (ImportSaveRequest r, SessionStore st) => RunSync(() => SessionImport.Save(r, st)));

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

        api.MapGet("/claude/status", (string? path, CancellationToken ct) => Run(async _ => await ClaudeCli.StatusAsync(path, ct)));

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

        // Data tab: the table's foreign keys and those pointing at it, to follow from a row to related rows. Not logged.
        s.MapGet("/relations", (string sid, string db, string table, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, _) => new
        {
            outgoing = await TableMeta.LoadForeignKeysAsync(c, null, db, table, ct),
            incoming = await TableMeta.LoadReferencingKeysAsync(c, null, db, table, ct),
        }));

        s.MapGet("/columns", (string sid, string db, string table, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, _) =>
            (await Db.RowsAsync(c, null, $"SHOW COLUMNS FROM {Db.Q(db, table)}", ct)).Select(r => new { name = r["Field"], type = r["Type"] }).ToList()));

        // Parameter hints in the SQL editor: each stored procedure and function with its parameters (and return type).
        s.MapGet("/routines", (string sid, string db, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, _) =>
        {
            var rows = await Db.RowsAsync(c, null, """
                SELECT r.ROUTINE_NAME AS name, LOWER(r.ROUTINE_TYPE) AS type, r.ROUTINE_COMMENT AS comment,
                       p.ORDINAL_POSITION AS pos, p.PARAMETER_MODE AS mode, p.PARAMETER_NAME AS param, p.DTD_IDENTIFIER AS dtype
                FROM information_schema.ROUTINES r
                LEFT JOIN information_schema.PARAMETERS p
                  ON p.SPECIFIC_SCHEMA = r.ROUTINE_SCHEMA AND p.SPECIFIC_NAME = r.ROUTINE_NAME AND p.ROUTINE_TYPE = r.ROUTINE_TYPE
                WHERE r.ROUTINE_SCHEMA = @p0
                ORDER BY r.ROUTINE_NAME, r.ROUTINE_TYPE, p.ORDINAL_POSITION
                """, ct, db);
            // Position 0 is a function's return value; a routine without parameters comes with one row of NULLs.
            return rows.GroupBy(r => (r["name"], r["type"])).Select(g => new
            {
                name = g.Key.Item1,
                type = g.Key.Item2,
                comment = g.First()["comment"],
                returns = g.FirstOrDefault(r => r["pos"] == "0")?["dtype"],
                @params = g.Where(r => r["pos"] is { } p && p != "0")
                    .Select(r => new { mode = r["mode"], name = r["param"], type = r["dtype"] }).ToList(),
            }).ToList();
        }));

        s.MapGet("/create", (string sid, string db, string type, string name, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, log) =>
            new { code = await TableMeta.ShowCreateAsync(c, log, db, type, name, ct) }));

        s.MapGet("/data", (string sid, string db, string table, int? offset, int? limit, string? order, string? dir, string? where,
            ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, ses, log) =>
        {
            var m = await TableMeta.LoadAsync(c, null, db, table, ct);
            var sql = new StringBuilder($"SELECT * FROM {Db.Q(db, table)}");
            if (!string.IsNullOrWhiteSpace(where)) sql.Append(" WHERE (").Append(where).Append("\n)");
            if (!string.IsNullOrEmpty(order) && m.Columns.Any(x => x.Name == order))
                sql.Append(" ORDER BY ").Append(Db.Q(order)).Append(dir == "desc" ? " DESC" : " ASC");
            if (limit is > 0) sql.Append($" LIMIT {Math.Max(0, offset ?? 0)}, {limit}");
            // The filter is SQL text and metadata connections aren't READ ONLY on the server: "1); DELETE ..." must not get through.
            if (ses.Profile.ReadOnly && !string.IsNullOrWhiteSpace(where) && ReadOnlyGuard.Check(sql.ToString()) is { } rejected)
                throw new ApiException(rejected);
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
            // Edits in the result grid of a manual-commit tab become part of its transaction (and can't wait for its own locks).
            var tab = TabFor(ses, req.Tab);
            await using var lease = tab != null ? await tab.AcquireAsync(ct) : await ses.AcquireAsync(ct);
            var c = tab != null ? await TabTransactions.EnsureAsync(ses, tab, log, ct) : await cm.EnsureMainAsync(ses, log, ct);
            var results = new List<object>();
            foreach (var op in req.Ops)
            {
                results.Add(await RowWriter.ApplyAsync(c, log, m, req.Db, req.Table, op, ct));
                tab?.Changed();
            }
            return results;
        }));

        s.MapPost("/exec", (string sid, ExecRequest req, ConnectionManager cm, CancellationToken ct) => Run(async log =>
        {
            var ses = cm.Get(sid);
            var tab = TabFor(ses, req.Tab);
            await using var lease = tab != null ? await tab.AcquireAsync(ct) : await ses.AcquireAsync(ct);
            var c = tab != null ? await TabTransactions.EnsureAsync(ses, tab, log, ct) : await cm.EnsureMainAsync(ses, log, ct);
            var notes = new List<string>();
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
            // Statement statistics: two reads up front measure what reading the counters costs.
            List<object>? stats = req.Stats ? [] : null;
            Dictionary<string, long>? prev = null, overhead = null;
            if (stats != null)
            {
                try
                {
                    var b0 = await QueryStats.ReadAsync(c, ct);
                    prev = await QueryStats.ReadAsync(c, ct);
                    overhead = QueryStats.Delta(b0, prev, null);
                }
                catch (MySqlException) { stats = null; }
            }
            var statsMs = 0.0; // time spent reading counters, not counted as the statements' duration
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
                var line = i < 200 ? log.Add(sql) : -1;
                if (i == 200) log.Add($"/* ... {req.Statements.Length - 200} more statements not logged */");
                await using var cmd = c.CreateCommand();
                cmd.CommandText = sql;
                cmd.CommandTimeout = 0;
                if (tab != null) tab.Running = cmd; else ses.Running = cmd;
                try
                {
                    await using (var r = await cmd.ExecuteReaderAsync(ct))
                    {
                        do
                        {
                            if (r.FieldCount > 0)
                            {
                                var rs = await Values.ReadAsync(r, Math.Max(0, req.MaxRows), ct);
                                sets.Add(new { statement = i, sql, columns = rs.Columns, rows = rs.Rows, truncated = rs.Truncated, ms = sw.Elapsed.TotalMilliseconds - statsMs });
                            }
                        } while (await r.NextResultAsync(ct));
                        if (r.RecordsAffected > 0) affected += r.RecordsAffected;
                    }
                    log.Finish(line);
                    if (cmd.LastInsertedId > 0) insertId = cmd.LastInsertedId;
                    executed++;
                    if (tab != null)
                    {
                        var effect = TabTransactions.Classify(sql);
                        if (effect == TxEffect.Autocommit)
                        {
                            // SET autocommit = 1 would commit and leave manual mode behind the UI's back.
                            if (tab.Changes > 0) notes.Add($"Changing autocommit committed the open transaction ({tab.Changes} change{(tab.Changes == 1 ? "" : "s")}).");
                            tab.Reset();
                            await Db.ExecAsync(c, log, "SET autocommit = 0", ct);
                            notes.Add("This tab keeps autocommit off; switch to Auto-commit with the toolbar button instead.");
                        }
                        else if (TabTransactions.Apply(tab, sql, effect) is { } note) notes.Add(note);
                    }
                }
                catch (MySqlException ex) when (!ct.IsCancellationRequested)
                {
                    log.Add($"/* SQL Error ({ex.Number}): {ex.Message} */");
                    if (errors.Count < 100) errors.Add(new { statement = i, message = ex.Message, code = ex.Number });
                    if (tab != null && ex.Number == 1213 && tab.Changes > 0)
                    {
                        notes.Add($"The server rolled back the whole transaction ({tab.Changes} change{(tab.Changes == 1 ? "" : "s")}) to resolve a deadlock.");
                        tab.Reset();
                    }
                    else if (tab != null && ex.Number == 1205 && tab.Changes > 0)
                        notes.Add("Only the statement that waited was undone; the transaction is still open.");
                    if (req.StopOnError) break;
                }
                finally
                {
                    log.Finish(line);
                    if (tab != null) tab.Running = null; else ses.Running = null;
                }
                if (stats != null && prev != null && i < QueryStats.MaxStatements)
                {
                    var t0 = sw.Elapsed.TotalMilliseconds;
                    try
                    {
                        var now = await QueryStats.ReadAsync(c, ct);
                        stats.Add(new { statement = i, counters = QueryStats.Delta(prev, now, overhead) });
                        prev = now;
                    }
                    catch (Exception) when (!ct.IsCancellationRequested) { stats = null; }
                    statsMs += sw.Elapsed.TotalMilliseconds - t0;
                }
            }
            var ms = sw.Elapsed.TotalMilliseconds - statsMs;
            var currentDb = await Db.ScalarAsync(c, null, "SELECT DATABASE()", ct);
            return new { resultSets = sets, statements = req.Statements.Length, executed, affected, insertId, errors, database = currentDb, ms, transaction = tab?.State(), notes, stats };
        }));

        // Visual EXPLAIN on the session's own connection, so temporary tables and variables are visible.
        s.MapPost("/explain", (string sid, ExplainRequest req, ConnectionManager cm, CancellationToken ct) => Run(async log =>
        {
            var ses = cm.Get(sid);
            var tab = TabFor(ses, req.Tab);
            await using var lease = tab != null ? await tab.AcquireAsync(ct) : await ses.AcquireAsync(ct);
            var c = tab != null ? await TabTransactions.EnsureAsync(ses, tab, log, ct) : await cm.EnsureMainAsync(ses, log, ct);
            if (!string.IsNullOrEmpty(req.Database) && c.Database != req.Database)
            {
                log.Add("USE " + Db.Q(req.Database));
                await c.ChangeDatabaseAsync(req.Database, ct);
            }
            return await Explainer.ExplainAsync(c, log, req.Sql, req.Analyze, ct);
        }));

        // Claude Code writes SQL from a description; the schema is read on a metadata connection (not logged).
        s.MapPost("/claude/sql", (string sid, ClaudeSqlRequest req, ConnectionManager cm, CancellationToken ct) => Run(async log =>
        {
            if (string.IsNullOrWhiteSpace(req.Prompt)) throw new ApiException("Describe the query you want first.");
            var ses = cm.Get(sid);
            string? schema = null;
            var tables = 0;
            string version;
            // The connection goes back to the pool before Claude starts thinking, which can take a minute.
            await using (var c = await cm.OpenMetaAsync(ses, ct))
            {
                version = c.ServerVersion;
                if (req.Schema && !string.IsNullOrEmpty(req.Database)) (schema, tables) = await ClaudeCli.SchemaAsync(c, req.Database, ct);
            }
            var prompt = ClaudeCli.BuildPrompt(req.Prompt, version, req.Database, schema, req.Sql, ses.Profile.ReadOnly);
            log.Add($"/* Asking Claude Code for SQL{(schema != null ? $" with the schema of {req.Database} ({tables} table{(tables == 1 ? "" : "s")})" : "")}{(string.IsNullOrWhiteSpace(req.Sql) ? "" : " and the editor's SQL")} */");
            return await ClaudeCli.AskAsync(req, prompt, ct);
        }));

        s.MapPost("/cancel", (string sid, string? tab, ConnectionManager cm) => RunSync(() =>
        {
            var ses = cm.Get(sid);
            if (tab != null && ses.Tabs.TryGetValue(tab, out var t)) t.Running?.Cancel();
            else ses.Running?.Cancel();
            return null;
        }));

        // ---- manual-commit query tabs: their own connection with autocommit off ----
        s.MapGet("/tx/{tab}", (string sid, string tab, ConnectionManager cm) => RunSync(() =>
            cm.Get(sid).Tabs.TryGetValue(tab, out var t) ? t.State() : new { manual = false }));
        s.MapPost("/tx/{tab}/start", (string sid, string tab, TxStartRequest req, ConnectionManager cm, CancellationToken ct) => Run(async log =>
            (await TabTransactions.StartAsync(cm.Get(sid), tab, req.Database, req.Page, log, ct)).State()));
        s.MapPost("/tx/{tab}/commit", (string sid, string tab, ConnectionManager cm, CancellationToken ct) => Run(async log =>
            await TabTransactions.FinishAsync(cm.Get(sid), tab, commit: true, log, ct)));
        s.MapPost("/tx/{tab}/rollback", (string sid, string tab, ConnectionManager cm, CancellationToken ct) => Run(async log =>
            await TabTransactions.FinishAsync(cm.Get(sid), tab, commit: false, log, ct)));
        s.MapPost("/tx/{tab}/close", (string sid, string tab, string? then, ConnectionManager cm, CancellationToken ct) => Run(async log =>
            await TabTransactions.CloseAsync(cm.Get(sid), tab, then, log, ct)));

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
                case "variables": return await ServerSettings.VariablesAsync(c, log, ct);
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

        // ---- slow query and lock insight (polled; not logged) ----
        s.MapGet("/insight/queries", (string sid, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, _) =>
            await Insight.TopQueriesAsync(c, ct)));
        s.MapGet("/insight/slowlog", (string sid, int? limit, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, _) =>
            await Insight.SlowLogAsync(c, limit ?? 500, ct)));
        s.MapGet("/insight/locks", (string sid, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, _) =>
            await Insight.LocksAsync(c, ct)));
        s.MapPost("/insight/reset", (string sid, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, ses, log) =>
        {
            if (ses.Profile.ReadOnly) throw new ApiException(ReadOnlyMessage);
            await Insight.ResetDigestsAsync(c, log, ct);
            return null;
        }));

        // ---- replication (status polled, not logged; start/stop/skip logged) ----
        s.MapGet("/replication", (string sid, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, _) =>
            await Replication.StatusAsync(c, ct)));
        s.MapPost("/replication/{action}", (string sid, string action, ReplicationActionRequest req, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, ses, log) =>
        {
            if (ses.Profile.ReadOnly) throw new ApiException(ReadOnlyMessage);
            if (action == "skip") return await Replication.SkipAsync(c, log, req.Channel, req.Transaction, ct);
            await Replication.ControlAsync(c, log, action, req.Channel, ct);
            return null;
        }));

        // ---- binary log / relay log viewer (browsed, not logged) ----
        s.MapGet("/binlog/files", (string sid, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, _) =>
            await Binlog.FilesAsync(c, ct)));
        s.MapGet("/binlog/events", (string sid, string? log, string? file, long? from, int? limit, string? channel, ConnectionManager cm, CancellationToken ct) =>
            Meta(cm, sid, ct, async (c, _, _) => await Binlog.EventsAsync(c, log, file, from, limit, channel, ct)));

        // ---- server health report (facts only; the checks run in the UI; read-only, not logged) ----
        s.MapGet("/health", (string sid, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, _) =>
            await HealthReport.CollectAsync(c, ct)));

        // ---- Host tab › Fragmentation (read-only, not logged; fresh bypasses MySQL 8's statistics cache) ----
        s.MapGet("/fragmentation", (string sid, bool? fresh, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, _) =>
            await Fragmentation.CollectAsync(c, fresh == true, ct)));

        // ---- table maintenance ----
        s.MapPost("/maintenance", (string sid, MaintenanceRequest req, ConnectionManager cm, CancellationToken ct) => Run(async log =>
        {
            var ses = cm.Get(sid);
            var sql = Maintenance.BuildSql(req);
            if (ses.Profile.ReadOnly && !Maintenance.IsReadOnly(req.Op))
                throw new ApiException("Only CHECK and CHECKSUM are available in read-only mode.");
            await using var c = await cm.OpenMetaAsync(ses, ct);
            await using var cmd = Db.Cmd(c, log, sql, [], out var line);
            cmd.CommandTimeout = 0; // OPTIMIZE / REPAIR can take a long time on big tables
            try
            {
                await using var r = await cmd.ExecuteReaderAsync(ct);
                return await Values.ReadAsync(r, int.MaxValue, ct);
            }
            finally { log.Finish(line); }
        }));

        // ---- CSV / Excel import ----
        s.MapPost("/import/start", (string sid, ImportStartRequest req, ImportStore store, ConnectionManager cm, CancellationToken ct) => Run(async log =>
            await Importer.StartAsync(store, cm, cm.Get(sid), req, log, ct)));

        s.MapPost("/import/step", (string sid, ImportStepRequest req, ImportStore store, CancellationToken ct) => Run(async log =>
        {
            var job = store.GetJob(sid, req.JobId);
            try
            {
                var r = await job.StepAsync(req.Rows, log, ct);
                if (r.Done) await store.RemoveJobAsync(job.Id);
                return r;
            }
            catch
            {
                await store.RemoveJobAsync(job.Id); // rolls back an open transaction
                throw;
            }
        }));

        s.MapPost("/import/cancel", (string sid, ImportJobRequest req, ImportStore store) => Run(async log =>
        {
            store.GetJob(sid, req.JobId);
            await store.RemoveJobAsync(req.JobId);
            log.Add("/* Import cancelled */");
            return null;
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

        // ---- Host tab › Events and Variables ----
        s.MapGet("/events", (string sid, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, log) =>
            await ServerSettings.EventsAsync(c, log, ct)));
        s.MapPost("/events/scheduler", (string sid, SchedulerRequest req, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, ses, log) =>
        {
            if (ses.Profile.ReadOnly) throw new ApiException(ReadOnlyMessage);
            await ServerSettings.SetSchedulerAsync(c, log, req.On, ct);
            return null;
        }));
        s.MapPost("/events/action", (string sid, EventActionRequest req, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, ses, log) =>
        {
            if (ses.Profile.ReadOnly) throw new ApiException(ReadOnlyMessage);
            await ServerSettings.EventActionAsync(c, log, req, ct);
            return null;
        }));
        s.MapPost("/variables/set", (string sid, SetVariableRequest req, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, ses, log) =>
        {
            if (ses.Profile.ReadOnly) throw new ApiException(ReadOnlyMessage);
            await ServerSettings.SetVariableAsync(c, log, req, ct);
            return null;
        }));

        // ---- Host tab › Error log and InnoDB ----
        s.MapGet("/errorlog", (string sid, int? limit, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, _) =>
            await ServerLogs.ErrorLogAsync(c, limit ?? 2000, ct)));
        s.MapGet("/innodb", (string sid, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, _, _) =>
            await ServerLogs.InnodbStatusAsync(c, ct)));

        s.MapPost("/kill", (string sid, KillRequest req, ConnectionManager cm, CancellationToken ct) => Meta(cm, sid, ct, async (c, ses, log) =>
        {
            if (ses.Profile.ReadOnly) throw new ApiException(ReadOnlyMessage);
            await Db.ExecAsync(c, log, $"KILL {req.Id}", ct);
            return null;
        }));

        // toFile: the native window (macOS, Linux) asks where to save and the dump is written there, not downloaded.
        s.MapGet("/dump", async (HttpContext ctx, string sid, string db, string? tables, bool? structure, bool? data, bool? drop, bool? createDb, bool? toFile,
            ConnectionManager cm, AppWindow win) =>
        {
            var ct = ctx.RequestAborted;
            var ses = cm.Get(sid);
            // A JSON array: object names may contain commas and edge spaces.
            string[]? only;
            try { only = tables == null ? null : JsonSerializer.Deserialize<string[]>(tables); }
            catch (JsonException) { throw new ApiException("Invalid object list."); }
            async Task Dump(MySqlConnection c, TextWriter w)
            {
                var dumper = new SqlDumper(c, w)
                {
                    Structure = structure ?? true,
                    Data = data ?? true,
                    DropObjects = drop ?? true,
                    CreateDatabase = createDb ?? false,
                };
                try
                {
                    await dumper.RunAsync(db, only, ct);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    await w.WriteAsync($"\n-- ERROR: dump aborted: {SqlDumper.Line(ex.Message)}\n");
                    throw;
                }
            }

            if (toFile == true)
            {
                return await Run(async _ =>
                {
                    var path = await win.SaveDialogAsync("SQL files", ".sql");
                    if (path == null) return null;
                    await using var c = await cm.OpenMetaAsync(ses, ct);
                    await using (var w = new StreamWriter(path, false, new UTF8Encoding(false), 1 << 16)) await Dump(c, w);
                    return new { name = Path.GetFileName(path) };
                });
            }

            var fileName = Regex.Replace(db, @"[^\w\-.]+", "_") + ".sql";
            ctx.Response.ContentType = "application/sql; charset=utf-8";
            ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{fileName}\"";
            await using var conn = await cm.OpenMetaAsync(ses, ct);
            await using (var w = new StreamWriter(ctx.Response.Body, new UTF8Encoding(false), 1 << 16))
            {
                // The download has started: an error can only be written into the file.
                try { await Dump(conn, w); }
                catch (Exception ex) when (ex is not OperationCanceledException) { }
            }
            return Results.Empty;
        });
    }
}
