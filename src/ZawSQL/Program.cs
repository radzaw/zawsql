using ZawSQL;

var opts = AppOptions.Parse(args);
if (opts.ShowHelp)
{
    Console.WriteLine(AppOptions.HelpText);
    return;
}

var app = AppHost.Build(opts);
await app.StartAsync();

var url = AppHost.LaunchUrl(app, opts);
Console.WriteLine($"ZawSQL is running at {url}");
Console.WriteLine($"Configuration directory: {opts.ConfigDir}");

if (!opts.NoBrowser)
{
    BrowserLauncher.Launch(url, opts, app.Logger);
    if (!opts.KeepAlive)
        _ = app.Services.GetRequiredService<Heartbeat>().MonitorAsync(app.Lifetime);
}

await app.WaitForShutdownAsync();
