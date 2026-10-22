using System.Security.Cryptography;
using System.Text;
using Yadbc.Host.Mcp;

namespace Yadbc.Host.Hosting;

/// <summary>
/// Per-launch secret + expected Host. A localhost server holding DB credentials is reachable by any
/// web page in any browser on this machine (CSRF-style fire-and-forget requests, DNS rebinding);
/// the token and the Host check close that.
/// </summary>
public sealed class LocalSecurity
{
    public string Token { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    public int Port { get; set; }

    public static bool IsLoopbackHost(HostString host, int port) =>
        host.Port == port && (host.Host == "127.0.0.1" || host.Host == "localhost");

    public bool IsValidToken(string? candidate) =>
        candidate is not null &&
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(candidate), Encoding.UTF8.GetBytes(Token));
}

/// <summary>
/// Two listeners, two worlds, told apart by the port a request arrived on:
/// the UI port serves the UI and its API (per-launch token); the MCP port serves only /mcp
/// (persistent bearer token, and only while MCP is switched on). Neither token opens the other.
/// </summary>
public sealed class LocalSecurityMiddleware(RequestDelegate next, LocalSecurity security, McpState mcp)
{
    public const string TokenHeader = "X-Yadbc-Token";

    public async Task InvokeAsync(HttpContext ctx)
    {
        var path = ctx.Request.Path;

        if (mcp.Listening && ctx.Connection.LocalPort == mcp.Port)
        {
            if (!LocalSecurity.IsLoopbackHost(ctx.Request.Host, mcp.Port))
            {
                ctx.Response.StatusCode = StatusCodes.Status421MisdirectedRequest;
                return;
            }
            if (!path.StartsWithSegments("/mcp"))
            {
                ctx.Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }
            if (!mcp.Enabled)
            {
                ctx.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
                await ctx.Response.WriteAsync("yadbc's MCP server is switched off (yadbc: Ctrl+K → MCP server).");
                return;
            }
            if (!mcp.IsValid(ctx.Request.Headers.Authorization))
            {
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                ctx.Response.Headers.WWWAuthenticate = "Bearer";
                return;
            }
            await next(ctx);
            return;
        }

        if (!LocalSecurity.IsLoopbackHost(ctx.Request.Host, security.Port) || path.StartsWithSegments("/mcp"))
        {
            ctx.Response.StatusCode = path.StartsWithSegments("/mcp") ? StatusCodes.Status404NotFound : StatusCodes.Status421MisdirectedRequest;
            return;
        }

        // Static UI files are public (they're in the exe anyway); everything that touches data needs the token.
        // Browsers can't set headers on WebSocket upgrades, so /ws takes it from the query string.
        var needsToken = path.StartsWithSegments("/api") || path.StartsWithSegments("/ws");
        if (needsToken)
        {
            var token = path.StartsWithSegments("/ws")
                ? ctx.Request.Query["token"].ToString()
                : ctx.Request.Headers[TokenHeader].ToString();
            if (!security.IsValidToken(token))
            {
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }
        }

        await next(ctx);
    }
}
