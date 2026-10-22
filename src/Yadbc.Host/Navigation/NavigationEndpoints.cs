using Npgsql;
using Yadbc.Host.Query;

namespace Yadbc.Host.Navigation;

/// <summary>Enum values and foreign keys of a result's columns: value pickers, go to, join.</summary>
public static class NavigationEndpoints
{
    public static void MapNavigationEndpoints(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/results/{id}");

        api.MapGet("/relations", async (string id, ResultStore results, RelationReader relations, CancellationToken ct) =>
        {
            if (results.Get(id) is not { } buffer) return Results.NotFound();
            try
            {
                return Results.Ok(new { columns = await relations.Get(buffer, ct) });
            }
            catch (Exception ex) when (ex is NpgsqlException or TimeoutException or Connections.ConnectException)
            {
                return Results.Ok(new { columns = Array.Empty<object>(), error = ex.Message });
            }
        });

        api.MapGet("/columns/{col:int}/values", async (string id, int col, string? q, ResultStore results, RelationReader relations, CancellationToken ct) =>
        {
            if (results.Get(id) is not { } buffer || col < 0 || col >= buffer.Columns.Count) return Results.NotFound();
            try
            {
                var (values, truncated) = await relations.ValuesAsync(buffer, col, q, ct);
                return Results.Ok(new { values, truncated });
            }
            catch (Exception ex) when (ex is NpgsqlException or TimeoutException or Connections.ConnectException)
            {
                return Results.Ok(new { values = Array.Empty<PickValue>(), truncated = false, error = ex is PostgresException pg ? pg.MessageText : ex.Message });
            }
        });
    }
}
