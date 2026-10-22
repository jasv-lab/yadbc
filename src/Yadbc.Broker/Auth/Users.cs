using System.Security.Claims;
using Yadbc.Broker.Storage;
using Yadbc.Contracts.Broker;

namespace Yadbc.Broker.Auth;

/// <summary>The signed-in person behind a request (from their device token).</summary>
public sealed record CurrentUser(string Id, string Name, string? Email, bool IsAdmin, string DeviceId)
{
    public PersonRef Ref => new(Id, Name, Email);
}

public static class Users
{
    public const string IdClaim = "uid";
    public const string NameClaim = "name";
    public const string EmailClaim = "email";
    public const string AdminClaim = "admin";
    public const string DeviceClaim = "device";

    public static CurrentUser Current(this ClaimsPrincipal principal) =>
        new(
            principal.FindFirstValue(IdClaim) ?? throw new InvalidOperationException("Not signed in"),
            principal.FindFirstValue(NameClaim) ?? "",
            principal.FindFirstValue(EmailClaim),
            principal.FindFirstValue(AdminClaim) == "1",
            principal.FindFirstValue(DeviceClaim) ?? "");

    /// <summary>
    /// Who the identity provider says this is. Admin comes from the configured claim and is refreshed on
    /// every sign-in — so losing the role takes effect at the next sign-in, not mid-token.
    /// </summary>
    public static (string Id, string Name, string? Email, bool IsAdmin)? FromProvider(
        ClaimsPrincipal principal,
        BrokerOptions.OidcOptions oidc)
    {
        var id = oidc.IdClaims.Select(principal.FindFirstValue).FirstOrDefault(v => !string.IsNullOrEmpty(v));
        if (id is null) return null;
        var email = principal.FindFirstValue("email")
            ?? principal.FindFirstValue("preferred_username")
            ?? principal.FindFirstValue("upn");
        var name = principal.FindFirstValue("name") ?? email ?? id;
        var admin = principal.FindAll(oidc.AdminClaim).Any(c => c.Value == oidc.AdminValue);
        return (id, name, email, admin);
    }

    public static void Upsert(this Sql sql, string id, string name, string? email, bool isAdmin)
    {
        var now = Sql.Now();
        sql.Exec(
            """
            insert into users (id, name, email, is_admin, created_at, last_login_at)
            values ($id, $name, $email, $admin, $now, $now)
            on conflict (id) do update set name = $name, email = $email, is_admin = $admin, last_login_at = $now
            """,
            new { id, name, email, admin = isAdmin ? 1 : 0, now });
    }

    public static List<PersonRef> All(this Sql sql) =>
        sql.Query(
            "select id, name, email from users order by name collate nocase",
            r => new PersonRef(r.Str("id")!, r.Str("name")!, r.Str("email")));
}
