namespace Yadbc.Contracts.Broker;

// The broker's wire format, shared by the broker and the app (JSON: camelCase, enums as camelCase strings).

public enum ShareEnv { Local, Dev, Prod }

/// <summary>Included: the share carries one login for everyone. Own: a template, each person fills in their own.</summary>
public enum LoginMode { Included, Own }

public enum TunnelKind { Ssh, Kubernetes }

/// <summary>
/// The shareable part of a tunnel. What differs per person (SSH user, kube context, kubeconfig path)
/// stays on their machine.
/// </summary>
public sealed record ShareTunnel(
    TunnelKind Kind,
    string? SshHost = null,
    int? SshPort = null,
    string? KubeNamespace = null,
    string? KubeTarget = null);

public sealed record PersonRef(string Id, string Name, string? Email);

/// <summary>What an owner sends to create or change a share. The login is set separately (write-only).</summary>
public sealed record ShareInput(
    string Name,
    string Host,
    int Port,
    string Database,
    ShareEnv Env,
    LoginMode LoginMode,
    ShareTunnel? Tunnel,
    /// <summary>The owner's ceiling for Claude (MCP) access; each person can still switch it off.</summary>
    bool McpAllowed,
    /// <summary>User ids; the person saving is added when creating. Empty = keep the current owners.</summary>
    string[]? Owners = null);

/// <summary>A share as listed in the catalog. <see cref="Version"/> goes back in If-Match when saving.</summary>
public sealed record Share(
    string Id,
    string Name,
    string Host,
    int Port,
    string Database,
    ShareEnv Env,
    LoginMode LoginMode,
    ShareTunnel? Tunnel,
    bool McpAllowed,
    PersonRef[] Owners,
    int Version,
    PersonRef UpdatedBy,
    DateTimeOffset UpdatedAt,
    /// <summary>The included login's user name (not secret); null for templates or before a login is set.</summary>
    string? Username,
    bool HasLogin,
    int Installs,
    bool InstalledByMe,
    bool CanEdit);

public sealed record ShareLogin(string Username, string Password);

/// <summary>412 body: someone saved first.</summary>
public sealed record ShareConflict(int Version, PersonRef UpdatedBy, DateTimeOffset UpdatedAt);

/// <summary>Exchanges the one-time code from the sign-in redirect for a device token (PKCE).</summary>
public sealed record TokenRequest(string Code, string CodeVerifier, string DeviceName);

public sealed record TokenResponse(string Token, DateTimeOffset ExpiresAt, Me Me);

public sealed record Me(PersonRef User, bool IsAdmin, string[] Installs);

public sealed record Device(
    string Id,
    string Name,
    DateTimeOffset CreatedAt,
    DateTimeOffset LastUsedAt,
    DateTimeOffset ExpiresAt,
    bool Current);

public sealed record AuditEntry(DateTimeOffset At, PersonRef? User, string Action, string? Detail);

public sealed record BrokerError(string Error);
