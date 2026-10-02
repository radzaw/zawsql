using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.FileProviders;

namespace ZawSQL;

/// <summary>Builds the ZawSQL web host. Shared by the executable and the test suite.</summary>
public static class AppHost
{
    public static WebApplication Build(AppOptions opts)
    {
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

        var files = new ManifestEmbeddedFileProvider(typeof(AppHost).Assembly, "wwwroot");
        app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
        app.UseStaticFiles(new StaticFileOptions
        {
            FileProvider = files,
            OnPrepareResponse = c => c.Context.Response.Headers.CacheControl = "no-cache",
        });

        Api.Map(app);
        app.Lifetime.ApplicationStopped.Register(() => app.Services.GetRequiredService<ConnectionManager>().DisposeAsync().AsTask().Wait());
        return app;
    }

    /// <summary>Base address (http://127.0.0.1:port) of a started host.</summary>
    public static string Address(WebApplication app) =>
        app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();

    /// <summary>The URL that opens the UI: token, plus the saved theme so the page paints in the right colors at once.</summary>
    public static string LaunchUrl(WebApplication app, AppOptions opts)
    {
        var url = $"{Address(app)}/#token={opts.Token}";
        var state = app.Services.GetRequiredService<SessionStore>().LoadState();
        if (state.ValueKind == JsonValueKind.Object && state.TryGetProperty("prefs", out var prefs) && prefs.ValueKind == JsonValueKind.Object
            && prefs.TryGetProperty("theme", out var theme) && theme.GetString() is "light" or "dark" or "system")
            url += $"&theme={theme.GetString()}";
        return url;
    }
}
