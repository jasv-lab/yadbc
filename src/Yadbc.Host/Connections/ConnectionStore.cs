using System.Text.Json;
using System.Text.Json.Serialization;
using Yadbc.Host.Hosting;

namespace Yadbc.Host.Connections;

/// <summary>Profiles in %APPDATA%\yadbc\connections.json — plain config, no secrets.</summary>
public sealed class ConnectionStore
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };
    readonly Lock _lock = new();
    List<ConnectionProfile> _profiles;

    public ConnectionStore()
    {
        _profiles = File.Exists(AppPaths.ConnectionsFile)
            ? JsonSerializer.Deserialize<List<ConnectionProfile>>(File.ReadAllText(AppPaths.ConnectionsFile), Json) ?? []
            : [];
    }

    public IReadOnlyList<ConnectionProfile> All()
    {
        lock (_lock) return [.. _profiles];
    }

    public ConnectionProfile? Get(string id)
    {
        lock (_lock) return _profiles.FirstOrDefault(c => c.Id == id);
    }

    public void Upsert(ConnectionProfile profile)
    {
        lock (_lock)
        {
            var i = _profiles.FindIndex(c => c.Id == profile.Id);
            if (i >= 0) _profiles[i] = profile;
            else _profiles.Add(profile);
            Save();
        }
    }

    public bool Remove(string id)
    {
        lock (_lock)
        {
            var removed = _profiles.RemoveAll(c => c.Id == id) > 0;
            if (removed) Save();
            return removed;
        }
    }

    void Save()
    {
        // Write-then-rename so a crash mid-write never leaves a truncated file.
        var tmp = AppPaths.ConnectionsFile + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_profiles, Json));
        File.Move(tmp, AppPaths.ConnectionsFile, overwrite: true);
    }
}
