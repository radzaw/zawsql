using System.Collections.Concurrent;

namespace ZawSQL;

/// <summary>
/// Tracks open UI windows. Each page pings every few seconds and says goodbye when it closes;
/// once no window is left the process exits, so closing the app window closes the app.
/// </summary>
public sealed class Heartbeat
{
    readonly ConcurrentDictionary<string, DateTime> pages = new();
    readonly DateTime started = DateTime.UtcNow;
    /// <summary>A window closed or stopped pinging (its manual-commit tabs must not keep transactions open).</summary>
    public event Action<string>? PageGone;
    volatile bool everConnected;

    // Browsers throttle timers of hidden/minimized windows to about once a minute, hence the generous timeout.
    static readonly TimeSpan PageTimeout = TimeSpan.FromSeconds(150);
    static readonly TimeSpan GracePeriod = TimeSpan.FromSeconds(4);
    static readonly TimeSpan StartupTimeout = TimeSpan.FromMinutes(5);

    public void Ping(string? page)
    {
        if (string.IsNullOrEmpty(page)) return;
        pages[page] = DateTime.UtcNow;
        everConnected = true;
    }

    public void Bye(string? page)
    {
        if (!string.IsNullOrEmpty(page) && pages.TryRemove(page, out _)) PageGone?.Invoke(page);
    }

    public async Task MonitorAsync(IHostApplicationLifetime life)
    {
        DateTime? emptySince = null;
        while (!life.ApplicationStopping.IsCancellationRequested)
        {
            await Task.Delay(1000);
            var now = DateTime.UtcNow;
            foreach (var (id, last) in pages)
                if (now - last > PageTimeout && pages.TryRemove(id, out _)) PageGone?.Invoke(id);

            if (!everConnected)
            {
                if (now - started > StartupTimeout) life.StopApplication();
                continue;
            }
            if (pages.IsEmpty)
            {
                emptySince ??= now;
                if (now - emptySince > GracePeriod)
                {
                    life.StopApplication();
                    return;
                }
            }
            else
            {
                emptySince = null;
            }
        }
    }
}
