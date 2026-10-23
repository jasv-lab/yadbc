using System.Security.Claims;
using System.Text.Json;
using Yadbc.Broker.Auth;
using Yadbc.Broker.Shares;
using Yadbc.Broker.Storage;
using Yadbc.Contracts.Broker;

namespace Yadbc.Broker.Team;

/// <summary>
/// Settings for the whole team. Today one: the AI assistant's endpoint and model, optionally with the
/// key, so signing in to the broker is all it takes to have the assistant. Anyone signed in reads it;
/// only admins change it (one value for everyone shouldn't be anyone's to overwrite). The key is
/// write-only like a share login: fetched separately, encrypted at rest, every fetch audited.
/// </summary>
public static class TeamEndpoints
{
    const string Ai = "ai";
    const string KeyContext = "team:ai"; // AES-GCM associated data: the key only decrypts as this setting

    sealed record AiValue(string Endpoint, string Model, int MaxTokens);

    public static void MapTeamEndpoints(this IEndpointRouteBuilder app)
    {
        var team = app.MapGroup("/team").RequireAuthorization();

        // 204 = nothing shared (an old broker without this route answers 404: the app treats both as none).
        team.MapGet("/ai", async (Db db) =>
        {
            var current = await db.Run(Read);
            return current is null ? Results.NoContent() : Results.Ok(current);
        });

        team.MapPut("/ai", async (TeamAiInput input, ClaimsPrincipal principal, Db db, LoginVault vault) =>
        {
            var me = principal.Current();
            if (!me.IsAdmin) return Forbidden();
            if (string.IsNullOrWhiteSpace(input.Endpoint) || !Uri.TryCreate(input.Endpoint.Trim(), UriKind.Absolute, out _))
                return Results.BadRequest(new BrokerError("The endpoint must be a URL."));
            if (string.IsNullOrWhiteSpace(input.Model)) return Results.BadRequest(new BrokerError("The model is missing."));
            if (input.MaxTokens is < 1 or > 65536) return Results.BadRequest(new BrokerError("Max tokens must be 1–65536."));
            var value = JsonSerializer.Serialize(new AiValue(input.Endpoint.Trim(), input.Model.Trim(), input.MaxTokens), ShareStore.Json);
            var secret = string.IsNullOrEmpty(input.Key) ? null : vault.Seal(KeyContext, input.Key);
            return Results.Ok(await db.Run(sql =>
            {
                sql.Exec(
                    """
                    insert into settings (name, value, secret, updated_by, updated_at) values ($name, $value, $secret, $me, $now)
                    on conflict (name) do update set value = $value, secret = $secret, updated_by = $me, updated_at = $now
                    """,
                    new { name = Ai, value, secret, me = me.Id, now = Sql.Now() });
                sql.Write(me.Id, null, Audit.TeamAiShared, secret is null ? "without the key" : "with the key");
                return Read(sql);
            }));
        });

        team.MapDelete("/ai", async (ClaimsPrincipal principal, Db db) =>
        {
            var me = principal.Current();
            if (!me.IsAdmin) return Forbidden();
            await db.Run(sql =>
            {
                if (sql.Exec("delete from settings where name = $name", new { name = Ai }) > 0)
                    sql.Write(me.Id, null, Audit.TeamAiRemoved);
            });
            return Results.NoContent();
        });

        team.MapGet("/ai/key", async (HttpContext http, ClaimsPrincipal principal, Db db, LoginVault vault) =>
        {
            var me = principal.Current();
            http.Response.Headers.CacheControl = "no-store";
            return await db.Run<IResult>(sql =>
            {
                var secret = sql.Query("select secret from settings where name = $name", r => r.Bytes("secret"), new { name = Ai })
                    .FirstOrDefault();
                if (secret is null) return Results.Conflict(new BrokerError("The team's AI settings don't include a key: use your own."));
                sql.Write(me.Id, null, Audit.TeamAiKeyFetched);
                return Results.Ok(new TeamAiKey(vault.Open(KeyContext, secret)));
            });
        });
    }

    static TeamAi? Read(Sql sql) =>
        sql.One(
            """
            select s.value, s.secret is not null has_key, s.updated_at, u.id, u.name, u.email
            from settings s join users u on u.id = s.updated_by where s.name = $name
            """,
            r =>
            {
                var v = JsonSerializer.Deserialize<AiValue>(r.Str("value")!, ShareStore.Json)!;
                return new TeamAi(v.Endpoint, v.Model, v.MaxTokens, r.Bool("has_key"),
                    new PersonRef(r.Str("id")!, r.Str("name")!, r.Str("email")), Sql.Time(r.Long("updated_at")));
            },
            new { name = Ai });

    static IResult Forbidden() =>
        Results.Json(new BrokerError("Only an admin can change the team's AI settings."), statusCode: StatusCodes.Status403Forbidden);
}
