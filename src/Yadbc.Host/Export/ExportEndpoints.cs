using Npgsql;
using Yadbc.Host.Query;

namespace Yadbc.Host.Export;

public static class ExportEndpoints
{
    public static void MapExportEndpoints(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/results/{id}");

        // Defaults for the export dialog: which table the chosen columns come from, and its PK.
        api.MapGet("/source", async (string id, string? cols, ResultStore results, TableSources sources, CancellationToken ct) =>
        {
            if (results.Get(id) is not { } buffer) return Results.NotFound();
            var source = await ResolveSource(buffer, sources, ct);
            var indexes = cols is { Length: > 0 }
                ? cols.Split(',').Select(int.Parse).ToArray()
                : Enumerable.Range(0, buffer.Columns.Count).ToArray();
            var table = source.TableOf(indexes);
            return Results.Ok(new
            {
                table,
                primaryKey = table is null ? null : source.PrimaryKey(table)?.Select(i => buffer.Columns[i].Name),
                totalRows = buffer.TotalRows,
                capped = buffer.Capped,
            });
        });

        api.MapPost("/export", async (string id, ExportRequest req, ResultStore results, TableSources sources, CancellationToken ct) =>
        {
            if (results.Get(id) is not { } buffer)
                return Results.BadRequest(new { error = "This result is no longer available. Run the query again." });
            try
            {
                // Cached per result: at most one catalog query per result.
                var source = await ResolveSource(buffer, sources, ct);
                return Results.Ok(Exporter.Run(buffer, source, req));
            }
            catch (ExportException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });
    }

    /// <summary>Source lookup is a convenience: if the catalog query fails, export still works with explicit names.</summary>
    static async Task<ResultSource> ResolveSource(ResultBuffer buffer, TableSources sources, CancellationToken ct)
    {
        try
        {
            return await sources.Get(buffer, ct);
        }
        catch (Exception ex) when (ex is NpgsqlException or TimeoutException or Connections.ConnectException)
        {
            return ResultSource.Unknown;
        }
    }
}
