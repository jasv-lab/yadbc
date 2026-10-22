using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.WebUtilities;
using Yadbc.Broker.Shares;
using Yadbc.Broker.Storage;
using Yadbc.Contracts.Broker;

namespace Yadbc.Broker.Auth;

/// <summary>
/// Sign-in. The broker is the only OIDC client (one app registration, one fixed redirect URL); yadbc
/// never talks to the identity provider:
/// <list type="number">
/// <item>yadbc opens the system browser at <c>/login?redirect_uri=http://127.0.0.1:{port}/…&amp;code_challenge=…&amp;state=…</c></item>
/// <item>the broker runs the provider's code flow (cookie-held, minutes long), then redirects to yadbc's
///   local backend with a one-time code</item>
/// <item>yadbc posts the code and its PKCE verifier to <c>/token</c> and gets a device token</item>
/// </list>
/// The redirect may only go to a loopback address, so a code can't be sent anywhere else; PKCE makes
/// a code useless to anyone who sees it but didn't start the sign-in.
/// </summary>
public static class LoginFlow
{
    public const string Oidc = "oidc";
    public const string Cookie = "login";

    public static AuthenticationBuilder AddProviderSignIn(this AuthenticationBuilder auth, BrokerOptions options) =>
        auth.AddCookie(Cookie, o =>
            {
                // Only spans the trip to the provider and back.
                o.Cookie.Name = "yadbc-login";
                o.ExpireTimeSpan = TimeSpan.FromMinutes(10);
                o.SlidingExpiration = false;
            })
            .AddOpenIdConnect(Oidc, o =>
            {
                o.SignInScheme = Cookie;
                o.Authority = options.Oidc.Authority;
                o.ClientId = options.Oidc.ClientId;
                o.ClientSecret = options.Oidc.ClientSecret;
                o.ResponseType = "code";
                o.UsePkce = true;
                o.RequireHttpsMetadata = options.Oidc.RequireHttpsMetadata;
                o.CallbackPath = "/auth/callback";
                o.MapInboundClaims = false; // keep oid, roles, preferred_username as the provider names them
                o.GetClaimsFromUserInfoEndpoint = options.Oidc.UseUserInfo;
                o.SaveTokens = false;
                o.Scope.Clear();
                o.Scope.Add("openid");
                foreach (var s in options.Oidc.Scopes) o.Scope.Add(s);
                o.Events.OnRemoteFailure = context =>
                {
                    context.Response.StatusCode = StatusCodes.Status400BadRequest;
                    context.HandleResponse();
                    return Page(context.Response, "Sign-in failed", context.Failure?.Message ?? "The identity provider refused the sign-in.");
                };
            });

