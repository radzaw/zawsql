using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;

namespace ZawSQL;

/// <summary>A session read from another tool: the profile to save, the folder it was in, and what didn't carry over.</summary>
public sealed record ImportedSession(SessionProfile Profile, string? Folder, List<string> Notes, string? Skip = null);

public sealed record SessionImportFile(string Name, string Data);
public sealed record ImportReadRequest(string Source, string? Location, List<SessionImportFile>? Files);
public sealed record ImportSaveItem(int Index, string Name);
public sealed record ImportSaveRequest(string Id, List<ImportSaveItem> Items);

/// <summary>
/// Imports saved sessions from HeidiSQL (registry or exported settings file), DBeaver (data-sources.json, with the
/// passwords from credentials-config.json) and MySQL Workbench (connections.xml). The parsers are pure; reading the
/// tools' usual locations is separate. Parsed sessions stay on the server (passwords included) until the user picks
/// which to save, so passwords never travel to the browser.
/// </summary>
public static class SessionImport
{
    public const string Heidi = "heidisql", DBeaver = "dbeaver", Workbench = "workbench";

    // ================================================================ HeidiSQL

    /// <summary>
    /// HeidiSQL's password obfuscation (apphelpers.pas decrypt): two hex digits per character shifted by a salt digit
    /// at the end; a trailing "0" after the salt marks the Unicode form with four hex digits per character.
    /// </summary>
    public static string HeidiDecrypt(string? s)
    {
        if (string.IsNullOrEmpty(s) || !char.IsDigit(s[^1])) return "";
        var unicode = s[^1] == '0';
        if (unicode) s = s[..^1];
        if (s.Length == 0 || !char.IsDigit(s[^1])) return "";
        var salt = s[^1] - '0';
        var width = unicode ? 4 : 2;
        var sb = new StringBuilder();
        for (var j = 0; j + width <= s.Length - 1; j += width)
        {
            if (!int.TryParse(s.AsSpan(j, width), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var nr)) return "";
            nr -= salt;
            if (nr < 0) nr += unicode ? 65536 : 255;
            sb.Append((char)nr);
        }
        return sb.ToString();
    }

