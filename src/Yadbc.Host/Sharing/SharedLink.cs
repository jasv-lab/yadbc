using Yadbc.Contracts.Broker;
using Yadbc.Host.Connections;

namespace Yadbc.Host.Sharing;

/// <summary>
/// On a profile installed from the broker: which share it is and what the broker said last. The shared
/// fields of the profile (name, host, port, database, env, tunnel target) follow the share; the
/// per-person ones (SSH user and key, kubeconfig and context, MCP off, an own login) stay local.
/// </summary>
public sealed record SharedLink(
    string ShareId,
    string BrokerUrl,
    int Version,
    LoginMode LoginMode,
    /// <summary>The owner's ceiling for Claude (MCP).</summary>
    bool McpAllowed,
    bool CanEdit,
    string[] Owners,
    /// <summary>Deleted on the broker: still usable here (cached login), until kept as local or removed.</summary>
    bool Orphaned = false);

public static class ShareMapping
{
    public static SharedLink Link(Share share, string brokerUrl) =>
        new(share.Id, brokerUrl, share.Version, share.LoginMode, share.McpAllowed, share.CanEdit,
            share.Owners.Select(o => o.Name).ToArray());

    /// <summary>The share's fields over the local profile (or a new one), keeping what's per-person.</summary>
    public static ConnectionProfile Apply(Share share, string brokerUrl, string id, ConnectionProfile? local)
    {
        var lt = local?.Tunnel;
        var tunnel = share.Tunnel is not { } t
            ? null
            : new TunnelConfig(
                t.Kind == TunnelKind.Ssh ? "ssh" : "kubernetes",
                SshHost: t.SshHost,
                SshUser: lt?.SshUser,
                SshPort: t.SshPort,
                SshIdentityFile: lt?.SshIdentityFile,
                Kubeconfig: lt?.Kubeconfig,
                KubeContext: lt?.KubeContext,
                KubeNamespace: t.KubeNamespace,
                KubeTarget: t.KubeTarget);
        // An included login brings its user name; a template keeps the one you entered (none at first,
        // and none carried over from when the share still included a login).
        var username = share.LoginMode == LoginMode.Included
            ? share.Username ?? local?.Username ?? ""
            : local?.Shared?.LoginMode == LoginMode.Own ? local.Username : "";
        return new ConnectionProfile(
            id,
            share.Name,
            share.Host,
            share.Port,
            share.Database,
            username,
            Enum.Parse<ConnectionEnv>(share.Env.ToString()),
            local?.Mcp, // a new install follows its environment's default, under the owner's ceiling
            tunnel,
            Link(share, brokerUrl));
    }

    /// <summary>The shareable part of a profile.</summary>
    public static ShareInput Input(ConnectionProfile p, LoginMode mode, bool mcpAllowed, string[]? owners) =>
        new(
            p.Name,
            p.Host,
            p.Port,
            p.Database,
            Enum.Parse<ShareEnv>(p.Env.ToString()),
            mode,
            p.Tunnel is not { } t
                ? null
                : new ShareTunnel(
                    t.Kind == "ssh" ? TunnelKind.Ssh : TunnelKind.Kubernetes,
                    t.SshHost,
                    t.SshPort,
                    t.KubeNamespace,
                    t.KubeTarget),
            mcpAllowed,
            owners);

    /// <summary>A shared profile's own settings taken from an edit; the shared fields stay as they are.</summary>
    public static ConnectionProfile WithPersonalSettings(ConnectionProfile current, ConnectionInput input)
    {
        var it = input.Tunnel;
        var tunnel = current.Tunnel is { } t
            ? t with
            {
                SshUser = it?.SshUser,
                SshIdentityFile = it?.SshIdentityFile,
                Kubeconfig = it?.Kubeconfig,
                KubeContext = it?.KubeContext,
            }
            : null;
        return current with
        {
            Mcp = input.Mcp,
            Tunnel = tunnel,
            Username = current.Shared?.LoginMode == LoginMode.Own ? input.Username.Trim() : current.Username,
        };
    }
}
