using Yadbc.Contracts.Broker;
using Yadbc.Host.Connections;

namespace Yadbc.Host.Sharing;

public sealed class SharedLoginException(string message) : ConnectException(message);

/// <summary>
/// Logins of installed shares that include one. Fetched from the broker when first needed and cached in
/// Credential Manager under the profile, like any local password — so a share still opens while the
/// broker is down. When Postgres rejects the cached one (rotated), it's fetched again once.
/// </summary>
public sealed class SharedLogins(ConnectionStore store, SecretStore secrets, Broker broker)
{
    static bool HasIncludedLogin(ConnectionProfile? p) => p?.Shared is { LoginMode: LoginMode.Included, Orphaned: false };

    /// <summary>Before connecting: make sure an included login is cached.</summary>
    public async Task EnsureAsync(string connectionId, CancellationToken ct)
    {
        var profile = store.Get(connectionId);
        if (!HasIncludedLogin(profile) || secrets.GetPassword(connectionId) is not null) return;
        await FetchAsync(profile!, ct);
    }

    /// <summary>After an authentication failure: true when the broker had a different login to try.</summary>
    public async Task<bool> RefreshAsync(string connectionId, CancellationToken ct)
    {
        var profile = store.Get(connectionId);
        if (!HasIncludedLogin(profile) || !broker.SignedIn) return false;
        var before = (profile!.Username, secrets.GetPassword(connectionId));
        var login = await FetchAsync(profile, ct);
        return (login.Username, login.Password) != before;
    }

    public async Task<ShareLogin> FetchAsync(ConnectionProfile profile, CancellationToken ct)
    {
        ShareLogin login;
        try
        {
            login = await broker.GetLoginAsync(profile.Shared!.ShareId, ct);
        }
        catch (BrokerException e)
        {
            throw new SharedLoginException($"The login for {profile.Name} comes from the shared-connections broker: {e.Message}");
        }
        secrets.SetPassword(profile.Id, login.Username, login.Password);
        if (login.Username != profile.Username) store.Upsert(profile with { Username = login.Username });
        return login;
    }
}