    /// <summary>
    /// HeidiSQL's exported settings (File › Export settings, or portable_settings.txt):
    /// "Servers\Folder\Session\Key&lt;|||&gt;type&lt;|||&gt;value" per line.
    /// </summary>
    public static List<ImportedSession> ParseHeidiSettings(string text)
    {
        var values = new List<(string Path, string Value)>();
        foreach (var raw in text.Replace("\r", "").Split('\n'))
        {
            var parts = raw.Split("<|||>");
            if (parts.Length < 3 || !parts[0].StartsWith(@"Servers\", StringComparison.OrdinalIgnoreCase)) continue;
            // Line breaks inside values are written as <{{{> (CR) and <}}}> (LF).
            values.Add((parts[0], string.Join("<|||>", parts[2..]).Replace("<{{{>", "\r").Replace("<}}}>", "\n").Replace("\r\n", "\n")));
        }
        return ParseHeidiValues(values);
    }

    static readonly HashSet<int> HeidiMySql = [0, 1, 2, 11, 16]; // TCP/IP, named pipe, SSH tunnel, ProxySQL admin, MySQL on RDS (TNetType)

    static readonly Dictionary<int, string> HeidiOther = new()
    {
        [3] = "Microsoft SQL Server", [4] = "Microsoft SQL Server", [5] = "Microsoft SQL Server", [6] = "Microsoft SQL Server", [7] = "Microsoft SQL Server",
        [8] = "PostgreSQL", [9] = "PostgreSQL", [10] = "SQLite", [12] = "Interbase", [13] = "Interbase", [14] = "Firebird", [15] = "Firebird", [17] = "SQLite",
    };

    /// <summary>"Servers\…\Session\Key" → value pairs (from the settings file or the registry) as sessions.</summary>
    public static List<ImportedSession> ParseHeidiValues(IEnumerable<(string Path, string Value)> values)
    {
        var nodes = new Dictionary<string, Dictionary<string, string>>(StringComparer.OrdinalIgnoreCase);
        var order = new List<string>();
        foreach (var (path, value) in values)
        {
            var cut = path.LastIndexOf('\\');
            if (cut <= "Servers".Length) continue;
            var node = path[("Servers".Length + 1)..cut];
            if (!nodes.TryGetValue(node, out var keys))
            {
                nodes[node] = keys = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                order.Add(node);
            }
            keys[path[(cut + 1)..]] = value;
        }
        var result = new List<ImportedSession>();
        foreach (var node in order)
        {
            var k = nodes[node];
            if (!k.ContainsKey("Host") && !k.ContainsKey("Hostname")) continue; // a folder
            string? G(string key) => k.TryGetValue(key, out var v) && v.Length > 0 ? v : null;
            int I(string key, int fallback = 0) => int.TryParse(G(key), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : fallback;
            var segments = node.Split('\\');
            var name = segments[^1];
            var folder = segments.Length > 1 ? string.Join(" / ", segments[..^1]) : null;
            var notes = new List<string>();
            var netType = I("NetType");
            var p = new SessionProfile { Name = name, Host = G("Host") ?? G("Hostname") ?? "127.0.0.1", Port = I("Port", 3306), User = G("User") ?? "" };
            if (!HeidiMySql.Contains(netType))
            {
                result.Add(new ImportedSession(p, folder, notes, $"{HeidiOther.GetValueOrDefault(netType, $"network type {netType}")} session"));
                continue;
            }
            if (netType == 1)
            {
                notes.Add($"Named pipe connections aren't supported; imported as TCP/IP to {p.Host}:{p.Port}.");
                if (p.Host == ".") p.Host = "127.0.0.1";
            }
            var prompt = I("LoginPrompt") == 1;
            var password = HeidiDecrypt(G("Password"));
            p.SavePassword = !prompt && password.Length > 0;
            p.Password = p.SavePassword ? password : null;
            if (prompt) notes.Add("HeidiSQL asks for the password at login; ZawSQL will too.");
            p.Compression = I("Compressed") == 1;
            p.Databases = G("Databases");
            p.Comment = G("Comment");
            if (I("SSL_Active") == 1)
            {
                p.SslMode = "Required";
                if (G("SSL_Key") != null || G("SSL_Cert") != null || G("SSL_CA") != null) notes.Add("SSL certificate files aren't imported.");
            }
            p.Color = HeidiColor(G("TreeBackground"));
            // SSHtunnelActive: 1 on, 0 off, -1 (or missing) = the network type's default (on for SSH tunnel and RDS).
            var sshActive = I("SSHtunnelActive", -1);
            if (sshActive == 1 || (sshActive == -1 && netType is 2 or 16))
            {
                p.SshEnabled = true;
                p.SshHost = G("SSHtunnelHost");
                p.SshPort = I("SSHtunnelHostPort", 22);
                p.SshUser = G("SSHtunnelUser");
                var key = G("SSHtunnelPrivateKey");
                p.SshAuth = key != null ? "key" : "password";
                p.SshKeyFile = key;
                var sshPassword = HeidiDecrypt(G("SSHtunnelPassword"));
                if (sshPassword.Length > 0) p.SshSecret = sshPassword;
                if (key != null && key.EndsWith(".ppk", StringComparison.OrdinalIgnoreCase)) notes.Add("The SSH key is a PuTTY .ppk file; convert it to OpenSSH format (PuTTYgen › Conversions).");
            }
            result.Add(new ImportedSession(p, folder, notes));
        }
        return result;
    }

    /// <summary>A Delphi TColor (0x00BBGGRR; clNone and system colors have high bits set) as #rrggbb.</summary>
    public static string? HeidiColor(string? value)
    {
        if (!long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var c) || c < 0 || c > 0xFFFFFF) return null;
        return $"#{c & 0xFF:x2}{(c >> 8) & 0xFF:x2}{(c >> 16) & 0xFF:x2}";
    }

    /// <summary>HeidiSQL's sessions in the Windows registry (HKCU\Software\HeidiSQL\Servers).</summary>
    static List<(string Path, string Value)>? ReadHeidiRegistry()
    {
        if (!OperatingSystem.IsWindows()) return null;
        using var root = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\HeidiSQL\Servers");
        if (root == null) return null;
        var values = new List<(string, string)>();
        void Walk(Microsoft.Win32.RegistryKey key, string path)
        {
            foreach (var name in key.GetValueNames())
                values.Add(($@"{path}\{name}", Convert.ToString(key.GetValue(name), CultureInfo.InvariantCulture) ?? ""));
            foreach (var sub in key.GetSubKeyNames())
            {
                using var child = key.OpenSubKey(sub);
                if (child != null) Walk(child, $@"{path}\{sub}");
            }
        }
        Walk(root, "Servers");
        return values;
    }

    // ================================================================ DBeaver

    /// <summary>The fixed key DBeaver encrypts credentials-config.json with (AES-128-CBC, IV in front).</summary>
    static readonly byte[] DbeaverKey = Convert.FromHexString("babb4a9f774ab853c96c2d653dfe544a");

    public static JsonElement? DbeaverCredentials(byte[]? data)
    {
        if (data == null || data.Length < 32) return null;
        try
        {
            using var aes = Aes.Create();
            aes.Key = DbeaverKey;
            var plain = aes.DecryptCbc(data.AsSpan(16), data.AsSpan(0, 16));
            using var doc = JsonDocument.Parse(plain);
            return doc.RootElement.Clone();
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException)
        {
            return null;
        }
    }

    static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v)
            ? v.ValueKind switch { JsonValueKind.String => v.GetString() is { Length: > 0 } s ? s : null, JsonValueKind.Number => v.GetRawText(), JsonValueKind.True => "true", JsonValueKind.False => "false", _ => null }
            : null;

    static JsonElement Obj(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Object ? v : default;

    /// <summary>DBeaver provider ids of other databases, for the "skipped" reason.</summary>
    static readonly Dictionary<string, string> DbeaverProducts = new(StringComparer.OrdinalIgnoreCase)
    {
        ["postgresql"] = "PostgreSQL", ["oracle"] = "Oracle", ["sqlserver"] = "SQL Server", ["mssql"] = "SQL Server", ["sqlite"] = "SQLite",
        ["db2"] = "Db2", ["clickhouse"] = "ClickHouse", ["mongodb"] = "MongoDB", ["redis"] = "Redis", ["snowflake"] = "Snowflake", ["generic"] = "JDBC",
    };

    /// <summary>DBeaver's data-sources.json, with the decrypted credentials-config.json when available.</summary>
    public static List<ImportedSession> ParseDbeaver(string dataSources, JsonElement? credentials)
    {
        using var doc = JsonDocument.Parse(dataSources);
        var result = new List<ImportedSession>();
        foreach (var conn in Obj(doc.RootElement, "connections").ValueKind == JsonValueKind.Object ? Obj(doc.RootElement, "connections").EnumerateObject() : default)
        {
            var c = conn.Value;
            var cfg = Obj(c, "configuration");
            var provider = Str(c, "provider") ?? "";
            var driver = Str(c, "driver") ?? "";
            var notes = new List<string>();
            // Connection settings live in "configuration"; some files (and the documentation) have them on the connection itself.
            string? Cfg(string name) => Str(cfg, name) ?? Str(c, name);
            var p = new SessionProfile { Name = Str(c, "name") ?? conn.Name, Host = Cfg("host") ?? "", User = "" };
            if (int.TryParse(Cfg("port"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var port)) p.Port = port;
            var folder = Str(c, "folder")?.Replace("/", " / ");
            var mysql = provider.Equals("mysql", StringComparison.OrdinalIgnoreCase) || provider.Contains("maria", StringComparison.OrdinalIgnoreCase)
                || driver.Contains("mysql", StringComparison.OrdinalIgnoreCase) || driver.Contains("maria", StringComparison.OrdinalIgnoreCase);
            if (!mysql)
            {
                result.Add(new ImportedSession(p, folder, notes, $"{DbeaverProducts.GetValueOrDefault(provider, provider.Length > 0 ? provider : "unknown")} connection"));
                continue;
            }
            if (p.Host.Length == 0 && Cfg("url") is { } url && System.Text.RegularExpressions.Regex.Match(url, @"^jdbc:(?:mysql|mariadb)://([^:/?]+)(?::(\d+))?") is { Success: true } m)
            {
                p.Host = m.Groups[1].Value;
                if (m.Groups[2].Success) p.Port = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
            }
            if (p.Host.Length == 0) p.Host = "127.0.0.1";
            // Credentials: in credentials-config.json since DBeaver 6.1.3, in the configuration before.
            var creds = credentials is { } cr ? Obj(Obj(cr, conn.Name), "#connection") : default;
            p.User = Str(creds, "user") ?? Cfg("user") ?? "";
            var password = Str(creds, "password") ?? Cfg("password");
            p.SavePassword = Str(c, "save-password") == "true" && password != null;
            p.Password = p.SavePassword ? password : null;
            if (password == null && Str(c, "save-password") == "true")
                notes.Add(credentials == null ? "The password is in credentials-config.json, which wasn't read." : "No saved password found.");
            p.Production = Cfg("type") == "prod";
            p.ReadOnly = Str(c, "read-only") == "true";
            if (Cfg("database") is { } db) p.Comment = $"Default database in DBeaver: {db}";

            var handlers = Obj(cfg, "handlers").ValueKind == JsonValueKind.Object ? Obj(cfg, "handlers") : Obj(c, "handlers");
            var ssh = Obj(handlers, "ssh_tunnel");
            if (Str(ssh, "enabled") == "true")
            {
                var props = Obj(ssh, "properties");
                var sshCreds = credentials is { } cr2 ? Obj(Obj(cr2, conn.Name), "network/ssh_tunnel") : default;
                p.SshEnabled = true;
                p.SshHost = Str(props, "host");
                if (int.TryParse(Str(props, "port"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var sp)) p.SshPort = sp;
                p.SshUser = Str(sshCreds, "user") ?? Str(ssh, "user") ?? Str(props, "user");
                var auth = Str(props, "authType") ?? "PASSWORD";
                p.SshAuth = auth == "PUBLIC_KEY" ? "key" : "password";
                p.SshKeyFile = Str(props, "keyPath");
                p.SshSecret = Str(sshCreds, "password") ?? Str(ssh, "password");
                if (auth == "AGENT") notes.Add("DBeaver uses an SSH agent for this tunnel; choose a key file or password.");
            }
            if (Str(Obj(handlers, "mysql_ssl"), "enabled") == "true")
            {
                p.SslMode = Str(Obj(Obj(handlers, "mysql_ssl"), "properties"), "ssl.verify.server") == "true" ? "VerifyCA" : "Required";
                notes.Add("SSL certificate files aren't imported.");
            }
            result.Add(new ImportedSession(p, folder, notes));
        }
        return result;
    }

    // ================================================================ MySQL Workbench

    /// <summary>MySQL Workbench's connections.xml (GRT format). Workbench keeps passwords in the system keychain.</summary>
    public static List<ImportedSession> ParseWorkbench(string xml)
    {
        var doc = XDocument.Parse(xml);
        var result = new List<ImportedSession>();
        foreach (var conn in doc.Descendants("value").Where(v => (string?)v.Attribute("struct-name") == "db.mgmt.Connection"))
        {
            string? Child(XElement e, string key) => e.Elements().FirstOrDefault(x => (string?)x.Attribute("key") == key)?.Value is { Length: > 0 } s ? s : null;
            var pars = conn.Elements("value").FirstOrDefault(x => (string?)x.Attribute("key") == "parameterValues");
            string? P(string key) => pars == null ? null : Child(pars, key);
            int PI(string key, int fallback) => int.TryParse(P(key), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : fallback;
            var driver = conn.Elements("link").FirstOrDefault(x => (string?)x.Attribute("key") == "driver")?.Value ?? "";
            var notes = new List<string> { "MySQL Workbench keeps passwords in the system keychain; ZawSQL asks for it when connecting." };
            var p = new SessionProfile
            {
                Name = Child(conn, "name") ?? "Workbench connection",
                Host = P("hostName") ?? "127.0.0.1",
                Port = PI("port", 3306),
                User = P("userName") ?? "",
                SavePassword = false,
            };
            if (!driver.StartsWith("com.mysql.rdbms.mysql.driver.native", StringComparison.Ordinal))
            {
                result.Add(new ImportedSession(p, null, [], $"unsupported connection method ({driver})"));
                continue;
            }
            if (driver.EndsWith("_socket", StringComparison.Ordinal))
            {
                var socket = P("socket");
                if (socket != null && socket.StartsWith('/')) p.Host = socket;
                else notes.Add("Named pipe connections aren't supported; imported as TCP/IP.");
            }
            p.SslMode = PI("useSSL", 1) switch { 0 => "None", 2 => "Required", 3 => "VerifyCA", 4 => "VerifyFull", _ => "Preferred" };
            if (driver.EndsWith("_sshtun", StringComparison.Ordinal))
            {
                p.SshEnabled = true;
                var host = P("sshHost") ?? "";
                var colon = host.LastIndexOf(':');
                if (colon > 0 && int.TryParse(host[(colon + 1)..], NumberStyles.Integer, CultureInfo.InvariantCulture, out var sp)) { p.SshPort = sp; host = host[..colon]; }
                p.SshHost = host;
                p.SshUser = P("sshUserName");
                p.SshKeyFile = P("sshKeyFile");
                p.SshAuth = p.SshKeyFile != null ? "key" : "password";
            }
            if (P("schema") is { } schema) p.Comment = $"Default schema in Workbench: {schema}";
            result.Add(new ImportedSession(p, null, notes));
        }
        return result;
    }

    // ================================================================ locations on this computer

    public sealed record Location(string Source, string Path, int Count);

    static string Home => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    static string AppData => Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);

    /// <summary>Folders (".dbeaver") of every DBeaver project in the usual workspaces.</summary>
    static IEnumerable<string> DbeaverFolders()
    {
        var workspaces = OperatingSystem.IsWindows() ? [Path.Combine(AppData, "DBeaverData", "workspace6")]
            : OperatingSystem.IsMacOS() ? [Path.Combine(Home, "Library", "DBeaverData", "workspace6")]
            : new[]
            {
                Path.Combine(Home, ".local", "share", "DBeaverData", "workspace6"),
                Path.Combine(Home, ".var", "app", "io.dbeaver.DBeaverCommunity", "data", "DBeaverData", "workspace6"), // Flatpak
                Path.Combine(Home, "snap", "dbeaver-ce", "current", ".local", "share", "DBeaverData", "workspace6"), // Snap
            };
        foreach (var ws in workspaces.Where(Directory.Exists))
            foreach (var project in Directory.EnumerateDirectories(ws))
                if (Directory.Exists(Path.Combine(project, ".dbeaver"))) yield return Path.Combine(project, ".dbeaver");
    }

    static string WorkbenchFile => OperatingSystem.IsWindows() ? Path.Combine(AppData, "MySQL", "Workbench", "connections.xml")
        : OperatingSystem.IsMacOS() ? Path.Combine(Home, "Library", "Application Support", "MySQL", "Workbench", "connections.xml")
        : Path.Combine(Home, ".mysql", "workbench", "connections.xml");

    const string Registry = @"HKEY_CURRENT_USER\Software\HeidiSQL";

    /// <summary>Reads a location found on this computer.</summary>
    static List<ImportedSession> ReadLocation(string source, string path)
    {
        switch (source)
        {
            case Heidi when path == Registry:
                return ParseHeidiValues(ReadHeidiRegistry() ?? []);
            case DBeaver:
                var creds = File.Exists(Path.Combine(path, "credentials-config.json")) ? DbeaverCredentials(File.ReadAllBytes(Path.Combine(path, "credentials-config.json"))) : null;
                return Directory.EnumerateFiles(path, "data-sources*.json").Order().SelectMany(f => ParseDbeaver(File.ReadAllText(f), creds)).ToList();
            case Workbench:
                return ParseWorkbench(File.ReadAllText(path));
            default:
                throw new ApiException("Unknown import location.");
        }
    }

    /// <summary>Where HeidiSQL, DBeaver and MySQL Workbench keep their sessions on this computer, with how many there are.</summary>
    public static List<Location> Detect()
    {
        var found = new List<Location>();
        void Try(string source, string path)
        {
            try
            {
                var n = ReadLocation(source, path).Count(s => s.Skip == null);
                found.Add(new Location(source, path, n));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or System.Xml.XmlException) { /* unreadable: not offered */ }
        }
        if (ReadHeidiRegistry() is { Count: > 0 }) Try(Heidi, Registry);
        foreach (var folder in DbeaverFolders()) Try(DBeaver, folder);
        if (File.Exists(WorkbenchFile)) Try(Workbench, WorkbenchFile);
        return found;
    }

    /// <summary>Uploaded files: HeidiSQL's settings export, DBeaver's data-sources.json (+ credentials-config.json), or connections.xml.</summary>
    public static List<ImportedSession> ReadFiles(string source, List<SessionImportFile> files)
    {
        byte[] Bytes(SessionImportFile f)
        {
            try { return Convert.FromBase64String(f.Data); }
            catch (FormatException) { throw new ApiException($"{f.Name} could not be read."); }
        }
        string Text(SessionImportFile f) => Encoding.UTF8.GetString(Bytes(f)).TrimStart('﻿');
        try
        {
            switch (source)
            {
                case Heidi:
                    return files.SelectMany(f => ParseHeidiSettings(Text(f))).ToList();
                case DBeaver:
                    var credFile = files.FirstOrDefault(f => f.Name.Contains("credentials", StringComparison.OrdinalIgnoreCase));
                    JsonElement? creds = credFile == null ? null : DbeaverCredentials(Bytes(credFile)) ?? throw new ApiException($"{credFile.Name} could not be decrypted.");
                    return files.Where(f => f != credFile).SelectMany(f => ParseDbeaver(Text(f), creds)).ToList();
                case Workbench:
                    return files.SelectMany(f => ParseWorkbench(Text(f))).ToList();
                default:
                    throw new ApiException($"Unknown source: {source}");
            }
        }
        catch (JsonException ex) { throw new ApiException($"The file isn't DBeaver's data-sources.json: {ex.Message}"); }
        catch (System.Xml.XmlException ex) { throw new ApiException($"The file isn't MySQL Workbench's connections.xml: {ex.Message}"); }
    }

    // ================================================================ read → pick → save

    static readonly ConcurrentDictionary<string, (DateTime At, List<ImportedSession> Sessions)> Pending = new();

    /// <summary>Reads sessions (from a detected location or uploaded files) and keeps them for <see cref="Save"/>; returns them without secrets.</summary>
    public static object Read(ImportReadRequest r, SessionStore store)
    {
        List<ImportedSession> sessions;
        if (r.Location != null)
        {
            // Only the locations this computer actually has; no arbitrary paths.
            var loc = Detect().FirstOrDefault(l => l.Source == r.Source && l.Path == r.Location) ?? throw new ApiException("That location is no longer available.");
            sessions = ReadLocation(loc.Source, loc.Path);
        }
        else if (r.Files is { Count: > 0 }) sessions = ReadFiles(r.Source, r.Files);
        else throw new ApiException("Nothing to read.");

        foreach (var key in Pending.Where(p => p.Value.At < DateTime.UtcNow.AddMinutes(-30)).Select(p => p.Key)) Pending.TryRemove(key, out _);
        var id = Guid.NewGuid().ToString("n");
        Pending[id] = (DateTime.UtcNow, sessions);
        var existing = store.List();
        return new
        {
            id,
            sessions = sessions.Select((s, i) => new
            {
                index = i,
                name = ImportName(s),
                host = s.Profile.Host,
                port = s.Profile.Port,
                user = s.Profile.User,
                ssh = s.Profile.SshEnabled ? $"{s.Profile.SshUser}@{s.Profile.SshHost}{(s.Profile.SshPort != 22 ? ":" + s.Profile.SshPort : "")}" : null,
                hasPassword = s.Profile.Password != null,
                hasSshSecret = s.Profile.SshSecret != null,
                production = s.Profile.Production,
                readOnly = s.Profile.ReadOnly,
                color = s.Profile.Color,
                sslMode = s.Profile.SslMode,
                notes = s.Notes,
                skip = s.Skip,
                exists = existing.FirstOrDefault(e => SameServer(e, s.Profile))?.Name,
            }).ToList(),
        };
    }

    public static string ImportName(ImportedSession s) => s.Folder != null ? $"{s.Folder} / {s.Profile.Name}" : s.Profile.Name;

    static bool SameServer(SessionProfile a, SessionProfile b) =>
        string.Equals(a.Host, b.Host, StringComparison.OrdinalIgnoreCase) && a.Port == b.Port && a.User == b.User
        && a.SshEnabled == b.SshEnabled && (!a.SshEnabled || string.Equals(a.SshHost, b.SshHost, StringComparison.OrdinalIgnoreCase));

    /// <summary>Saves the picked sessions (with their passwords, encrypted like any saved session). Names are made unique.</summary>
    public static object Save(ImportSaveRequest r, SessionStore store)
    {
        if (!Pending.TryRemove(r.Id, out var pending)) throw new ApiException("The import expired; read the sessions again.");
        var names = new HashSet<string>(store.List().Select(s => s.Name), StringComparer.OrdinalIgnoreCase);
        var saved = new List<SessionProfile>();
        foreach (var item in r.Items)
        {
            if (item.Index < 0 || item.Index >= pending.Sessions.Count || pending.Sessions[item.Index].Skip != null) continue;
            var p = pending.Sessions[item.Index].Profile.Clone();
            var name = string.IsNullOrWhiteSpace(item.Name) ? ImportName(pending.Sessions[item.Index]) : item.Name.Trim();
            var unique = name;
            for (var n = 2; names.Contains(unique); n++) unique = $"{name} ({n})";
            names.Add(unique);
            p.Id = null;
            p.Name = unique;
            // Like ticking "Production server" in the session manager: red unless the tool had a color.
            if (p.Production && p.Color == null) p.Color = "#d13438";
            saved.Add(store.Save(p));
        }
        return new { saved };
    }
}
