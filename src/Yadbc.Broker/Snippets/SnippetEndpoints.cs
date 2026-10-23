using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Yadbc.Broker.Auth;
using Yadbc.Broker.Shares;
using Yadbc.Broker.Storage;
using Yadbc.Contracts.Broker;

namespace Yadbc.Broker.Snippets;

/// <summary>
/// Shared snippets: saved statements that travel with a share (everyone who installed it gets them) or
/// go to the whole team. Anyone signed in can share one; its author, the share's owners and admins can
/// change or delete it. Last save wins: a snippet is one short text, not worth a version check.
/// </summary>
public static partial class SnippetEndpoints
{
    [GeneratedRegex("^[A-Za-z0-9_-]{6,64}$")]
    private static partial Regex IdPattern();

    const int MaxSql = 100_000;

    public static void MapSnippetEndpoints(this IEndpointRouteBuilder app)
    {
        var snippets = app.MapGroup("/snippets").RequireAuthorization();

        // Polled with the sync; unchanged costs a 304.
        snippets.MapGet("", async (HttpContext http, ClaimsPrincipal principal, Db db) =>
        {
            var list = await db.Run(sql => sql.List(principal.Current()));
            var body = JsonSerializer.SerializeToUtf8Bytes(list, ShareStore.Json);
            var etag = $"\"{Convert.ToHexStringLower(SHA256.HashData(body))[..16]}\"";
            http.Response.Headers.ETag = etag;
            if (http.Request.Headers.IfNoneMatch.ToString() == etag) return Results.StatusCode(StatusCodes.Status304NotModified);
            return Results.Bytes(body, "application/json");
        });

        // Create (unknown id, chosen by the client) or change.
        snippets.MapPut("/{id}", async (string id, SharedSnippetInput input, ClaimsPrincipal principal, Db db) =>
        {
            if (!IdPattern().IsMatch(id)) return Results.BadRequest(new BrokerError("Snippet ids are 6–64 letters, digits, - or _."));
            if (string.IsNullOrWhiteSpace(input.Name) || input.Name.Length > 100)
                return Results.BadRequest(new BrokerError("Give the snippet a name (up to 100 characters)."));
            if (string.IsNullOrWhiteSpace(input.Sql) || input.Sql.Length > MaxSql)
                return Results.BadRequest(new BrokerError($"A snippet needs SQL (up to {MaxSql:N0} characters)."));
            var me = principal.Current();
            return await db.Run(sql => sql.Transaction<IResult>(() =>
            {
                if (input.ShareId is { } shareId && sql.Scalar<long>("select count(*) from shares where id = $shareId", new { shareId }) == 0)
                    return Results.NotFound(new BrokerError("That shared connection no longer exists."));
                var existing = sql.List(me, id).FirstOrDefault();
                if (existing is { CanEdit: false }) return Forbidden();
                var name = input.Name.Trim();
                var values = new { id, shareId = input.ShareId, name, text = input.Sql, me = me.Id, now = Sql.Now() };
                if (existing is null)
                {
                    sql.Exec(
                        """
                        insert into snippets (id, share_id, name, sql, created_by, updated_by, updated_at)
                        values ($id, $shareId, $name, $text, $me, $me, $now)
                        """,
                        values);
                    sql.Write(me.Id, input.ShareId, Audit.SnippetShared, name);
                }
                else
                {
                    sql.Exec("update snippets set share_id = $shareId, name = $name, sql = $text, updated_by = $me, updated_at = $now where id = $id", values);
                    sql.Write(me.Id, input.ShareId, Audit.SnippetUpdated, name);
                }
                return Results.Ok(sql.List(me, id).Single());
            }));
        });

        snippets.MapDelete("/{id}", async (string id, ClaimsPrincipal principal, Db db) =>
        {
            var me = principal.Current();
            return await db.Run(sql => sql.Transaction<IResult>(() =>
            {
                if (sql.List(me, id).FirstOrDefault() is not { } existing) return Results.NoContent();
                if (!existing.CanEdit) return Forbidden();
                sql.Exec("delete from snippets where id = $id", new { id });
                sql.Write(me.Id, existing.ShareId, Audit.SnippetDeleted, existing.Name);
                return Results.NoContent();
            }));
        });
    }

    static List<SharedSnippet> List(this Sql sql, CurrentUser me, string? id = null) =>
        sql.Query(
            """
            select s.id, s.share_id, s.name, s.sql, s.updated_at,
                   a.id aid, a.name aname, a.email aemail, u.id uid, u.name uname, u.email uemail,
                   s.created_by = $me
                     or exists (select 1 from share_owners o where o.share_id = s.share_id and o.user_id = $me) can_edit
            from snippets s join users a on a.id = s.created_by join users u on u.id = s.updated_by
            where $id is null or s.id = $id
            order by s.name collate nocase
            """,
            r => new SharedSnippet(
                r.Str("id")!,
                r.Str("name")!,
                r.Str("sql")!,
                r.Str("share_id"),
                new PersonRef(r.Str("aid")!, r.Str("aname")!, r.Str("aemail")),
                new PersonRef(r.Str("uid")!, r.Str("uname")!, r.Str("uemail")),
                Sql.Time(r.Long("updated_at")),
                me.IsAdmin || r.Bool("can_edit")),
            new { me = me.Id, id });

    static IResult Forbidden() =>
        Results.Json(new BrokerError("Only its author, the connection’s owners or an admin can change this snippet."),
            statusCode: StatusCodes.Status403Forbidden);
}
