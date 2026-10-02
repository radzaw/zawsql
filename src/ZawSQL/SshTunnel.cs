using System.Text;
using Renci.SshNet;
using Renci.SshNet.Common;

namespace ZawSQL;

/// <summary>Thrown when the SSH server's host key is not yet trusted; the UI asks the user to confirm the fingerprint.</summary>
public sealed class SshHostKeyUnknownException(string host, int port, string fingerprint)
    : Exception($"The authenticity of SSH host {host}:{port} can't be established.")
{
    public string Host { get; } = host;
    public int Port { get; } = port;
    public string Fingerprint { get; } = fingerprint;
}

/// <summary>
/// An SSH connection forwarding a local loopback port to the database server (as seen from the SSH host).
/// The host key must match the fingerprint stored in the session; unknown keys are never accepted silently.
/// </summary>
public sealed class SshTunnel : IDisposable
{
    readonly SessionProfile profile;
    readonly string? secret;
    readonly object gate = new();
    SshClient client;
    ForwardedPortLocal forward;

    public uint LocalPort { get; private set; }
    public bool IsConnected => client.IsConnected && forward.IsStarted;

    SshTunnel(SessionProfile profile, string? secret, SshClient client, ForwardedPortLocal forward)
    {
        this.profile = profile;
        this.secret = secret;
        this.client = client;
        this.forward = forward;
        LocalPort = forward.BoundPort;
    }

    public static async Task<SshTunnel> OpenAsync(SessionProfile p, string? secret, SqlLog log, CancellationToken ct)
    {
        log.Add($"/* Opening SSH tunnel via {p.SshUser}@{p.SshHost}:{p.SshPort} to {p.Host}:{p.Port} ... */");
        var client = await ConnectClientAsync(p, secret, ct);
        var forward = StartForward(client, p, 0);
        log.Add($"/* SSH tunnel ready on 127.0.0.1:{forward.BoundPort} */");
        return new SshTunnel(p, secret, client, forward);
    }

    /// <summary>Re-establishes a dropped tunnel on the same local port, so existing connection strings keep working.</summary>
    public void EnsureConnected(SqlLog log)
    {
        lock (gate)
        {
            if (IsConnected) return;
            log.Add("/* SSH tunnel lost, reconnecting ... */");
            Close();
            client = ConnectClientAsync(profile, secret, CancellationToken.None).GetAwaiter().GetResult();
            forward = StartForward(client, profile, LocalPort);
            log.Add($"/* SSH tunnel re-established on 127.0.0.1:{LocalPort} */");
        }
    }

    static ForwardedPortLocal StartForward(SshClient client, SessionProfile p, uint localPort)
    {
        var fwd = new ForwardedPortLocal("127.0.0.1", localPort, p.Host, (uint)p.Port);
        client.AddForwardedPort(fwd);
        fwd.Start();
        return fwd;
    }

    static async Task<SshClient> ConnectClientAsync(SessionProfile p, string? secret, CancellationToken ct)
    {
        var host = string.IsNullOrWhiteSpace(p.SshHost) ? throw new ApiException("SSH host is missing.") : p.SshHost.Trim();
        var user = string.IsNullOrWhiteSpace(p.SshUser) ? throw new ApiException("SSH user is missing.") : p.SshUser.Trim();
        var methods = new List<AuthenticationMethod>();
        if (p.SshAuth == "key")
        {
            methods.Add(new PrivateKeyAuthenticationMethod(user, LoadKey(p.SshKeyFile, secret)));
        }
        else
        {
            methods.Add(new PasswordAuthenticationMethod(user, secret ?? ""));
            // Some servers only offer keyboard-interactive for passwords.
            var kbd = new KeyboardInteractiveAuthenticationMethod(user);
            kbd.AuthenticationPrompt += (_, e) => { foreach (var prompt in e.Prompts) prompt.Response = secret ?? ""; };
            methods.Add(kbd);
        }
        var info = new Renci.SshNet.ConnectionInfo(host, p.SshPort, user, methods.ToArray())
        {
            Timeout = TimeSpan.FromSeconds(Math.Clamp(p.ConnectTimeout, 1, 600)),
        };
        var client = new SshClient(info) { KeepAliveInterval = TimeSpan.FromSeconds(30) };
        string? received = null;
        client.HostKeyReceived += (_, e) =>
        {
            received = "SHA256:" + e.FingerPrintSHA256;
            e.CanTrust = p.SshHostKey != null && string.Equals(p.SshHostKey, received, StringComparison.Ordinal);
        };
        try
        {
            await client.ConnectAsync(ct);
            return client;
        }
        catch (Exception) when (received != null && !string.Equals(p.SshHostKey, received, StringComparison.Ordinal))
        {
            client.Dispose();
            if (p.SshHostKey == null) throw new SshHostKeyUnknownException(p.SshHost!, p.SshPort, received);
            throw new ApiException($"WARNING: the SSH host key of {p.SshHost}:{p.SshPort} has CHANGED.\n\nExpected: {p.SshHostKey}\nReceived: {received}\n\n" +
                "Someone could be intercepting the connection (man-in-the-middle), or the server was reinstalled. " +
                "If you are sure the new key is legitimate, remove the stored host key in the session manager and connect again.");
        }
        catch (SshAuthenticationException ex)
        {
            client.Dispose();
            throw new ApiException($"SSH authentication failed for {p.SshUser}@{p.SshHost}: {ex.Message}");
        }
        catch (Exception ex) when (ex is SshException or System.Net.Sockets.SocketException or TimeoutException)
        {
            client.Dispose();
            throw new ApiException($"SSH connection to {p.SshHost}:{p.SshPort} failed: {ex.Message}");
        }
    }

    /// <summary>Loads a private key from a file path (~ expanded) or from pasted key text.</summary>
    static PrivateKeyFile LoadKey(string? keyFile, string? passphrase)
    {
        if (string.IsNullOrWhiteSpace(keyFile)) throw new ApiException("No SSH private key given.");
        var pass = string.IsNullOrEmpty(passphrase) ? null : passphrase;
        try
        {
            if (keyFile.Contains("-----BEGIN", StringComparison.Ordinal))
            {
                using var ms = new MemoryStream(Encoding.UTF8.GetBytes(keyFile.Trim() + "\n"));
                return new PrivateKeyFile(ms, pass);
            }
            var path = keyFile.Trim();
            if (path.StartsWith('~'))
                path = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) + path[1..];
            if (!File.Exists(path)) throw new ApiException($"SSH private key file not found: {path}");
            return new PrivateKeyFile(path, pass);
        }
        catch (SshPassPhraseNullOrEmptyException)
        {
            throw new ApiException("The SSH private key is encrypted; enter its passphrase.");
        }
        catch (Exception ex) when (ex is SshException or InvalidOperationException or ArgumentException)
        {
            throw new ApiException($"Cannot read the SSH private key: {ex.Message}");
        }
    }

    void Close()
    {
        try { if (forward.IsStarted) forward.Stop(); } catch (Exception) { /* already gone */ }
        try { client.Disconnect(); } catch (Exception) { /* already gone */ }
        client.Dispose();
    }

    public void Dispose()
    {
        lock (gate) Close();
    }
}
