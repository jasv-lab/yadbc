using System.Text.Json;
using Yadbc.Host.Connections;
using Yadbc.Host.Hosting;

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

    /// <summary>"https://llm.example" and ".../v1" both work: the OpenAI routes live under /v1.</summary>
    public static string BaseUrl(string endpoint)
    {
        var e = endpoint.Trim().TrimEnd('/');
        return e.EndsWith("/v1", StringComparison.OrdinalIgnoreCase) ? e : e + "/v1";
    }
}
