using System.Text.Json;
using Yadbc.Contracts.Broker;
using Yadbc.Host.Connections;
using Yadbc.Host.Hosting;
using Yadbc.Host.Sharing;

namespace Yadbc.Host.Snippets;

/// <summary>A saved, named statement; ConnectionId null = offered on every connection.</summary>
public sealed record Snippet(string Id, string Name, string Sql, string? ConnectionId, DateTimeOffset Updated);

public sealed record SnippetInput(string Name, string Sql, string? ConnectionId);

/// <summary>Who shared a snippet, and whether this person may change it (author, the share's owners, admins).</summary>
public sealed record SnippetSharing(string By, bool CanEdit);

/// <summary>A snippet as the UI lists it: local (Shared null) or from the broker.</summary>
public sealed record SnippetView(string Id, string Name, string Sql, string? ConnectionId, DateTimeOffset Updated, SnippetSharing? Shared);

/// <summary>
/// Saved statements: your own in snippets.json next to connections.json, saved per item (not one PUT of
/// the whole list) so two windows saving at once don't drop each other's; and the team's shared ones
/// from the broker. A shared snippet sits on a shared connection (everyone who installed it gets it) or
/// on every connection (the whole team). Sharing moves a snippet to the broker, stopping moves it back.
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

    static Snippet? Local(string id)
    {
        lock (Gate) return Load().FirstOrDefault(s => s.Id == id);
    }

    static void PutLocal(Snippet snippet)
    {
        lock (Gate)
        {
            var all = Load();
            all.RemoveAll(s => s.Id == snippet.Id);
            all.Add(snippet);
            Save(all);
        }
    }

    static void RemoveLocal(string id)
    {
        lock (Gate)
        {
            var all = Load();
            if (all.RemoveAll(s => s.Id == id) > 0) Save(all);
        }
    }

    public static void MapSnippetEndpoints(this IEndpointRouteBuilder app)
    {
        // Shared snippets of shares that aren't installed here aren't offered anywhere.
        app.MapGet("/api/snippets", (ConnectionStore store, SharedSnippets shared) =>
        {
            List<Snippet> local;
            lock (Gate) local = Load();
            var installed = Installed(store);
            var views = local.Select(s => new SnippetView(s.Id, s.Name, s.Sql, s.ConnectionId, s.Updated, null))
                .Concat(shared.All
                    .Where(s => s.ShareId is null || installed.ContainsKey(s.ShareId))
                    .Select(s => View(s, installed)));
            return Results.Ok(views.OrderBy(s => s.Name, StringComparer.CurrentCultureIgnoreCase));
        });

        // Create (unknown id) or replace; a shared snippet is changed on the broker, for everyone.
        app.MapPut("/api/snippets/{id}", async (string id, SnippetInput input, ConnectionStore store, SharedSnippets shared, Broker broker,
            CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(input.Name) || string.IsNullOrWhiteSpace(input.Sql))
                return Results.BadRequest(new { error = "A snippet needs a name and SQL" });
            if (shared.Get(id) is { } current)
            {
                if (!current.CanEdit) return NotYours();
                if (ShareScope(store, input.ConnectionId) is not { } scope) return LocalConnection();
                return await SharingEndpoints.TryAsync(async () =>
                {
                    var saved = await broker.PutSnippetAsync(id, new SharedSnippetInput(input.Name.Trim(), input.Sql, scope.ShareId), ct);
                    shared.Put(saved);
                    return Results.Ok(View(saved, Installed(store)));
                });
            }
            var snippet = new Snippet(id, input.Name.Trim(), input.Sql, input.ConnectionId, DateTimeOffset.Now);
            PutLocal(snippet);
            return Results.Ok(new SnippetView(snippet.Id, snippet.Name, snippet.Sql, snippet.ConnectionId, snippet.Updated, null));
        });

        app.MapDelete("/api/snippets/{id}", async (string id, SharedSnippets shared, Broker broker, CancellationToken ct) =>
        {
            if (shared.Get(id) is not { } current)
            {
                RemoveLocal(id);
                return Results.NoContent();
            }
            if (!current.CanEdit) return NotYours();
            return await SharingEndpoints.TryAsync(async () =>
            {
                await broker.DeleteSnippetAsync(id, ct);
                shared.Remove(id);
                return Results.NoContent();
            });
        });

        // Your snippet becomes the team's: with everyone using its (shared) connection, or with everyone.
        app.MapPost("/api/snippets/{id}/share", async (string id, ConnectionStore store, SharedSnippets shared, Broker broker, CancellationToken ct) =>
        {
            if (Local(id) is not { } snippet) return Results.NotFound();
            if (ShareScope(store, snippet.ConnectionId) is not { } scope) return LocalConnection();
            return await SharingEndpoints.TryAsync(async () =>
            {
                var saved = await broker.PutSnippetAsync(id, new SharedSnippetInput(snippet.Name, snippet.Sql, scope.ShareId), ct);
                shared.Put(saved);
                RemoveLocal(id);
                return Results.Ok(View(saved, Installed(store)));
            });
        });

        // Back to being only yours (author, owners, admins): deleted on the broker, kept here.
        app.MapPost("/api/snippets/{id}/stop-sharing", async (string id, ConnectionStore store, SharedSnippets shared, Broker broker,
            CancellationToken ct) =>
        {
            if (shared.Get(id) is not { } current) return Results.NotFound();
            if (!current.CanEdit) return NotYours();
            return await SharingEndpoints.TryAsync(async () =>
            {
                await broker.DeleteSnippetAsync(id, ct);
                shared.Remove(id);
                var connectionId = current.ShareId is null ? null : Installed(store).GetValueOrDefault(current.ShareId);
                var local = new Snippet(id, current.Name, current.Sql, connectionId, DateTimeOffset.Now);
                PutLocal(local);
                return Results.Ok(new SnippetView(local.Id, local.Name, local.Sql, local.ConnectionId, local.Updated, null));
            });
        });
    }

    /// <summary>Share id → the installed connection's id.</summary>
    static Dictionary<string, string> Installed(ConnectionStore store) =>
        store.All().Where(p => p.Shared is not null).GroupBy(p => p.Shared!.ShareId).ToDictionary(g => g.Key, g => g.First().Id);

    static SnippetView View(SharedSnippet s, Dictionary<string, string> installed) =>
        new(s.Id, s.Name, s.Sql, s.ShareId is null ? null : installed.GetValueOrDefault(s.ShareId), s.UpdatedAt,
            new SnippetSharing(s.Author.Name, s.CanEdit));

    sealed record Scope(string? ShareId);

    /// <summary>Where a snippet on this connection goes on the broker; null for a connection only this machine has.</summary>
    static Scope? ShareScope(ConnectionStore store, string? connectionId) =>
        connectionId is null ? new Scope(null)
        : store.Get(connectionId)?.Shared is { Orphaned: false } link ? new Scope(link.ShareId)
        : null;

    static IResult LocalConnection() =>
        Results.BadRequest(new { error = "Its connection isn’t shared. Share the connection first, or offer the snippet on every connection." });

    static IResult NotYours() =>
        Results.Json(new { error = "Only its author, the connection’s owners or an admin can change this snippet. Copy it to your snippets instead." },
            statusCode: StatusCodes.Status403Forbidden);
}
