using System.Text.Json;
using Yadbc.Contracts.Broker;
using Yadbc.Host.Connections;
using Yadbc.Host.Hosting;

namespace Yadbc.Host.Sharing;

/// <summary>
/// The team's AI assistant settings from the broker, kept here (team-ai.json, the key in Credential
/// Manager) so the assistant works offline and without asking the broker for every question.
/// Refreshed by the sharing sync; a changed setting drops the cached key, which is fetched again
/// (audited on the broker) the next time it's needed.
/// </summary>
public sealed class TeamAiSettings(Broker broker, SecretStore secrets, ILogger<TeamAiSettings> log)
{
    const string KeyName = "llm-team-key";
    static string File => Path.Combine(AppPaths.DataDir, "team-ai.json");

    TeamAi? _current = Load();

    public TeamAi? Current => broker.SignedIn ? _current : null;

    public async Task RefreshAsync(CancellationToken ct)
    {
        if (!broker.SignedIn) return;
        var latest = await broker.TeamAiAsync(ct);
        if (latest?.UpdatedAt != _current?.UpdatedAt || latest is not { HasKey: true })
            secrets.DeleteAppSecret(KeyName);
        _current = latest;
        Save(latest);
    }

    /// <summary>The shared key, when the team shares one; null when it doesn't or it can't be had right now.</summary>
    public async Task<string?> KeyAsync(CancellationToken ct)
    {
        if (Current is not { HasKey: true }) return null;
        if (secrets.GetAppSecret(KeyName) is { } cached) return cached;
        try
        {
            var key = await broker.TeamAiKeyAsync(ct);
            secrets.SetAppSecret(KeyName, key);
            return key;
        }
        catch (BrokerException e)
        {
            log.LogInformation("Team AI key: {Message}", e.Message);
            return null;
        }
    }

    /// <summary>Signing out of the broker leaves nothing of the team's behind.</summary>
    public void Forget()
    {
        _current = null;
        Save(null);
        secrets.DeleteAppSecret(KeyName);
    }

    static TeamAi? Load()
    {
        try
        {
            return System.IO.File.Exists(File) ? JsonSerializer.Deserialize<TeamAi>(System.IO.File.ReadAllText(File), Broker.Json) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    static void Save(TeamAi? value)
    {
        if (value is null)
        {
            if (System.IO.File.Exists(File)) System.IO.File.Delete(File);
            return;
        }
        var tmp = File + ".tmp";
        System.IO.File.WriteAllText(tmp, JsonSerializer.Serialize(value, Broker.Json));
        System.IO.File.Move(tmp, File, overwrite: true);
    }
}
