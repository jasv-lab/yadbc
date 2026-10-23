using System.Text.Json;
using Yadbc.Host.Connections;
using Yadbc.Host.Hosting;
using Yadbc.Host.Sharing;

namespace Yadbc.Host.Ai;

/// <summary>
/// Which OpenAI-compatible endpoint answers (OpenAI, a LiteLLM proxy, vLLM…) and with which model. The endpoint
/// and model live in ai.json; the API key in Windows Credential Manager (yadbc:app:llm-key), never in a file.
/// </summary>
public sealed class AiSettings(SecretStore secrets)
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    static string File => Path.Combine(AppPaths.DataDir, "ai.json");
    const string KeyName = "llm-key";
    readonly Lock _gate = new();

    public sealed record Config(string? Endpoint = null, string? Model = null, int MaxTokens = 8192);

    public Config Load()
    {
        lock (_gate)
        {
            try
            {
                return System.IO.File.Exists(File)
                    ? JsonSerializer.Deserialize<Config>(System.IO.File.ReadAllText(File), Json) ?? new Config()
                    : new Config();
            }
            catch (JsonException)
            {
                return new Config();
            }
        }
    }

    public void Save(Config config)
    {
        lock (_gate)
        {
            var tmp = File + ".tmp";
            System.IO.File.WriteAllText(tmp, JsonSerializer.Serialize(config, Json));
            System.IO.File.Move(tmp, File, overwrite: true);
        }
    }

    public string? Key => secrets.GetAppSecret(KeyName);

    /// <summary>null keeps the stored key, "" removes it.</summary>
    public void SetKey(string? key)
    {
        if (key is null) return;
        if (key.Length == 0) secrets.DeleteAppSecret(KeyName);
        else secrets.SetAppSecret(KeyName, key);
    }

    /// <summary>What the assistant actually uses, and where it came from.</summary>
    public sealed record Effective(string? Endpoint, string? Model, int MaxTokens, string? Key, string Source);

    /// <summary>
    /// Your own endpoint wins outright. Without one, the team's settings from the broker apply; with
    /// your own key if you set one, else the team's key if it shares one.
    /// </summary>
    public async Task<Effective> EffectiveAsync(TeamAiSettings team, CancellationToken ct)
    {
        var own = Load();
        if (!string.IsNullOrWhiteSpace(own.Endpoint)) return new(own.Endpoint, own.Model, own.MaxTokens, Key, "own");
        if (team.Current is { } t) return new(t.Endpoint, t.Model, t.MaxTokens, Key ?? await team.KeyAsync(ct), "team");
        return new(null, null, own.MaxTokens, Key, "none");
    }

    /// <summary>"https://llm.example" and ".../v1" both work: the OpenAI routes live under /v1.</summary>
    public static string BaseUrl(string endpoint)
    {
        var e = endpoint.Trim().TrimEnd('/');
        return e.EndsWith("/v1", StringComparison.OrdinalIgnoreCase) ? e : e + "/v1";
    }
}
