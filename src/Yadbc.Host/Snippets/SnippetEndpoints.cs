using System.Text.Json;
using Yadbc.Host.Hosting;

namespace Yadbc.Host.Snippets;

/// <summary>A saved, named statement; ConnectionId null = offered on every connection.</summary>
public sealed record Snippet(string Id, string Name, string Sql, string? ConnectionId, DateTimeOffset Updated);

public sealed record SnippetInput(string Name, string Sql, string? ConnectionId);

/// <summary>
/// Saved statements in snippets.json next to connections.json. Per item, not one PUT of the whole list,
/// so two windows saving at once don't drop each other's snippets.
/// </summary>
public static class SnippetEndpoints
{
    static readonly Lock Gate = new();
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    static string File_ => Path.Combine(AppPaths.DataDir, "snippets.json");

    static List<Snippet> Load() =>
        File.Exists(File_) ? JsonSerializer.Deserialize<List<Snippet>>(File.ReadAllText(File_), Json) ?? [] : [];

    static void Save(List<Snippet> all)
    {
        var tmp = File_ + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(all, Json));
        File.Move(tmp, File_, overwrite: true);
    }

    public static void MapSnippetEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/snippets", () =>
        {
            lock (Gate) return Results.Ok(Load().OrderBy(s => s.Name, StringComparer.CurrentCultureIgnoreCase));
        });

        // Create (unknown id) or replace.
        app.MapPut("/api/snippets/{id}", (string id, SnippetInput input) =>
        {
            if (string.IsNullOrWhiteSpace(input.Name) || string.IsNullOrWhiteSpace(input.Sql))
                return Results.BadRequest(new { error = "A snippet needs a name and SQL" });
            var snippet = new Snippet(id, input.Name.Trim(), input.Sql, input.ConnectionId, DateTimeOffset.Now);
            lock (Gate)
            {
                var all = Load();
                all.RemoveAll(s => s.Id == id);
                all.Add(snippet);
                Save(all);
            }
            return Results.Ok(snippet);
        });

        app.MapDelete("/api/snippets/{id}", (string id) =>
        {
            lock (Gate)
            {
                var all = Load();
                if (all.RemoveAll(s => s.Id == id) > 0) Save(all);
            }
            return Results.NoContent();
        });
    }
}
