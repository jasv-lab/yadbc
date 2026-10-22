using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Yadbc.Broker.Auth;
using Yadbc.Broker.Storage;
using Yadbc.Contracts.Broker;

namespace Yadbc.Broker.Shares;

/// <summary>
/// The catalog. Everyone signed in sees every share and can fetch its login: this is a team directory,
/// not access control. Owners (and admins) change, delete and see the audit trail of what they own.
/// </summary>
public static partial class ShareEndpoints
{
    [GeneratedRegex("^[A-Za-z0-9_-]{6,64}$")]
    private static partial Regex IdPattern();

    public static void MapShareEndpoints(this IEndpointRouteBuilder app)
    {
        var shares = app.MapGroup("/shares").RequireAuthorization();

        // The client polls this; an unchanged catalog costs a 304.
        shares.MapGet("", async (HttpContext http, ClaimsPrincipal principal, Db db) =>
        {
            var list = await db.Run(sql => sql.List(principal.Current()));
            var body = JsonSerializer.SerializeToUtf8Bytes(list, ShareStore.Json);
            var etag = $"\"{Convert.ToHexStringLower(SHA256.HashData(body))[..16]}\"";
            http.Response.Headers.ETag = etag;
            if (http.Request.Headers.IfNoneMatch.ToString() == etag) return Results.StatusCode(StatusCodes.Status304NotModified);
            return Results.Bytes(body, "application/json");
        });

        shares.MapGet("/{id}", async (string id, HttpContext http, ClaimsPrincipal principal, Db db) =>
        {
            var share = await db.Run(sql => sql.Get(principal.Current(), id));
            if (share is null) return Results.NotFound(new BrokerError("This share no longer exists."));
            http.Response.Headers.ETag = Tag(share.Version);
            return Results.Ok(share);
        });

        // Create (unknown id, chosen by the client) or change (If-Match: the version it was read at).
        shares.MapPut("/{id}", async (string id, ShareInput input, HttpContext http, ClaimsPrincipal principal, Db db) =>
        {
            if (!IdPattern().IsMatch(id)) return Results.BadRequest(new BrokerError("Share ids are 6–64 letters, digits, - or _."));
            if (ShareStore.Validate(input) is { } invalid) return Results.BadRequest(new BrokerError(invalid));
            var me = principal.Current();
            var ifMatch = http.Request.Headers.IfMatch.ToString();
            return await db.Run(sql => sql.Transaction<IResult>(() =>
            {
                var owners = input.Owners is { Length: > 0 } given ? given.Distinct().ToArray() : null;
                if (owners is not null && sql.UnknownUsers(owners) is { } unknown)
                    return Results.BadRequest(new BrokerError($"Unknown owner (they need to sign in once first): {string.Join(", ", unknown)}"));

                var head = sql.Head(me, id);
                if (head is null)
                {
                    // The person sharing always owns what they share.
                    sql.Insert(me, id, input, [me.Id, .. (owners ?? []).Where(o => o != me.Id)]);
                    sql.Write(me.Id, id, Audit.ShareCreated, input.Name);
                }
                else
                {
                    var current = head.Value;
                    if (!current.CanEdit) return Forbidden();
                    if (string.IsNullOrEmpty(ifMatch))
                        return Results.Json(new BrokerError("Send If-Match with the version you edited."), statusCode: StatusCodes.Status428PreconditionRequired);
                    if (ifMatch != Tag(current.Version))
                        return Results.Json(new ShareConflict(current.Version, current.UpdatedBy, current.UpdatedAt), statusCode: StatusCodes.Status412PreconditionFailed);
                    sql.Update(me, id, input, owners);
                    sql.Write(me.Id, id, Audit.ShareUpdated, input.Name);
                }
                var saved = sql.Get(me, id)!;
                http.Response.Headers.ETag = Tag(saved.Version);
                return Results.Ok(saved);
            }));
        });

        shares.MapDelete("/{id}", async (string id, ClaimsPrincipal principal, Db db) =>
        {
            var me = principal.Current();
            return await db.Run(sql => sql.Transaction<IResult>(() =>
            {
                var head = sql.Head(me, id);
                if (head is null) return Results.NoContent();
                if (!head.Value.CanEdit) return Forbidden();
                var name = sql.Scalar<string>("select name from shares where id = $id", new { id });
                sql.Exec("delete from shares where id = $id", new { id });
                sql.Write(me.Id, id, Audit.ShareDeleted, name);
                return Results.NoContent();
            }));
        });

        // Write-only: there is no way to read a login back except fetching it to connect (audited).
        shares.MapPut("/{id}/login", async (string id, ShareLogin login, ClaimsPrincipal principal, Db db, LoginVault vault) =>
        {
            if (string.IsNullOrWhiteSpace(login.Username)) return Results.BadRequest(new BrokerError("The user name is missing."));
            var me = principal.Current();
            return await db.Run(sql => sql.Transaction<IResult>(() =>
            {
                var head = sql.Head(me, id);
                if (head is null) return Results.NotFound(new BrokerError("This share no longer exists."));
                if (!head.Value.CanEdit) return Forbidden();
                if (sql.Login(id)?.Mode != "included")
                    return Results.Conflict(new BrokerError("This share asks everyone for their own login; switch it to an included login first."));
                sql.SetLogin(me, id, login.Username.Trim(), vault.Seal(id, login.Password ?? ""));
                sql.Write(me.Id, id, Audit.LoginSet, login.Username.Trim());
                return Results.Ok(sql.Get(me, id));
            }));
        });

        shares.MapGet("/{id}/login", async (string id, HttpContext http, ClaimsPrincipal principal, Db db, LoginVault vault) =>
        {
            var me = principal.Current();
            http.Response.Headers.CacheControl = "no-store";
            return await db.Run<IResult>(sql =>
            {
                var login = sql.Login(id);
                if (login is null) return Results.NotFound(new BrokerError("This share no longer exists."));
                if (login.Value is not { Mode: "included", Username: { } username, Secret: { } secret })
                    return Results.Conflict(new BrokerError(login.Value.Mode == "own"
                        ? "This share asks for your own login."
                        : "The owner hasn't stored a login for this share yet."));
                sql.Write(me.Id, id, Audit.LoginFetched);
                return Results.Ok(new ShareLogin(username, vault.Open(id, secret)));
            });
        });

        shares.MapGet("/{id}/audit", async (string id, ClaimsPrincipal principal, Db db) =>
        {
            var me = principal.Current();
            return await db.Run<IResult>(sql =>
            {
                var head = sql.Head(me, id);
                if (head is null) return Results.NotFound(new BrokerError("This share no longer exists."));
                if (!head.Value.CanEdit) return Forbidden();
                return Results.Ok(sql.Query(
                    """
                    select a.at, a.action, a.detail, u.id, u.name, u.email
                    from audit a left join users u on u.id = a.user_id
                    where a.share_id = $id order by a.id desc limit 200
                    """,
                    r => new AuditEntry(
                        Sql.Time(r.Long("at")),
                        r.Str("id") is { } uid ? new PersonRef(uid, r.Str("name")!, r.Str("email")) : null,
                        r.Str("action")!,
                        r.Str("detail")),
                    new { id }));
            });
        });

        var me = app.MapGroup("/me").RequireAuthorization();
        me.MapGet("", async (ClaimsPrincipal principal, Db db) => await db.Run(sql => sql.Me(principal.Current().Id)));

        me.MapPut("/installs/{id}", async (string id, ClaimsPrincipal principal, Db db) =>
        {
            var user = principal.Current();
            return await db.Run<IResult>(sql =>
            {
                if (sql.Scalar<long>("select count(*) from shares where id = $id", new { id }) == 0)
                    return Results.NotFound(new BrokerError("This share no longer exists."));
                sql.Exec(
                    "insert into installs (user_id, share_id, installed_at) values ($uid, $id, $now) on conflict do nothing",
                    new { uid = user.Id, id, now = Sql.Now() });
                return Results.NoContent();
            });
        });

        me.MapDelete("/installs/{id}", async (string id, ClaimsPrincipal principal, Db db) =>
        {
            var user = principal.Current();
            await db.Run(sql => sql.Exec("delete from installs where user_id = $uid and share_id = $id", new { uid = user.Id, id }));
            return Results.NoContent();
        });

        // For picking co-owners.
        app.MapGet("/users", async (Db db) => await db.Run(sql => sql.All())).RequireAuthorization();
    }

    static string Tag(int version) => $"\"{version}\"";

    static IResult Forbidden() =>
        Results.Json(new BrokerError("Only the share's owners (or an admin) can change it."), statusCode: StatusCodes.Status403Forbidden);
}
