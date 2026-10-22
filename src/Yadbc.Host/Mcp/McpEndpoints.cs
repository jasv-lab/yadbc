namespace Yadbc.Host.Mcp;

public static class McpEndpoints
{
    /// <summary>Settings API for the UI's MCP dialog (on the UI port, behind the UI token).</summary>
    public static void MapMcpSettings(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/mcp");

        api.MapGet("/", (McpState mcp) => Status(mcp));

        api.MapPut("/", (EnableRequest req, McpState mcp) =>
        {
            mcp.SetEnabled(req.Enabled);
            return Status(mcp);
        });

        api.MapPost("/token", (McpState mcp) =>
        {
            mcp.RegenerateToken();
            return Status(mcp);
        });
    }

    public sealed record EnableRequest(bool Enabled);

    static IResult Status(McpState mcp) => Results.Ok(new
    {
        enabled = mcp.Enabled,
        listening = mcp.Listening,
        port = mcp.Port,
        url = mcp.Url,
        token = mcp.Token,
        // Ready to paste into a terminal.
        command = $"claude mcp add --transport http yadbc {mcp.Url} --header \"Authorization: Bearer {mcp.Token}\"",
    });
}
