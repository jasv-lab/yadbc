using System.Diagnostics;
using Npgsql;
using Yadbc.Host.Connections;
using Yadbc.Host.History;

namespace Yadbc.Host.SchemaChanges;

/// <summary>
/// Structure for comparing schemas and editing tables: a snapshot (read-only, catalog pool), and applying
/// a generated script — all of it in one transaction, so a failing statement leaves nothing half done.
/// </summary>
public static class SchemaChangeEndpoints
{
    public sealed record SnapshotRequest(string[]? Schemas, string? TableSchema, string? TableName);

    public sealed record ApplyRequest(List<string> Statements);

    public static void MapSchemaChangeEndpoints(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/schema-changes/{connectionId}");

        api.MapPost("/snapshot", async (string connectionId, SnapshotRequest req, DataSourceCache sources, CancellationToken ct) =>
        {
            try
            {
                await using var conn = await sources.OpenCatalogAsync(connectionId, ct);
                var table = req is { TableSchema: { } s, TableName: { } n } ? (s, n) : ((string, string)?)null;
                return Results.Ok(await SnapshotReader.ReadAsync(conn, req.Schemas, table, ct));
            }
            catch (Exception ex) when (ex is NpgsqlException or TimeoutException or KeyNotFoundException or ConnectException)
            {
                return Results.BadRequest(new { error = ex is PostgresException pg ? pg.MessageText : ex.Message });
            }
        });

        // Prod changes go through an editor tab instead, where the tab's read-only lock applies as everywhere.
        api.MapPost("/apply", async (string connectionId, ApplyRequest req, ConnectionStore store, DataSourceCache sources,
            HistoryStore history, CancellationToken ct) =>
        {
            if (store.Get(connectionId) is not { } profile) return Results.NotFound();
            if (profile.Env == ConnectionEnv.Prod)
                return Results.BadRequest(new { error = "Prod changes run from an editor tab (Open in new tab), where the read-only lock applies." });
            if (req.Statements.Count == 0) return Results.Ok(new { ok = true, statements = 0 });

            var script = string.Join(";\n\n", req.Statements) + ";";
            var started = DateTimeOffset.Now;
            var sw = Stopwatch.StartNew();
            var index = -1;
            try
            {
                await using var conn = await sources.OpenAsync(connectionId, ct);
                await using var tx = await conn.BeginTransactionAsync(ct);
                for (index = 0; index < req.Statements.Count; index++)
                {
                    await using var cmd = new NpgsqlCommand(req.Statements[index], conn);
                    await cmd.ExecuteNonQueryAsync(ct);
                }
                await tx.CommitAsync(ct);
                history.Record(new HistoryEntry(0, profile.Id, profile.Name, script, started, sw.ElapsedMilliseconds, req.Statements.Count, "ok", null, "edit"));
                return Results.Ok(new { ok = true, statements = req.Statements.Count });
            }
            catch (Exception ex) when (ex is NpgsqlException or TimeoutException or ConnectException)
            {
                var message = ex is PostgresException pg ? pg.MessageText : ex.Message;
                history.Record(new HistoryEntry(0, profile.Id, profile.Name, script, started, sw.ElapsedMilliseconds, null, "error", message, "edit"));
                // The transaction is rolled back when the connection goes away: nothing was changed.
                return Results.Ok(new { ok = false, error = message, statementIndex = index >= 0 && index < req.Statements.Count ? index : (int?)null });
            }
        });
    }
}
