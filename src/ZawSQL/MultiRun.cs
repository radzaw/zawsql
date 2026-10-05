using System.Collections.Concurrent;
using System.Diagnostics;
using MySqlConnector;

namespace ZawSQL;

public sealed record MultiRunRequest(string RunId, List<string> Sessions, string[] Statements, string? Database, int MaxRows = 1000, bool StopOnError = true);
public sealed record MultiCancelRequest(string RunId);

/// <summary>
/// Runs the same statements on several saved sessions: a connected session is used as it is (its password may have
/// been typed rather than saved), any other is connected for the run with its saved settings (SSH tunnel included)
/// and disconnected afterwards. Up to four servers run at once. Read-only sessions refuse changes like in a query tab.
/// </summary>
public static class MultiRun
{
    const int Parallel = 4;
    static readonly ConcurrentDictionary<string, CancellationTokenSource> Running = new();

    public static bool Cancel(string runId)
    {
        if (!Running.TryGetValue(runId, out var cts)) return false;
        cts.Cancel();
        return true;
    }

    public static async Task<object> RunAsync(MultiRunRequest r, SessionStore store, ConnectionManager cm, SqlLog log, CancellationToken requestCt)
    {
        if (r.Sessions.Count == 0) throw new ApiException("Choose at least one server.");
        if (r.Statements.Length == 0) throw new ApiException("Nothing to run.");
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(requestCt);
        Running[r.RunId] = cts;
        try
        {
            using var gate = new SemaphoreSlim(Parallel);
            var tasks = r.Sessions.Distinct().Select(id => RunOneAsync(id, r, store, cm, gate, cts.Token)).ToList();
            var results = await Task.WhenAll(tasks);
            // Each server's statements in the SQL log, one server after the other, under a header.
            foreach (var res in results)
            {
                log.Add($"/* On \"{res.Name}\": {(res.Error != null ? "failed – " + res.Error.Replace("*/", "* /") : $"{res.Executed} of {r.Statements.Length} statements in {res.Ms:0} ms")} */");
                foreach (var (line, time, ms) in res.Log) log.Add(line, time, ms);
            }
            return new { servers = results.Select(x => x.ToJson()).ToList(), cancelled = cts.IsCancellationRequested };
        }
        finally
        {
            Running.TryRemove(r.RunId, out _);
        }
    }

    sealed class ServerResult
    {
        public required string Session { get; init; }
        public string Name { get; set; } = "";
        public string? Error { get; set; }
        public bool Production { get; set; }
        public bool ReadOnly { get; set; }
        public int Executed { get; set; }
        public long Affected { get; set; }
        public double Ms { get; set; }
        public List<object> Sets { get; } = [];
        public List<object> Errors { get; } = [];
        public List<(string Line, long Time, double? Ms)> Log { get; } = [];
        public object ToJson() => new { session = Session, name = Name, ok = Error == null && Errors.Count == 0, error = Error, production = Production, readOnly = ReadOnly, executed = Executed, affected = Affected, ms = Ms, resultSets = Sets, errors = Errors };
    }

    static async Task<ServerResult> RunOneAsync(string profileId, MultiRunRequest r, SessionStore store, ConnectionManager cm, SemaphoreSlim gate, CancellationToken ct)
    {
        var res = new ServerResult { Session = profileId };
        var log = new SqlLog();
        DbSession? temp = null;
        MySqlConnection? own = null;
        var entered = false;
        var sw = new Stopwatch();
        var profile = store.Get(profileId);
        if (profile != null)
        {
            res.Name = profile.Name;
            res.Production = profile.Production;
            res.ReadOnly = profile.ReadOnly;
        }
        try
        {
            if (profile == null) throw new ApiException("The saved session no longer exists.");
            await gate.WaitAsync(ct);
            entered = true;
            sw.Start();
            MySqlConnection c;
            var existing = cm.FindByProfile(profileId);
            if (existing != null)
            {
                // Its own connection, so a query running in a tab of that session isn't disturbed.
                existing.Tunnel?.EnsureConnected(log);
                own = c = await ConnectionManager.OpenMainAsync(existing, log, ct);
            }
            else
            {
                var password = store.GetPassword(profileId);
                if (password == null && !profile.SavePassword)
                    throw new ApiException("Its password isn't saved; connect it from the session manager first.");
                temp = await cm.ConnectAsync(profile, password ?? "", store.GetSshSecret(profileId), log, ct);
                c = temp.Main!;
            }
            if (!string.IsNullOrEmpty(r.Database))
            {
                log.Add("USE " + Db.Q(r.Database));
                await c.ChangeDatabaseAsync(r.Database, ct);
            }
            for (var i = 0; i < r.Statements.Length; i++)
            {
                var sql = r.Statements[i];
                if (profile.ReadOnly && ReadOnlyGuard.Check(sql) is { } rejected)
                {
                    log.Add($"/* Blocked: {rejected}\n{sql.Replace("*/", "* /")} */");
                    res.Errors.Add(new { statement = i, message = rejected, code = 0 });
                    if (r.StopOnError) break;
                    continue;
                }
                var line = log.Add(sql);
                await using var cmd = c.CreateCommand();
                cmd.CommandText = sql;
                cmd.CommandTimeout = 0;
                try
                {
                    await using (var reader = await cmd.ExecuteReaderAsync(ct))
                    {
                        do
                        {
                            if (reader.FieldCount > 0)
                            {
                                var rs = await Values.ReadAsync(reader, Math.Max(0, r.MaxRows), ct);
                                res.Sets.Add(new { statement = i, sql, columns = rs.Columns, rows = rs.Rows, truncated = rs.Truncated });
                            }
                        } while (await reader.NextResultAsync(ct));
                        if (reader.RecordsAffected > 0) res.Affected += reader.RecordsAffected;
                    }
                    log.Finish(line);
                    res.Executed++;
                }
                catch (MySqlException ex) when (!ct.IsCancellationRequested)
                {
                    log.Finish(line);
                    log.Add($"/* SQL Error ({ex.Number}): {ex.Message} */");
                    res.Errors.Add(new { statement = i, message = ex.Message, code = ex.Number });
                    if (r.StopOnError) break;
                }
            }
        }
        catch (Exception ex) when (ex is OperationCanceledException || (ct.IsCancellationRequested && ex is MySqlException))
        {
            res.Error = "Stopped.";
        }
        catch (SshHostKeyUnknownException)
        {
            res.Error = "The SSH host key isn't trusted yet; connect it once from the session manager to confirm it.";
        }
        catch (Exception ex) when (ex is MySqlException or ApiException or IOException or InvalidOperationException or TimeoutException or Renci.SshNet.Common.SshException)
        {
            res.Error = ex.Message;
        }
        finally
        {
            res.Ms = sw.Elapsed.TotalMilliseconds;
            if (own != null) await own.DisposeAsync();
            if (temp != null) await cm.DisconnectAsync(temp.Id);
            if (entered) gate.Release();
            lock (log.Items) res.Log.AddRange(log.Items.Select((l, i) => (l, log.Times[i], log.Ms[i])));
        }
        return res;
    }
}
