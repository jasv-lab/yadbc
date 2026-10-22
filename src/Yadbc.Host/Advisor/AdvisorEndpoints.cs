using Npgsql;
using Yadbc.Host.Connections;

namespace Yadbc.Host.Advisor;

/// <summary>Index suggestions for one statement (next to its EXPLAIN) or for the recorded workload.</summary>
public static class AdvisorEndpoints
{
    public sealed record StatementInput(string Sql);

    public static void MapAdvisorEndpoints(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/advisor/{connectionId}");

        api.MapPost("/statement", (string connectionId, StatementInput input, DataSourceCache sources, CancellationToken ct) =>
            Guard(async () =>
            {
                await using var conn = await sources.OpenCatalogAsync(connectionId, ct);
                return Results.Ok(await IndexAdvisor.StatementAsync(conn, input.Sql, ct));
            }));

        api.MapGet("/workload", (string connectionId, DataSourceCache sources, CancellationToken ct) =>
            Guard(async () =>
            {
                await using var conn = await sources.OpenCatalogAsync(connectionId, ct);
                return Results.Ok(await IndexAdvisor.WorkloadAsync(conn, ct));
            }));
    }

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
