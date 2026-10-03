using ZawSQL;

// Started from a downloaded update to put itself in place of the executable (see Updater.ApplyUpdate).
if (args.Length >= 4 && args[0] == "--apply-update") Environment.Exit(Updater.ApplyUpdate(args));

var opts = AppOptions.Parse(args);
if (opts.ShowHelp)
{
    Console.WriteLine(AppOptions.HelpText);
    return;
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
            await app.StartAsync();
            break;
        }
        catch (IOException) when (attempt < 80)
        {
            await app.DisposeAsync();
            await Task.Delay(250);
            app = AppHost.Build(opts);
        }
    }
}
else
{
    await app.StartAsync();
}

var url = AppHost.LaunchUrl(app, opts);
Console.WriteLine($"ZawSQL is running at {url}");
Console.WriteLine($"Configuration directory: {opts.ConfigDir}");

if (!opts.NoBrowser)
{
    if (!opts.Attach) BrowserLauncher.Launch(url, opts, app.Logger);
    if (!opts.KeepAlive)
        _ = app.Services.GetRequiredService<Heartbeat>().MonitorAsync(app.Lifetime);
}

await app.WaitForShutdownAsync();
