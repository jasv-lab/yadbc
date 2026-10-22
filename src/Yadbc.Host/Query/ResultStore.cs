using System.Collections.Concurrent;

namespace Yadbc.Host.Query;

/// <summary>
/// All live result buffers, reachable from the WebSocket (windows, cells) and from HTTP (exports).
/// Owned by a socket + tab; a re-run, tab close or socket close drops them.
/// </summary>
public sealed class ResultStore
{
    readonly ConcurrentDictionary<string, (string Owner, ResultBuffer Buffer)> _results = new();

    public void Add(string owner, ResultBuffer buffer) => _results[buffer.Id] = (owner, buffer);

    public ResultBuffer? Get(string id) => _results.TryGetValue(id, out var r) ? r.Buffer : null;

    public void RemoveTab(string owner, string tabId)
    {
        foreach (var (id, r) in _results)
            if (r.Owner == owner && r.Buffer.TabId == tabId) _results.TryRemove(id, out _);
    }

    public void RemoveOwner(string owner)
    {
        foreach (var (id, r) in _results)
            if (r.Owner == owner) _results.TryRemove(id, out _);
    }
}
