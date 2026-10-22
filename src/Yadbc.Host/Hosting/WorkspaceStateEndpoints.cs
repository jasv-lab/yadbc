using System.Text.Json;

namespace Yadbc.Host.Hosting;

/// <summary>
/// The UI's open tabs (with their unsaved SQL) and layout preferences, in workspace.json next to
/// connections.json. Server-side on purpose: the desktop window gets a random port per launch, so the
/// page's origin — and with it localStorage — changes every start.
/// </summary>
public static class WorkspaceStateEndpoints
{
    const int MaxBytes = 32 * 1024 * 1024;
    static readonly Lock Gate = new();

    static string StateFile => Path.Combine(AppPaths.DataDir, "workspace.json");

    public static void MapWorkspaceStateEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/workspace", () =>
        {
            lock (Gate)
                return Results.Text(File.Exists(StateFile) ? File.ReadAllText(StateFile) : "{}", "application/json");
        });

        app.MapPut("/api/workspace", async (HttpRequest request, CancellationToken ct) =>
        {
            if (request.ContentLength > MaxBytes) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
            using var reader = new StreamReader(request.Body);
            var body = await reader.ReadToEndAsync(ct);
            try
            {
                using var _ = JsonDocument.Parse(body);
            }
            catch (JsonException)
            {
                return Results.BadRequest(new { error = "Not JSON" });
            }
            // Atomic: a crash mid-write must not leave half a file (and lose every tab).
            lock (Gate)
            {
                var tmp = StateFile + ".tmp";
                File.WriteAllText(tmp, body);
                File.Move(tmp, StateFile, overwrite: true);
            }
            return Results.NoContent();
        });
    }
}
