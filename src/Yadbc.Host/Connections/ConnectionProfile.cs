using System.Text.Json.Serialization;
using Yadbc.Host.Sharing;

namespace Yadbc.Host.Connections;

public enum ConnectionEnv { Local, Dev, Prod }

/// <summary>
/// Non-secret connection config. The password lives in the OS keychain, keyed by <see cref="Id"/>,
/// so profiles can later be shared as-is and a broker can plug in as another credential source.
/// </summary>
public sealed record ConnectionProfile(
    string Id,
    string Name,
    string Host,
    int Port,
    string Database,
    string Username,
    ConnectionEnv Env,
    /// <summary>May Claude query it through the MCP server? Null = the default for its environment.</summary>
    bool? Mcp = null,
    /// <summary>SSH or Kubernetes tunnel to reach it; null = connect directly.</summary>
    TunnelConfig? Tunnel = null,
    /// <summary>Installed from the shared-connections broker; null = a local connection.</summary>
    SharedLink? Shared = null,
    /// <summary>Listing only (never saved): a "bring your own login" share whose login isn't entered yet.</summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool NeedsLogin = false)
{
    /// <summary>
    /// Local and dev are open to MCP unless switched off; prod only when switched on explicitly. A shared
    /// connection's owner can rule it out for everyone; each person can still switch it off.
    /// </summary>
    public bool McpAllowed => Shared is not { McpAllowed: false } && (Mcp ?? Env != ConnectionEnv.Prod);
}

/// <summary>Profile fields as sent by the UI; password is only present when it's being set or changed.</summary>
public sealed record ConnectionInput(
    string Name,
    string Host,
    int Port,
    string Database,
    string Username,
    ConnectionEnv Env,
    string? Password,
    bool? Mcp = null,
    TunnelConfig? Tunnel = null);
