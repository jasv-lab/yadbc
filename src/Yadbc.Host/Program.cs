using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Velopack;
using Yadbc.Host.Activity;
using Yadbc.Host.Advisor;
using Yadbc.Host.Ai;
using Yadbc.Host.Navigation;
using Yadbc.Host.Catalog;
using Yadbc.Host.Connections;
using Yadbc.Host.Editing;
using Yadbc.Host.Export;
using Yadbc.Host.History;
using Yadbc.Host.Hosting;
using Yadbc.Host.Mcp;
using Yadbc.Host.Query;
using Yadbc.Host.SchemaChanges;
using Yadbc.Host.Sharing;
using Yadbc.Host.Snippets;

namespace Yadbc.Host;

public static class Program
{
    // Photino (WebView2 on Windows) needs the UI thread to be STA, which top-level statements can't declare.
    [STAThread]
    public static void Main(string[] args)
    {
        // The installer's hooks (shortcuts on install, cleanup on uninstall) run the app with special
        // arguments and exit here; a normal start passes straight through. Nothing to do when not installed.
        VelopackApp.Build().Run();

        // YADBC_HEADLESS=1: no window, serve on a fixed port and print the URL (for browser-based debugging).
        // YADBC_DEV_URL=http://localhost:4200: the window loads `ng serve`, which proxies /api and /ws to us.
        var headless = Environment.GetEnvironmentVariable("YADBC_HEADLESS") == "1";
        var devUrl = Environment.GetEnvironmentVariable("YADBC_DEV_URL")?.TrimEnd('/');
        var fixedPort = int.TryParse(Environment.GetEnvironmentVariable("YADBC_PORT"), out var p) ? p
            : headless || devUrl is not null ? 5179
            : 0;

        // The MCP endpoint gets its own fixed port; if another yadbc instance holds it, this one runs without MCP.
        var mcpPort = McpState.ConfiguredPort();
        var mcpListening = McpState.PortIsFree(mcpPort);

        // The UI (wwwroot) resolves against the content root, which defaults to the working directory: a
        // published / installed yadbc started from anywhere else (a taskbar pin, a terminal) would serve a
        // blank page. Next to the exe when it's there; `dotnet run` keeps the project folder.
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            Args = args,
            ContentRootPath = Directory.Exists(Path.Combine(AppContext.BaseDirectory, "wwwroot")) ? AppContext.BaseDirectory : null,
        });
        // Loopback only, never 0.0.0.0: this process holds DB credentials.
        builder.WebHost.UseKestrel(o =>
        {
            o.Listen(IPAddress.Loopback, fixedPort);
            if (mcpListening) o.Listen(IPAddress.Loopback, mcpPort);
        });
        builder.Services.ConfigureHttpJsonOptions(o =>
            o.SerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase)));
        builder.Services.AddSingleton<LocalSecurity>();
        builder.Services.AddSingleton<ConnectionStore>();
        builder.Services.AddSingleton<SecretStore>();
        builder.Services.AddSingleton<TunnelManager>();
        builder.Services.AddSingleton<Broker>();
        builder.Services.AddSingleton<SharedLogins>();
        builder.Services.AddSingleton<TeamAiSettings>();
        builder.Services.AddSingleton<SharedSnippets>();
        builder.Services.AddSingleton<DataSourceCache>();
        builder.Services.AddSingleton<QuerySocketHandler>();
        builder.Services.AddSingleton<ResultStore>();
        builder.Services.AddSingleton<HistoryStore>();
        builder.Services.AddSingleton<TableSources>();
        builder.Services.AddSingleton<Yadbc.Host.Navigation.RelationReader>();
        builder.Services.AddSingleton<Yadbc.Host.Ai.AiSettings>();
        // LLM answers can take minutes (thinking models); the stream is cancelled when the UI stops it.
        builder.Services.AddHttpClient("llm", c => c.Timeout = TimeSpan.FromMinutes(10));
        builder.Services.AddSingleton<McpState>();
        builder.Services.AddSingleton<Updates>();
        builder.Services.AddHostedService(sp => sp.GetRequiredService<Updates>());
        // Stateless: every MCP request stands alone — nothing to keep per client between tool calls.
        builder.Services.AddMcpServer().WithHttpTransport(o => o.Stateless = true).WithTools<YadbcTools>();

        var app = builder.Build();

        app.UseMiddleware<LocalSecurityMiddleware>();
        app.UseWebSockets();
        app.UseDefaultFiles();
        app.UseStaticFiles();

        app.MapGet("/api/ping", () => Results.Ok(new { ok = true }));
        app.MapConnectionEndpoints();
        app.MapExportEndpoints();
        app.MapEditEndpoints();
        app.MapCatalogEndpoints();
        app.MapHistoryEndpoints();
        app.MapActivityEndpoints();
        app.MapAdvisorEndpoints();
        app.MapNavigationEndpoints();
        app.MapWorkspaceStateEndpoints();
        app.MapResultEndpoints();
        app.MapAiEndpoints();
        app.MapSnippetEndpoints();
        app.MapSharingEndpoints();
        app.MapSchemaChangeEndpoints();
        app.MapMcpSettings();
        app.MapUpdateEndpoints();
        app.MapMcp("/mcp");
        app.Map("/ws", (HttpContext ctx, QuerySocketHandler handler) => handler.Handle(ctx));
        app.MapFallbackToFile("index.html");

        app.Start();

        var port = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses
            .Select(a => new Uri(a).Port).First(p => !mcpListening || p != mcpPort);
        var security = app.Services.GetRequiredService<LocalSecurity>();
        security.Port = port;
        app.Services.GetRequiredService<McpState>().Listening = mcpListening;

        // The token travels in the URL fragment: never sent to the server, never logged, read once by the UI.
        var url = $"{devUrl ?? $"http://127.0.0.1:{port}"}/#token={security.Token}";
        var updates = app.Services.GetRequiredService<Updates>();

        if (headless)
        {
            Console.WriteLine($"yadbc listening — open {url}");
            app.WaitForShutdown();
            // Disposing the services kills tunnel processes (ssh / kubectl) instead of orphaning them.
            app.DisposeAsync().AsTask().GetAwaiter().GetResult();
            updates.ApplyOnExit();
            return;
        }

        DesktopWindow.Run(url);
        app.StopAsync().GetAwaiter().GetResult();
        app.DisposeAsync().AsTask().GetAwaiter().GetResult();
        // Last: a downloaded update is applied once this process has exited (and restarts it if asked).
        updates.ApplyOnExit();
    }
}
