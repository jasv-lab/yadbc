using Npgsql;
using Yadbc.Host.Connections;

namespace Yadbc.Host.Catalog;

/// <summary>
/// Schema browsing over the catalog pool (read-only, never a tab's session). Objects come in one round
/// trip so expanding and filtering are instant; per-table details load on expand.
/// </summary>
public static class CatalogEndpoints
{
    public static void MapCatalogEndpoints(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/catalog/{connectionId}");

        api.MapGet("/objects", (string connectionId, DataSourceCache sources, CancellationToken ct) =>
            Guard(async () =>
            {
                await using var conn = await sources.OpenCatalogAsync(connectionId, ct);
                var (schemas, objects) = await CatalogReader.ObjectsAsync(conn, ct);
                return Results.Ok(new { schemas, objects });
            }));

        // Find a value everywhere: which tables/columns to look in, then one table at a time.
        api.MapGet("/search/plan", (string connectionId, string type, DataSourceCache sources, CancellationToken ct) =>
            Guard(async () =>
            {
                if (ValueSearch.FamilyOf(type) is not { } family)
                    return Results.Ok(new { family = (string?)null, candidates = Array.Empty<object>() });
                await using var conn = await sources.OpenCatalogAsync(connectionId, ct);
                return Results.Ok(new { family, candidates = await ValueSearch.PlanAsync(conn, family, ct) });
            }));

        api.MapPost("/search/table", (string connectionId, SearchTableRequest req, DataSourceCache sources, CancellationToken ct) =>
            Guard(async () =>
            {
                var (hits, error) = await ValueSearch.SearchTableAsync(sources, connectionId, req.Schema, req.Table, req.Columns, req.Value, ct);
                return Results.Ok(new { hits, error });
            }));

        // One schema's tables and foreign keys, for the diagram.
        api.MapGet("/diagram", (string connectionId, string schema, DataSourceCache sources, CancellationToken ct) =>
            Guard(async () =>
            {
                await using var conn = await sources.OpenCatalogAsync(connectionId, ct);
                return Results.Ok(await DiagramReader.ReadAsync(conn, schema, ct));
            }));

        api.MapGet("/relation/{oid}", (string connectionId, uint oid, DataSourceCache sources, CancellationToken ct) =>
            Guard(async () =>
            {
                await using var conn = await sources.OpenCatalogAsync(connectionId, ct);
                return Results.Ok(await CatalogReader.RelationAsync(conn, oid, ct));
            }));

        api.MapGet("/definition/{kind}/{oid}", (string connectionId, string kind, uint oid, DataSourceCache sources, CancellationToken ct) =>
            Guard(async () =>
            {
                await using var conn = await sources.OpenCatalogAsync(connectionId, ct);
                var sql = await CatalogReader.DefinitionAsync(conn, kind, oid, ct);
                return sql is null ? Results.BadRequest(new { error = $"No definition for {kind}" }) : Results.Ok(new { sql });
            }));
    }

    public sealed record SearchTableRequest(string Schema, string Table, List<string> Columns, string Value);

    /// <summary>Catalog errors (bad password, network, permissions) become a readable 400, not a 500.</summary>
    static async Task<IResult> Guard(Func<Task<IResult>> action)
    {
        try
        {
            return await action();
        }
        catch (Exception ex) when (ex is NpgsqlException or TimeoutException or KeyNotFoundException or ConnectException)
        {
            return Results.BadRequest(new { error = ex is PostgresException pg ? pg.MessageText : ex.Message });
        }
    }
}
