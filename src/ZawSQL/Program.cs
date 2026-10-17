namespace ZawSQL;

static class Program
{
    // The native window must live on the main thread, and on Windows that thread must be STA (WebView2, file dialogs).
    [STAThread]
    static int Main(string[] args)
    {
        // Started from a downloaded update to put itself in place of the executable (see Updater.ApplyUpdate).
        if (args.Length >= 4 && args[0] == "--apply-update") Environment.Exit(Updater.ApplyUpdate(args));

        var opts = AppOptions.Parse(args);
        if (opts.ShowHelp)
        {
            Console.WriteLine(AppOptions.HelpText);
            return 0;
        }

        Updater.CleanupLeftovers(Updater.ExePath);

        var app = AppHost.Build(opts);
        if (opts.Attach)
        {
            // After a self-update the previous process is still releasing the port: retry for a while.
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    app.StartAsync().GetAwaiter().GetResult();
                    break;
                }
                catch (IOException) when (attempt < 80)
                {
                    app.DisposeAsync().AsTask().GetAwaiter().GetResult();
                    Thread.Sleep(250);
                    app = AppHost.Build(opts);
                }
            }
        }
        else
        {
            app.StartAsync().GetAwaiter().GetResult();
        }

        var url = AppHost.LaunchUrl(app, opts);
        Console.WriteLine($"ZawSQL is running at {url}");
        Console.WriteLine($"Configuration directory: {opts.ConfigDir}");

        // In every mode: windows that stop pinging lose their manual-commit transactions.
        var heartbeat = app.Services.GetRequiredService<Heartbeat>();
        _ = heartbeat.MonitorAsync(app.Lifetime);

        var native = !opts.NoBrowser && !opts.UseBrowser;
        if (native)
        {
            if (app.Services.GetRequiredService<AppWindow>().Run(url, app.Lifetime))
            {
                // The window was closed (or File > Exit, or installing an update, closed it).
                app.StopAsync().GetAwaiter().GetResult();
                return 0;
            }
            opts.FallBackToBrowser(); // an update restarts into the same kind of window
        }

        if (!opts.NoBrowser)
        {
            // After an update a browser window reloads by itself; a native window closed with the previous process.
            if (!opts.Attach || native) BrowserLauncher.Launch(url, opts, app.Logger);
            heartbeat.ExitWhenClosed = !opts.KeepAlive;
        }

        app.WaitForShutdownAsync().GetAwaiter().GetResult();
        return 0;
    }
}