    public static void MapLoginFlow(this IEndpointRouteBuilder app)
    {
        app.MapGet("/login", (HttpContext http, string? redirect_uri, string? code_challenge, string? state) =>
        {
            if (Invalid(redirect_uri, code_challenge, state) is { } error)
                return Results.Content(PageHtml("Can't sign in", error), "text/html", Encoding.UTF8, 400);
            var complete = QueryHelpers.AddQueryString("/login/complete", new Dictionary<string, string?>
            {
                ["redirect_uri"] = redirect_uri,
                ["code_challenge"] = code_challenge,
                ["state"] = state,
            });
            return Results.Challenge(new AuthenticationProperties { RedirectUri = complete }, [Oidc]);
        });

        app.MapGet("/login/complete", async (
            HttpContext http,
            string? redirect_uri,
            string? code_challenge,
            string? state,
            Db db,
            BrokerOptions options,
            LoginCodes codes) =>
        {
            if (Invalid(redirect_uri, code_challenge, state) is { } error)
                return Results.Content(PageHtml("Can't sign in", error), "text/html", Encoding.UTF8, 400);
            var result = await http.AuthenticateAsync(Cookie);
            await http.SignOutAsync(Cookie);
            var who = result.Succeeded ? Users.FromProvider(result.Principal!, options.Oidc) : null;
            if (who is not { } person)
                return Results.Content(
                    PageHtml("Sign-in failed", "The identity provider didn't say who you are. Start again from yadbc."),
                    "text/html", Encoding.UTF8, 400);
            await db.Run(sql =>
            {
                sql.Upsert(person.Id, person.Name, person.Email, person.IsAdmin);
                sql.Write(person.Id, null, Audit.SignedIn);
            });
            var code = codes.Create(person.Id, code_challenge!);
            return Results.Redirect(QueryHelpers.AddQueryString(redirect_uri!, new Dictionary<string, string?>
            {
                ["code"] = code,
                ["state"] = state,
            }));
        });

        app.MapPost("/token", async (TokenRequest req, Db db, BrokerOptions options, LoginCodes codes) =>
        {
            if (codes.Redeem(req.Code, req.CodeVerifier) is not { } userId)
                return Results.BadRequest(new BrokerError("This sign-in has expired or was already used. Sign in again."));
            var response = await db.Run(sql =>
            {
                var (token, expires) = sql.Issue(userId, req.DeviceName, options.DeviceTokenDays);
                return new TokenResponse(token, expires, sql.Me(userId));
            });
            return Results.Ok(response);
        });
    }

    /// <summary>Loopback http with an explicit port; S256 challenge; a state to echo back.</summary>
    public static string? Invalid(string? redirectUri, string? challenge, string? state)
    {
        if (!Uri.TryCreate(redirectUri, UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttp
            || !(uri.IsLoopback && uri.Host is "127.0.0.1" or "localhost" or "[::1]")
            || uri.IsDefaultPort
            || !string.IsNullOrEmpty(uri.UserInfo)
            || !string.IsNullOrEmpty(uri.Fragment))
            return "Start the sign-in from yadbc: it must come back to the app on this computer.";
        if (challenge is not { Length: 43 } || challenge.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_')))
            return "The sign-in request is incomplete (code_challenge). Start again from yadbc.";
        if (string.IsNullOrEmpty(state) || state.Length > 200)
            return "The sign-in request is incomplete (state). Start again from yadbc.";
        return null;
    }

    static Task Page(HttpResponse response, string title, string message)
    {
        response.ContentType = "text/html; charset=utf-8";
        return response.WriteAsync(PageHtml(title, message));
    }

    static string PageHtml(string title, string message) =>
        $"""
        <!doctype html><meta charset="utf-8"><title>yadbc · {Esc(title)}</title>
        <body style="font:14px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#18181b">
        <h1 style="font-size:18px">{Esc(title)}</h1><p>{Esc(message)}</p></body>
        """;

    static string Esc(string s) => System.Net.WebUtility.HtmlEncode(s);
}

/// <summary>
/// One-time codes between the sign-in redirect and <c>/token</c>: two minutes, single use, PKCE-bound.
/// In memory — a broker restart in that window just means signing in again.
/// </summary>
public sealed class LoginCodes
{
    static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(2);
    readonly ConcurrentDictionary<string, (string UserId, string Challenge, DateTimeOffset Expires)> _codes = new();

    public string Create(string userId, string challenge)
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var (key, value) in _codes)
            if (value.Expires < now) _codes.TryRemove(key, out _);
        var code = DeviceTokens.Base64Url(RandomNumberGenerator.GetBytes(32));
        _codes[code] = (userId, challenge, now + Lifetime);
        return code;
    }

    /// <summary>The user id, or null when the code is unknown, used, expired or the verifier doesn't match.</summary>
    public string? Redeem(string code, string verifier)
    {
        if (!_codes.TryRemove(code ?? "", out var entry) || entry.Expires < DateTimeOffset.UtcNow) return null;
        var expected = DeviceTokens.Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier ?? "")));
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(entry.Challenge))
            ? entry.UserId
            : null;
    }
}
