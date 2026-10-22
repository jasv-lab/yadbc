using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json;
using Yadbc.Host.Connections;
using Yadbc.Host.Hosting;

namespace Yadbc.Host.Mcp;

/// <summary>
/// The MCP endpoint's switch, port and token. Off by default. It listens on its own fixed port
/// (the UI port changes every launch; an MCP client config can't follow that) and requires a bearer
/// token that persists in Credential Manager, so Claude's config is set up once.
/// </summary>
public sealed class McpState(SecretStore secrets)
{
    public const int DefaultPort = 47800;
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    static string SettingsFile => Path.Combine(AppPaths.DataDir, "settings.json");

    sealed record Settings(bool McpEnabled = false, int McpPort = DefaultPort);

    Settings _settings = Load();
    readonly Lock _lock = new();

    public bool Enabled => _settings.McpEnabled;
    public int Port => _settings.McpPort;
    /// <summary>Whether the port was free at startup (another yadbc instance may hold it).</summary>
    public bool Listening { get; set; }
    public string Url => $"http://127.0.0.1:{Port}/mcp";

    public string Token
    {
        get
        {
            lock (_lock)
            {
                var token = secrets.GetAppSecret("mcp-token");
                if (token is not null) return token;
                token = NewToken();
                secrets.SetAppSecret("mcp-token", token);
                return token;
            }
        }
    }

    public void SetEnabled(bool enabled)
    {
        lock (_lock)
        {
            _settings = _settings with { McpEnabled = enabled };
            File.WriteAllText(SettingsFile, JsonSerializer.Serialize(_settings, Json));
        }
    }

    /// <summary>Invalidates any client configured with the old token.</summary>
    public string RegenerateToken()
    {
        lock (_lock)
        {
            var token = NewToken();
            secrets.SetAppSecret("mcp-token", token);
            return token;
        }
    }

    public bool IsValid(string? authorization)
    {
        const string prefix = "Bearer ";
        if (authorization is null || !authorization.StartsWith(prefix, StringComparison.Ordinal)) return false;
        var given = authorization[prefix.Length..].Trim();
        return CryptographicOperations.FixedTimeEquals(
            System.Text.Encoding.UTF8.GetBytes(given), System.Text.Encoding.UTF8.GetBytes(Token));
    }

    /// <summary>Kestrel fails to start if any endpoint can't bind, so probe the port first.</summary>
    public static bool PortIsFree(int port)
    {
        try
        {
            using var probe = new TcpListener(IPAddress.Loopback, port);
            probe.Start();
            probe.Stop();
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }

    public static int ConfiguredPort() => Load().McpPort;

    static Settings Load()
    {
        try
        {
            return File.Exists(SettingsFile)
                ? JsonSerializer.Deserialize<Settings>(File.ReadAllText(SettingsFile), Json) ?? new Settings()
                : new Settings();
        }
        catch (JsonException)
        {
            return new Settings();
        }
    }

    static string NewToken() => "yadbc_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
}
