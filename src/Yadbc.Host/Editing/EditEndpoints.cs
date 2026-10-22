using Npgsql;
using Yadbc.Host.Export;
using Yadbc.Host.Query;

namespace Yadbc.Host.Editing;

public static class EditEndpoints
{
    public static void MapEditEndpoints(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/results/{id}");

        // Which columns can be edited (and why not), and whether rows can be added/deleted.
        api.MapGet("/editability", async (string id, ResultStore results, TableSources sources, CancellationToken ct) =>
        {
            if (results.Get(id) is not { } buffer) return Results.NotFound();
            try
            {
                return Results.Ok(EditPlanner.Editability(buffer, await sources.Get(buffer, ct)));
            }
            catch (Exception ex) when (ex is NpgsqlException or TimeoutException or Connections.ConnectException)
            {
                return Results.Ok(new { error = $"Couldn't look up the source tables: {ex.Message}" });
            }
        });

        // The exact script Apply will run, for the review.
        api.MapPost("/edits/preview", async (string id, EditSet edits, ResultStore results, TableSources sources, CancellationToken ct) =>
        {
            if (results.Get(id) is not { } buffer)
                return Results.BadRequest(new { error = "This result is no longer available. Run the query again." });
            try
            {
                var plan = EditPlanner.Plan(buffer, await sources.Get(buffer, ct), edits);
                return Results.Ok(new { sql = EditPlanner.Script(plan), statements = plan.Count });
            }
            catch (EditException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });
    }
}
