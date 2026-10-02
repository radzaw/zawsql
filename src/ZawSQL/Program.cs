using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.FileProviders;
using ZawSQL;

var opts = AppOptions.Parse(args);
if (opts.ShowHelp)
{
    Console.WriteLine(AppOptions.HelpText);
    return;
}
Directory.CreateDirectory(opts.ConfigDir);

var builder = WebApplication.CreateBuilder(new WebApplicationOptions { ContentRootPath = AppContext.BaseDirectory });
builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(o => o.SingleLine = true);
builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.WebHost.ConfigureKestrel(k =>
{
    // Loopback only: the backend must never be reachable from the network.
    k.Listen(IPAddress.Loopback, opts.Port);
    k.Limits.MaxRequestBodySize = 256L * 1024 * 1024;
});
builder.Services.AddSingleton(opts);
builder.Services.AddSingleton<SessionStore>();
builder.Services.AddSingleton<ConnectionManager>();
builder.Services.AddSingleton<Heartbeat>();

var app = builder.Build();

// Every API call must carry the per-process token, so other local web pages can't drive the backend.
var tokenBytes = Encoding.ASCII.GetBytes(opts.Token);
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Path.StartsWithSegments("/api"))
    {
        var supplied = ctx.Request.Headers["X-Token"].FirstOrDefault() ?? ctx.Request.Query["token"].FirstOrDefault() ?? "";
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(supplied), tokenBytes))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }
    }
    await next();
});

var files = new ManifestEmbeddedFileProvider(typeof(Program).Assembly, "wwwroot");
app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = files,
    OnPrepareResponse = c => c.Context.Response.Headers.CacheControl = "no-cache",
});

Api.Map(app);

await app.StartAsync();

var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
var url = $"{address}/#token={opts.Token}";
Console.WriteLine($"ZawSQL is running at {url}");
Console.WriteLine($"Configuration directory: {opts.ConfigDir}");

if (!opts.NoBrowser)
{
    BrowserLauncher.Launch(url, opts, app.Logger);
    if (!opts.KeepAlive)
        _ = app.Services.GetRequiredService<Heartbeat>().MonitorAsync(app.Lifetime);
}

await app.WaitForShutdownAsync();
await app.Services.GetRequiredService<ConnectionManager>().DisposeAsync();
