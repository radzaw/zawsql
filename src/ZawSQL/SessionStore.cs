using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ZawSQL;

/// <summary>A saved connection profile, as shown in the session manager.</summary>
public sealed class SessionProfile
{
    public string? Id { get; set; }
    public string Name { get; set; } = "Unnamed";
    public string Host { get; set; } = "127.0.0.1";
    public int Port { get; set; } = 3306;
    public string User { get; set; } = "root";
    /// <summary>Plain password, only ever sent from the UI to the backend; never written to disk.</summary>
    public string? Password { get; set; }
    public bool SavePassword { get; set; } = true;
    /// <summary>Optional semicolon separated list of databases to show.</summary>
    public string? Databases { get; set; }
    public string SslMode { get; set; } = "Preferred";
    public int ConnectTimeout { get; set; } = 15;
    public bool Compression { get; set; }
    /// <summary>Read-only mode: the backend refuses anything that could change data or schema.</summary>
    public bool ReadOnly { get; set; }
    /// <summary>Session color as #rrggbb, shown in the tree, tab bar and status bar.</summary>
    public string? Color { get; set; }
    /// <summary>Production server: highlighted everywhere and every change must be confirmed.</summary>
    public bool Production { get; set; }

    // ---- SSH tunnel: when enabled, Host/Port are the database as seen from the SSH server ----
    public bool SshEnabled { get; set; }
    public string? SshHost { get; set; }
    public int SshPort { get; set; } = 22;
    public string? SshUser { get; set; }
    /// <summary>"password" or "key".</summary>
    public string SshAuth { get; set; } = "password";
    /// <summary>Private key file path (~ allowed) or pasted key text.</summary>
    public string? SshKeyFile { get; set; }
    /// <summary>SSH password or key passphrase, only in transit from the UI; stored encrypted in SshSecretEnc.</summary>
    public string? SshSecret { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? SshSecretEnc { get; set; }
    public bool HasSshSecret { get; set; }
    /// <summary>Trusted host key fingerprint ("SHA256:…"), set after the user confirmed it.</summary>
    public string? SshHostKey { get; set; }
    public string? Comment { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? PasswordEnc { get; set; }

    public bool HasPassword { get; set; }

    public SessionProfile Clone() => (SessionProfile)MemberwiseClone();
}

/// <summary>Persists session profiles and UI state in the configuration directory.</summary>
public sealed class SessionStore
{
    readonly string sessionsFile, keyFile, stateFile, libraryFile;
    readonly object gate = new();
    readonly List<SessionProfile> sessions;
    readonly byte[] key;
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public SessionStore(AppOptions o)
    {
        sessionsFile = Path.Combine(o.ConfigDir, "sessions.json");
        keyFile = Path.Combine(o.ConfigDir, "secret.key");
        stateFile = Path.Combine(o.ConfigDir, "state.json");
        libraryFile = Path.Combine(o.ConfigDir, "library.json");
        key = LoadOrCreateKey();
        sessions = Load();
    }

    public List<SessionProfile> List()
    {
        lock (gate) return sessions.Select(Sanitize).ToList();
    }

    public SessionProfile? Get(string id)
    {
        lock (gate) return sessions.FirstOrDefault(s => s.Id == id)?.Clone();
    }

    public string? GetPassword(string id)
    {
        lock (gate)
        {
            var enc = sessions.FirstOrDefault(s => s.Id == id)?.PasswordEnc;
            return enc == null ? null : Unprotect(enc);
        }
    }

    public SessionProfile Save(SessionProfile p)
    {
        lock (gate)
        {
            if (string.IsNullOrEmpty(p.Id)) p.Id = Guid.NewGuid().ToString("n");
            var idx = sessions.FindIndex(s => s.Id == p.Id);
            var existing = idx >= 0 ? sessions[idx] : null;
            var stored = p.Clone();
            // Only plain #rrggbb colors are stored; the UI puts them into inline styles.
            if (stored.Color != null && !System.Text.RegularExpressions.Regex.IsMatch(stored.Color, "^#[0-9a-fA-F]{6}$")) stored.Color = null;
            stored.PasswordEnc = !p.SavePassword ? null
                : p.Password != null ? Protect(p.Password)
                : existing?.PasswordEnc;
            stored.Password = null;
            stored.HasPassword = false;
            stored.SshSecretEnc = !p.SavePassword ? null
                : !string.IsNullOrEmpty(p.SshSecret) ? Protect(p.SshSecret)
                : p.SshSecret == "" ? null
                : existing?.SshSecretEnc;
            stored.SshSecret = null;
            stored.HasSshSecret = false;
            // The trusted host key only changes through SetSshHostKey (trust / forget), never by omission.
            stored.SshHostKey = p.SshHostKey ?? existing?.SshHostKey;
            if (idx >= 0) sessions[idx] = stored; else sessions.Add(stored);
            sessions.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
            Persist();
            return Sanitize(stored);
        }
    }

    public string? GetSshSecret(string id)
    {
        lock (gate)
        {
            var enc = sessions.FirstOrDefault(s => s.Id == id)?.SshSecretEnc;
            return enc == null ? null : Unprotect(enc);
        }
    }

    /// <summary>Stores the SSH host key fingerprint the user confirmed (null forgets it).</summary>
    public void SetSshHostKey(string id, string? fingerprint)
    {
        lock (gate)
        {
            var s = sessions.FirstOrDefault(x => x.Id == id) ?? throw new ApiException("Session not found.");
            s.SshHostKey = fingerprint;
            Persist();
        }
    }

    public void Delete(string id)
    {
        lock (gate)
        {
            sessions.RemoveAll(s => s.Id == id);
            Persist();
        }
    }

    public JsonElement LoadState()
    {
        lock (gate)
        {
            try
            {
                if (File.Exists(stateFile))
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(stateFile));
                    return doc.RootElement.Clone();
                }
            }
            catch (Exception) { /* corrupt state file: start fresh */ }
            using var empty = JsonDocument.Parse("{}");
            return empty.RootElement.Clone();
        }
    }

