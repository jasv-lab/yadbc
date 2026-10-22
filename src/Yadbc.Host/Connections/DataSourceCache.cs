using System.Collections.Concurrent;
using Npgsql;
using Yadbc.Host.Sharing;

namespace Yadbc.Host.Connections;

/// <summary>
/// Data sources per profile, rebuilt when the profile or password changes:
/// <list type="bullet">
/// <item><see cref="Get"/> — unpooled, for editor tabs that hold one session for their lifetime.</item>
/// <item><see cref="Catalog"/> — a small read-only pool for schema browsing and source lookups, so they
/// never run inside (or wait behind) a tab's transaction, and repeat lookups don't pay for a new login.</item>
/// </list>
/// </summary>
public sealed class DataSourceCache(ConnectionStore store, SecretStore secrets, TunnelManager tunnels, SharedLogins logins) : IDisposable
{
    readonly ConcurrentDictionary<string, NpgsqlDataSource> _sources = new();
    readonly ConcurrentDictionary<string, NpgsqlDataSource> _catalog = new();

    NpgsqlDataSource Get(string connectionId) =>
        _sources.GetOrAdd(connectionId, id => Build(Profile(id), secrets.GetPassword(id), tunnels.Endpoint(Profile(id))));

    NpgsqlDataSource Catalog(string connectionId) =>
        _catalog.GetOrAdd(connectionId, id => Build(Profile(id), secrets.GetPassword(id), tunnels.Endpoint(Profile(id)), catalog: true));

    /// <summary>A tab session connection; brings the connection's tunnel up first if it has one.</summary>
    public Task<NpgsqlConnection> OpenAsync(string connectionId, CancellationToken ct) =>
        Open(connectionId, () => Get(connectionId).OpenConnectionAsync(ct), ct);

    /// <summary>A read-only catalog-pool connection; brings the connection's tunnel up first if it has one.</summary>
    public Task<NpgsqlConnection> OpenCatalogAsync(string connectionId, CancellationToken ct) =>
        Open(connectionId, () => Catalog(connectionId).OpenConnectionAsync(ct), ct);

    /// <summary>
    /// Tunnel up, shared login cached, then open. A shared login Postgres rejects (it was rotated) is
    /// fetched from the broker once more and the open retried with it.
    /// </summary>
    async Task<NpgsqlConnection> Open(string connectionId, Func<ValueTask<NpgsqlConnection>> open, CancellationToken ct)
    {
        await tunnels.EnsureAsync(Profile(connectionId), ct);
        await logins.EnsureAsync(connectionId, ct);
        try
        {
            return await open();
        }
        catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.InvalidPassword && Profile(connectionId).Shared is not null)
        {
            if (!await logins.RefreshAsync(connectionId, ct)) throw;
            ResetSources(connectionId);
            return await open();
        }
    }

    /// <summary>New login, same tunnel: only the data sources (they hold the password) are rebuilt.</summary>
    void ResetSources(string connectionId)
    {
        if (_sources.TryRemove(connectionId, out var ds)) ds.Dispose();
        if (_catalog.TryRemove(connectionId, out var cat)) cat.Dispose();
    }

    /// <summary>False when the connection has a tunnel and it isn't running (died since it was started).</summary>
    public bool TransportAlive(string connectionId) => tunnels.IsAlive(connectionId);

    public void Invalidate(string connectionId)
    {
        ResetSources(connectionId);
        tunnels.Stop(connectionId);
    }

    ConnectionProfile Profile(string connectionId) =>
        store.Get(connectionId) ?? throw new KeyNotFoundException($"Unknown connection '{connectionId}'");

    public static NpgsqlDataSource Build(ConnectionProfile profile, string? password, (string Host, int Port) endpoint, bool catalog = false)
    {
        var csb = new NpgsqlConnectionStringBuilder
        {
            Host = endpoint.Host,
            Port = endpoint.Port,
            Database = profile.Database,
            Username = profile.Username,
            Password = password,
            ApplicationName = catalog ? "yadbc (catalog)" : "yadbc",
            // Editor tabs hold a dedicated connection for their lifetime (tx state, SET, temp tables are per tab);
            // pooling would only keep idle server sessions around after a tab closes.
            Pooling = catalog,
            MaxPoolSize = catalog ? 2 : 100,
            ConnectionIdleLifetime = 60,
            Timeout = 10,
            // int[] can't hold NULL elements; nullable element arrays only when the value actually has NULLs.
            ArrayNullabilityMode = ArrayNullabilityMode.PerInstance,
        };
        // Catalog sessions only ever read; make the server enforce it.
        if (catalog) csb.Options = "-c default_transaction_read_only=on -c statement_timeout=15000";
        var builder = new NpgsqlDataSourceBuilder(csb.ConnectionString);
        // A generic client meets user enums, ranges and composites it has no CLR mapping for.
        builder.EnableUnmappedTypes();
        return builder.Build();
    }

    public void Dispose()
    {
        foreach (var ds in _sources.Values) ds.Dispose();
        foreach (var ds in _catalog.Values) ds.Dispose();
    }
}
