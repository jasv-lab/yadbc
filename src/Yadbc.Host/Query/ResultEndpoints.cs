namespace Yadbc.Host.Query;

/// <summary>Sorting, searching and charting a result's buffered rows (no re-run; the grid re-reads its window).</summary>
public static class ResultEndpoints
{
    const int MaxMatches = 5000;

    public sealed record SortRequest(int? Column, bool Descending);

    public sealed record FindRequest(string Text);

    public sealed record ColumnsRequest(int[] Columns);

    public static void MapResultEndpoints(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/results/{id}");

        // Column null = back to the query's own order.
        api.MapPost("/sort", (string id, SortRequest req, ResultStore results) =>
        {
            if (results.Get(id) is not { } buffer) return Results.NotFound();
            if (!buffer.Done) return Results.BadRequest(new { error = "Wait for all rows to load." });
            if (req.Column is null)
                return Results.Ok(new { sorted = (object?)null, restored = buffer.RestoreOrder(), capped = buffer.Capped });
            if (req.Column < 0 || req.Column >= buffer.Columns.Count) return Results.BadRequest(new { error = "No such column." });
            buffer.Sort(req.Column.Value, req.Descending);
            return Results.Ok(new { sorted = new { column = req.Column, descending = req.Descending }, restored = false, capped = buffer.Capped });
        });

        // A few whole columns of the buffered rows (≤ 10k) for the quick chart: one request, not windows of every column.
        api.MapPost("/columns", (string id, ColumnsRequest req, ResultStore results) =>
        {
            if (results.Get(id) is not { } buffer) return Results.NotFound();
            if (req.Columns.Length is 0 or > 9 || req.Columns.Any(c => c < 0 || c >= buffer.Columns.Count))
                return Results.BadRequest(new { error = "No such column." });
            return Results.Ok(new { columns = buffer.ColumnValues(req.Columns, 200), done = buffer.Done });
        });

        api.MapPost("/find", (string id, FindRequest req, ResultStore results) =>
        {
            if (results.Get(id) is not { } buffer) return Results.NotFound();
            if (string.IsNullOrEmpty(req.Text)) return Results.Ok(new { matches = Array.Empty<int[]>(), total = 0 });
            var (matches, total) = buffer.Find(req.Text, MaxMatches);
            return Results.Ok(new { matches, total });
        });
    }
}