    public void SaveState(string json)
    {
        lock (gate) WriteAtomic(stateFile, json);
    }

    /// <summary>The saved queries and snippets library, or null when none was saved yet (the UI then seeds default snippets).</summary>
    public JsonElement? LoadLibrary()
    {
        lock (gate)
        {
            foreach (var file in new[] { libraryFile, libraryFile + ".bak" })
            {
                try
                {
                    if (!File.Exists(file)) continue;
                    using var doc = JsonDocument.Parse(File.ReadAllText(file));
                    if (IsLibrary(doc.RootElement)) return doc.RootElement.Clone();
                }
                catch (Exception) { /* corrupt: fall back to the backup */ }
            }
            return null;
        }
    }

    /// <summary>Replaces the library; the previous version is kept as library.json.bak.</summary>
    public void SaveLibrary(JsonElement library)
    {
        if (!IsLibrary(library)) throw new ArgumentException("A library needs \"queries\" and \"snippets\" arrays.");
        lock (gate)
        {
            if (File.Exists(libraryFile)) File.Copy(libraryFile, libraryFile + ".bak", true);
            WriteAtomic(libraryFile, JsonSerializer.Serialize(library, Json));
        }
    }

    static bool IsLibrary(JsonElement e) =>
        e.ValueKind == JsonValueKind.Object
        && e.TryGetProperty("queries", out var q) && q.ValueKind == JsonValueKind.Array
        && e.TryGetProperty("snippets", out var s) && s.ValueKind == JsonValueKind.Array;
    static SessionProfile Sanitize(SessionProfile s)
    {
        var c = s.Clone();
        c.HasPassword = s.PasswordEnc != null;
        c.PasswordEnc = null;
        c.Password = null;
        c.HasSshSecret = s.SshSecretEnc != null;
        c.SshSecretEnc = null;
        c.SshSecret = null;
        return c;
    }

    List<SessionProfile> Load()
    {
        try
        {
            if (File.Exists(sessionsFile))
                return JsonSerializer.Deserialize<List<SessionProfile>>(File.ReadAllText(sessionsFile), Json) ?? [];
        }
        catch (Exception) { /* unreadable file: start with an empty list */ }
        return [];
    }

    void Persist() => WriteAtomic(sessionsFile, JsonSerializer.Serialize(sessions, Json));

    static void WriteAtomic(string path, string content)
    {
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, content, new UTF8Encoding(false));
        File.Move(tmp, path, overwrite: true);
        RestrictToUser(path);
    }

    static void RestrictToUser(string path)
    {
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }

    // Saved passwords are encrypted with a random per-user key kept next to the sessions file.
    // This keeps them out of plain sight; it is not a substitute for OS-level account security.
    byte[] LoadOrCreateKey()
    {
        if (File.Exists(keyFile))
        {
            var k = File.ReadAllBytes(keyFile);
            if (k.Length == 32) return k;
        }
        var nk = RandomNumberGenerator.GetBytes(32);
        File.WriteAllBytes(keyFile, nk);
        RestrictToUser(keyFile);
        return nk;
    }

    string Protect(string plain)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var pt = Encoding.UTF8.GetBytes(plain);
        var ct = new byte[pt.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(key, 16);
        aes.Encrypt(nonce, pt, ct, tag);
        return Convert.ToBase64String([.. nonce, .. tag, .. ct]);
    }

    string? Unprotect(string enc)
    {
        try
        {
            var all = Convert.FromBase64String(enc);
            var pt = new byte[all.Length - 28];
            using var aes = new AesGcm(key, 16);
            aes.Decrypt(all.AsSpan(0, 12), all.AsSpan(28), all.AsSpan(12, 16), pt);
            return Encoding.UTF8.GetString(pt);
        }
        catch (Exception)
        {
            return null;
        }
    }
}
