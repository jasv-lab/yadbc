using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using Yadbc.Broker.Storage;
using Yadbc.Contracts.Broker;

namespace Yadbc.Broker.Auth;

/// <summary>
/// The broker's own sign-in token, one per device. Opaque (256 random bits), stored only as a SHA-256
/// hash, valid for <see cref="BrokerOptions.DeviceTokenDays"/> since its last use. Long-lived on purpose:
/// a sign-in that keeps asking for 2FA sends people back to pasting connection strings into chat.
/// Not the provider's refresh token, whose lifetime and rules differ per provider.
/// </summary>
public static class DeviceTokens
{
    public const string Scheme = "device";
    const string Prefix = "ybt_";

    public static string Hash(string token) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    public static (string Token, DateTimeOffset ExpiresAt) Issue(this Sql sql, string userId, string deviceName, int days)
    {
        var token = Prefix + Base64Url(RandomNumberGenerator.GetBytes(32));
        var now = Sql.Now();
        var expires = now + (long)TimeSpan.FromDays(days).TotalMilliseconds;
        sql.Exec(
            """
            insert into devices (id, user_id, name, token_hash, created_at, last_used_at, expires_at)
            values ($id, $userId, $name, $hash, $now, $now, $expires)
            """,
            new
            {
                id = Base64Url(RandomNumberGenerator.GetBytes(9)),
                userId,
                name = deviceName.Trim() is { Length: > 0 } n ? n[..Math.Min(n.Length, 100)] : "yadbc",
                hash = Hash(token),
                now,
                expires,
            });
        return (token, Sql.Time(expires));
    }

    public static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static void MapDeviceEndpoints(this IEndpointRouteBuilder app)
    {
        var me = app.MapGroup("/me").RequireAuthorization();

        me.MapGet("/devices", async (ClaimsPrincipal principal, Db db) =>
        {
            var user = principal.Current();
            return await db.Run(sql => sql.Query(
                """
                select id, name, created_at, last_used_at, expires_at from devices
                where user_id = $uid and revoked_at is null and expires_at > $now
                order by last_used_at desc
                """,
                r => new Device(
                    r.Str("id")!,
                    r.Str("name")!,
                    Sql.Time(r.Long("created_at")),
                    Sql.Time(r.Long("last_used_at")),
                    Sql.Time(r.Long("expires_at")),
                    r.Str("id") == user.DeviceId),
                new { uid = user.Id, now = Sql.Now() }));
        });

        // Sign a device out (another one, or this one: that's sign-out).
        me.MapDelete("/devices/{id}", async (string id, ClaimsPrincipal principal, Db db) =>
        {
            var user = principal.Current();
            var n = await db.Run(sql => sql.Exec(
                "update devices set revoked_at = $now where id = $id and user_id = $uid and revoked_at is null",
                new { id, uid = user.Id, now = Sql.Now() }));
            return n > 0 ? Results.NoContent() : Results.NotFound();
        });
    }
}

public sealed class DeviceTokenHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    Db db,
    BrokerOptions broker) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    /// <summary>Extending the expiry on every request would write on every request; once an hour is plenty.</summary>
    static readonly long TouchEvery = (long)TimeSpan.FromHours(1).TotalMilliseconds;

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var header = Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.Ordinal)) return AuthenticateResult.NoResult();
        var hash = DeviceTokens.Hash(header["Bearer ".Length..].Trim());
        var now = Sql.Now();
        var found = await db.Run(sql =>
        {
            var row = sql.One(
                """
                select d.id device, d.last_used_at, u.id, u.name, u.email, u.is_admin
                from devices d join users u on u.id = d.user_id
                where d.token_hash = $hash and d.revoked_at is null and d.expires_at > $now
                """,
                r => new
                {
                    Device = r.Str("device")!,
                    LastUsed = r.Long("last_used_at"),
                    Id = r.Str("id")!,
                    Name = r.Str("name")!,
                    Email = r.Str("email"),
                    Admin = r.Bool("is_admin"),
                },
                new { hash, now });
            if (row is not null && now - row.LastUsed > TouchEvery)
                sql.Exec(
                    "update devices set last_used_at = $now, expires_at = $expires where id = $id",
                    new { now, expires = now + (long)TimeSpan.FromDays(broker.DeviceTokenDays).TotalMilliseconds, id = row.Device });
            return row;
        });
        if (found is null) return AuthenticateResult.Fail("Unknown, expired or revoked token");
        var claims = new List<Claim>
        {
            new(Users.IdClaim, found.Id),
            new(Users.NameClaim, found.Name),
            new(Users.AdminClaim, found.Admin ? "1" : "0"),
            new(Users.DeviceClaim, found.Device),
        };
        if (found.Email is not null) claims.Add(new Claim(Users.EmailClaim, found.Email));
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, DeviceTokens.Scheme));
        return AuthenticateResult.Success(new AuthenticationTicket(principal, DeviceTokens.Scheme));
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        return Response.WriteAsJsonAsync(new BrokerError("Sign in again"));
    }
}
