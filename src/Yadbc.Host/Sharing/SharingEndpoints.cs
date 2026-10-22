using System.Net;
using System.Security.Cryptography;
using System.Text;
using Yadbc.Contracts.Broker;
using Yadbc.Host.Connections;
using Yadbc.Host.Hosting;

namespace Yadbc.Host.Sharing;

public sealed record SignInRequest(string BrokerUrl);

/// <summary>Share a local connection, or change how an existing share is shared (owners only).</summary>
public sealed record ShareRequest(bool IncludeLogin, bool McpAllowed, string[]? Owners);

public sealed record CatalogEntry(Share Share, string? InstalledAs);

/// <summary>
/// The app's side of shared connections: sign-in, the catalog with install / uninstall, sharing a local
/// connection, and the sync that keeps installed shares current (the UI calls it on start, on focus and
/// every few minutes). Everything degrades to "local only" without a broker.
/// </summary>
public static class SharingEndpoints
{
    public static void MapSharingEndpoints(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/sharing");

        api.MapGet("/status", (Broker broker, CancellationToken ct) => broker.StatusAsync(ct));

        api.MapPost("/sign-in", (SignInRequest req, Broker broker, LocalSecurity security) =>
            Try(() =>
            {
                var (url, opened) = broker.BeginSignIn(req.BrokerUrl, security.Port);
                return Results.Ok(new { url, opened });
            }));

        // The system browser lands here after the broker: no per-launch token (a browser tab doesn't have
        // it), so the state remembered at sign-in is what proves this is our own round trip.
        app.MapGet(Broker.CallbackPath, async (string? code, string? state, Broker broker, CancellationToken ct) =>
        {
            var error = await broker.CompleteSignInAsync(code, state, ct);
            return Results.Content(Page(error is null ? "Signed in" : "Sign-in failed",
                error ?? "yadbc is signed in to the shared connections. You can close this tab."), "text/html", Encoding.UTF8);
        });

        // Signing out also forgets the included logins cached here; the installed shares stay listed.
        api.MapPost("/sign-out", async (Broker broker, ConnectionStore store, SecretStore secrets, DataSourceCache cache, CancellationToken ct) =>
        {
            await broker.SignOutAsync(ct);
            foreach (var p in store.All().Where(p => p.Shared is { LoginMode: LoginMode.Included }))
            {
                secrets.Delete(p.Id);
                cache.Invalidate(p.Id);
            }
            return Results.NoContent();
        });

        api.MapPost("/sync", (Broker broker, ConnectionStore store, SecretStore secrets, DataSourceCache cache, SharedLogins logins, CancellationToken ct) =>
            TryAsync(async () => Results.Ok(new { changed = await SyncAsync(broker, store, secrets, cache, logins, ct) })));

        api.MapGet("/catalog", (Broker broker, ConnectionStore store, CancellationToken ct) => TryAsync(async () =>
        {
            var installed = store.All().Where(p => p.Shared is not null).ToDictionary(p => p.Shared!.ShareId, p => p.Id);
            var shares = await broker.CatalogAsync(ct);
            return Results.Ok(shares.Select(s => new CatalogEntry(s, installed.GetValueOrDefault(s.Id))));
        }));

        api.MapGet("/users", (Broker broker, CancellationToken ct) => TryAsync(async () => Results.Ok(await broker.UsersAsync(ct))));

        api.MapPost("/install/{shareId}", (string shareId, Broker broker, ConnectionStore store, CancellationToken ct) => TryAsync(async () =>
        {
            if (store.All().FirstOrDefault(p => p.Shared?.ShareId == shareId) is { } already) return Results.Ok(already);
            var share = await broker.GetShareAsync(shareId, ct);
            var profile = ShareMapping.Apply(share, broker.Url!, NewProfileId(), null);
            store.Upsert(profile);
            await broker.InstallAsync(shareId, ct);
            return Results.Ok(profile);
        }));

        api.MapPost("/share/{profileId}", (string profileId, ShareRequest req, Broker broker, ConnectionStore store, SecretStore secrets, CancellationToken ct) =>
            TryAsync(async () =>
            {
                if (store.Get(profileId) is not { } profile) return Results.NotFound();
                var mode = req.IncludeLogin ? LoginMode.Included : LoginMode.Own;
                var password = secrets.GetPassword(profileId);
                if (req.IncludeLogin && password is null)
                    return Results.BadRequest(new { error = "This connection has no saved password to include. Save one first, or let everyone use their own login." });

                Share share;
                if (profile.Shared is null)
                {
                    var shareId = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));
                    share = await broker.PutShareAsync(shareId, ShareMapping.Input(profile, mode, req.McpAllowed, req.Owners), null, ct);
                    if (req.IncludeLogin) share = await broker.SetLoginAsync(shareId, new ShareLogin(profile.Username, password!), ct);
                    await broker.InstallAsync(shareId, ct);
                }
                else
                {
                    var link = profile.Shared;
                    if (!link.CanEdit) return Results.Json(new { error = "Only the owners can change how this connection is shared." }, statusCode: 403);
                    share = await broker.PutShareAsync(link.ShareId, ShareMapping.Input(profile, mode, req.McpAllowed, req.Owners), link.Version, ct);
                    if (req.IncludeLogin && !share.HasLogin)
                        share = await broker.SetLoginAsync(link.ShareId, new ShareLogin(profile.Username, password!), ct);
                }
                // The profile itself doesn't change: it just becomes (stays) the installed link.
                var linked = profile with { Shared = ShareMapping.Link(share, broker.Url!) };
                store.Upsert(linked);
                return Results.Ok(linked);
            }));

        // Owners: delete the share; the connection becomes a plain local one here (login kept).
        api.MapPost("/stop/{profileId}", (string profileId, Broker broker, ConnectionStore store, CancellationToken ct) => TryAsync(async () =>
        {
            if (store.Get(profileId) is not { Shared: { } link } profile) return Results.NotFound();
            if (!link.CanEdit) return Results.Json(new { error = "Only the owners can stop sharing it; you can uninstall it." }, statusCode: 403);
            if (!link.Orphaned) await broker.DeleteShareAsync(link.ShareId, ct);
            var local = profile with { Shared = null };
            store.Upsert(local);
            return Results.Ok(local);
        }));

        // Anyone: keep a copy as a local connection (a share deleted on the broker, or just a personal copy).
        api.MapPost("/keep-local/{profileId}", async (string profileId, Broker broker, ConnectionStore store, CancellationToken ct) =>
        {
            if (store.Get(profileId) is not { Shared: { } link } profile) return Results.NotFound();
            if (!link.Orphaned && broker.SignedIn)
            {
                try
                {
                    await broker.UninstallAsync(link.ShareId, ct);
                }
                catch (BrokerException)
                {
                    // The local copy is what matters; the broker's install count can be off by one.
                }
            }
            var local = profile with { Shared = null };
            store.Upsert(local);
            return Results.Ok(local);
        });
    }

    /// <summary>
    /// Brings installed shares up to date with the catalog: changed ones take the broker's fields (and,
    /// if their login was already cached, the current login), deleted ones are marked orphaned.
    /// Returns how many profiles changed.
    /// </summary>
    public static async Task<int> SyncAsync(
        Broker broker,
        ConnectionStore store,
        SecretStore secrets,
        DataSourceCache cache,
        SharedLogins logins,
        CancellationToken ct)
    {
        if (!broker.SignedIn) return 0;
        var catalog = (await broker.CatalogAsync(ct)).ToDictionary(s => s.Id);
        var changed = 0;
        foreach (var profile in store.All())
        {
            if (profile.Shared is not { } link || link.BrokerUrl != broker.Url) continue;
            if (!catalog.TryGetValue(link.ShareId, out var share))
            {
                if (link.Orphaned) continue;
                store.Upsert(profile with { Shared = link with { Orphaned = true } });
                changed++;
                continue;
            }
            if (share.Version == link.Version && share.CanEdit == link.CanEdit && !link.Orphaned) continue;

            var updated = ShareMapping.Apply(share, broker.Url!, profile.Id, profile);
            store.Upsert(updated);
            cache.Invalidate(profile.Id);
            changed++;
            if (link.LoginMode == LoginMode.Included && share.LoginMode == LoginMode.Own)
                secrets.Delete(profile.Id); // the shared login is gone; each person enters their own now
            else if (share.LoginMode == LoginMode.Included && share.Version != link.Version && secrets.GetPassword(profile.Id) is not null)
            {
                try
                {
                    await logins.FetchAsync(updated, ct); // possibly rotated: refresh what's cached
                }
                catch (SharedLoginException)
                {
                    // Keep the cached one; a rejected login is retried at connect time anyway.
                }
            }
        }
        return changed;
    }

    /// <summary>A shared connection edited in the connection dialog: owners change it for everyone, others only their own settings.</summary>
    public static async Task<IResult> UpdateAsync(
        ConnectionProfile current,
        ConnectionProfile edited,
        ConnectionInput input,
        Broker broker,
        ConnectionStore store,
        SecretStore secrets,
        CancellationToken ct)
    {
        var link = current.Shared!;
        if (!link.CanEdit || link.Orphaned)
        {
            var mine = ShareMapping.WithPersonalSettings(current, input);
            store.Upsert(mine);
            if (link.LoginMode == LoginMode.Own && !string.IsNullOrEmpty(input.Password))
                secrets.SetPassword(mine.Id, mine.Username, input.Password);
            return Results.Ok(mine);
        }
        return await TryAsync(async () =>
        {
            var share = await broker.PutShareAsync(link.ShareId, ShareMapping.Input(edited, link.LoginMode, link.McpAllowed, null), link.Version, ct);
            if (link.LoginMode == LoginMode.Included)
            {
                var password = !string.IsNullOrEmpty(input.Password) ? input.Password : secrets.GetPassword(current.Id);
                if (password is not null && (!string.IsNullOrEmpty(input.Password) || edited.Username != current.Username))
                {
                    share = await broker.SetLoginAsync(link.ShareId, new ShareLogin(edited.Username, password), ct);
                    secrets.SetPassword(current.Id, edited.Username, password);
                }
            }
            else if (!string.IsNullOrEmpty(input.Password))
                secrets.SetPassword(current.Id, edited.Username, input.Password);
            var saved = ShareMapping.Apply(share, broker.Url!, current.Id, edited with { Shared = link });
            if (link.LoginMode == LoginMode.Own) saved = saved with { Username = edited.Username };
            store.Upsert(saved);
            return Results.Ok(saved);
        });
    }

    /// <summary>Uninstalling: the broker's install count, best effort — the profile goes either way.</summary>
    public static async Task UninstallAsync(ConnectionProfile profile, Broker broker, CancellationToken ct)
    {
        if (profile.Shared is not { Orphaned: false } link || !broker.SignedIn) return;
        try
        {
            await broker.UninstallAsync(link.ShareId, ct);
        }
        catch (BrokerException)
        {
        }
    }

    static string NewProfileId() => Guid.NewGuid().ToString("n")[..12];

    static IResult Try(Func<IResult> action)
    {
        try
        {
            return action();
        }
        catch (BrokerException e)
        {
            return Error(e);
        }
    }

    static async Task<IResult> TryAsync(Func<Task<IResult>> action)
    {
        try
        {
            return await action();
        }
        catch (BrokerException e)
        {
            return Error(e);
        }
    }

    /// <summary>
    /// Broker trouble reaches the UI as a message (never as a 401: that would read as the local API's
    /// token being wrong); `signedOut` tells it the broker sign-in is gone.
    /// </summary>
    static IResult Error(BrokerException e) =>
        Results.Json(new { error = e.Message, signedOut = e.Status == HttpStatusCode.Unauthorized },
            statusCode: e is BrokerConflictException ? 409 : 502);

    static string Page(string title, string message) =>
        $"""
        <!doctype html><meta charset="utf-8"><title>yadbc · {WebUtility.HtmlEncode(title)}</title>
        <body style="font:14px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#18181b">
        <h1 style="font-size:18px">{WebUtility.HtmlEncode(title)}</h1><p>{WebUtility.HtmlEncode(message)}</p></body>
        """;
}
