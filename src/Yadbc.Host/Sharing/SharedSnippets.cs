using System.Text.Json;
using Yadbc.Contracts.Broker;
using Yadbc.Host.Hosting;

namespace Yadbc.Host.Sharing;

/// <summary>
/// The team's shared snippets, kept here (shared-snippets.json) so they're offered offline too.
/// Refreshed by the sharing sync; this app's own changes go to the broker first, then here.
/// </summary>
public sealed class SharedSnippets(Broker broker)
{
    static string File => Path.Combine(AppPaths.DataDir, "shared-snippets.json");

    readonly Lock _gate = new();
    List<SharedSnippet> _all = Load();

    public IReadOnlyList<SharedSnippet> All
    {
        get
        {
            lock (_gate) return _all;
        }
    }

    public SharedSnippet? Get(string id) => All.FirstOrDefault(s => s.Id == id);

    /// <summary>Whether anything changed.</summary>
    public async Task<bool> RefreshAsync(CancellationToken ct)
    {
        if (!broker.SignedIn || await broker.SnippetsAsync(ct) is not { } latest) return false;
        lock (_gate)
        {
            if (JsonSerializer.Serialize(latest, Broker.Json) == JsonSerializer.Serialize(_all, Broker.Json)) return false;
            Replace(latest);
        }
        return true;
    }

    public void Put(SharedSnippet snippet)
    {
        lock (_gate) Replace([.. _all.Where(s => s.Id != snippet.Id), snippet]);
    }

    public void Remove(string id)
    {
        lock (_gate) Replace([.. _all.Where(s => s.Id != id)]);
    }

    void Replace(List<SharedSnippet> all)
    {
        _all = all;
        var tmp = File + ".tmp";
        System.IO.File.WriteAllText(tmp, JsonSerializer.Serialize(all, Broker.Json));
        System.IO.File.Move(tmp, File, overwrite: true);
    }

    static List<SharedSnippet> Load()
    {
        try
        {
            return System.IO.File.Exists(File) ? JsonSerializer.Deserialize<List<SharedSnippet>>(System.IO.File.ReadAllText(File), Broker.Json) ?? [] : [];
        }
        catch (JsonException)
        {
            return [];
        }
    }
}
