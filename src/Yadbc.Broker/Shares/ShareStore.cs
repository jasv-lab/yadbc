using System.Text.Json;
using System.Text.Json.Serialization;
using Yadbc.Broker.Auth;
using Yadbc.Broker.Storage;
using Yadbc.Contracts.Broker;

namespace Yadbc.Broker.Shares;

/// <summary>Reads and writes of shares, owners and installs. Callers run these inside <see cref="Db.Run{T}"/>.</summary>
public static class ShareStore
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    /// <summary>The catalog as this person sees it (or one share).</summary>
    public static List<Share> List(this Sql sql, CurrentUser me, string? id = null)
    {
        var owners = sql.Query(
                """
                select o.share_id, u.id, u.name, u.email from share_owners o join users u on u.id = o.user_id
                where $id is null or o.share_id = $id
                order by u.name collate nocase
                """,
                r => (Share: r.Str("share_id")!, Person: new PersonRef(r.Str("id")!, r.Str("name")!, r.Str("email"))),
                new { id })
            .ToLookup(x => x.Share, x => x.Person);
        return sql.Query(
            """
            select s.id, s.name, s.host, s.port, s.database, s.env, s.login_mode, s.tunnel, s.mcp_allowed, s.version,
                   s.updated_at, s.login_username, s.login_secret is not null has_login,
                   u.id uid, u.name uname, u.email uemail,
                   (select count(*) from installs i where i.share_id = s.id) installs,
                   exists (select 1 from installs i where i.share_id = s.id and i.user_id = $me) mine,
                   exists (select 1 from share_owners o where o.share_id = s.id and o.user_id = $me) owner
            from shares s join users u on u.id = s.updated_by
            where $id is null or s.id = $id
            order by s.name collate nocase
            """,
            r =>
            {
                var shareId = r.Str("id")!;
                var mode = Enum.Parse<LoginMode>(r.Str("login_mode")!, ignoreCase: true);
                return new Share(
                    shareId,
                    r.Str("name")!,
                    r.Str("host")!,
                    (int)r.Long("port"),
                    r.Str("database")!,
                    Enum.Parse<ShareEnv>(r.Str("env")!, ignoreCase: true),
                    mode,
                    r.Str("tunnel") is { } t ? JsonSerializer.Deserialize<ShareTunnel>(t, Json) : null,
                    r.Bool("mcp_allowed"),
                    owners[shareId].ToArray(),
                    (int)r.Long("version"),
                    new PersonRef(r.Str("uid")!, r.Str("uname")!, r.Str("uemail")),
                    Sql.Time(r.Long("updated_at")),
                    mode == LoginMode.Included ? r.Str("login_username") : null,
                    r.Bool("has_login"),
                    (int)r.Long("installs"),
                    r.Bool("mine"),
                    me.IsAdmin || r.Bool("owner"));
            },
            new { me = me.Id, id });
    }

    public static Share? Get(this Sql sql, CurrentUser me, string id) => sql.List(me, id).FirstOrDefault();

    /// <summary>Required fields and sane values; the message is shown in yadbc as-is.</summary>
    public static string? Validate(ShareInput s)
    {
        if (string.IsNullOrWhiteSpace(s.Name) || s.Name.Length > 100) return "Give the connection a name (up to 100 characters).";
        if (string.IsNullOrWhiteSpace(s.Host) || s.Host.Length > 255) return "The host is missing.";
        if (s.Port is < 1 or > 65535) return "The port must be 1–65535.";
        if (string.IsNullOrWhiteSpace(s.Database) || s.Database.Length > 255) return "The database is missing.";
        if (s.Tunnel is { Kind: TunnelKind.Ssh, SshHost: null or "" }) return "An SSH tunnel needs its host.";
        if (s.Tunnel is { Kind: TunnelKind.Kubernetes, KubeTarget: null or "" }) return "A Kubernetes tunnel needs its target (svc/name, pod/name…).";
        return null;
    }

    public static (int Version, bool CanEdit, PersonRef UpdatedBy, DateTimeOffset UpdatedAt)? Head(this Sql sql, CurrentUser me, string id) =>
        sql.Query(
            """
            select s.version, s.updated_at, u.id, u.name, u.email,
                   exists (select 1 from share_owners o where o.share_id = s.id and o.user_id = $me) owner
            from shares s join users u on u.id = s.updated_by where s.id = $id
            """,
            r => ((int)r.Long("version"), me.IsAdmin || r.Bool("owner"),
                new PersonRef(r.Str("id")!, r.Str("name")!, r.Str("email")), Sql.Time(r.Long("updated_at"))),
            new { me = me.Id, id })
        is [var head] ? head : null;

    public static void Insert(this Sql sql, CurrentUser me, string id, ShareInput s, string[] owners)
    {
        var now = Sql.Now();
        sql.Exec(
            """
            insert into shares (id, name, host, port, database, env, login_mode, tunnel, mcp_allowed, version,
                                created_by, created_at, updated_by, updated_at)
            values ($id, $name, $host, $port, $database, $env, $mode, $tunnel, $mcp, 1, $me, $now, $me, $now)
            """,
            Columns(id, s, me, now));
        SetOwners(sql, id, owners);
    }

    /// <summary>Switching to "everyone brings their own login" drops the stored one.</summary>
    public static void Update(this Sql sql, CurrentUser me, string id, ShareInput s, string[]? owners)
    {
        sql.Exec(
            """
            update shares set name = $name, host = $host, port = $port, database = $database, env = $env,
                login_mode = $mode, tunnel = $tunnel, mcp_allowed = $mcp, version = version + 1,
                updated_by = $me, updated_at = $now,
                login_username = case when $mode = 'own' then null else login_username end,
                login_secret = case when $mode = 'own' then null else login_secret end
            where id = $id
            """,
            Columns(id, s, me, Sql.Now()));
        if (owners is not null) SetOwners(sql, id, owners);
    }

    static object Columns(string id, ShareInput s, CurrentUser me, long now) => new
    {
        id,
        name = s.Name.Trim(),
        host = s.Host.Trim(),
        port = s.Port,
        database = s.Database.Trim(),
        env = Lower(s.Env),
        mode = Lower(s.LoginMode),
        tunnel = s.Tunnel is null ? null : JsonSerializer.Serialize(s.Tunnel, Json),
        mcp = s.McpAllowed ? 1 : 0,
        me = me.Id,
        now,
    };

    static string Lower<T>(T value) where T : Enum => JsonNamingPolicy.CamelCase.ConvertName(value.ToString());

    static void SetOwners(Sql sql, string id, string[] owners)
    {
        sql.Exec("delete from share_owners where share_id = $id", new { id });
        foreach (var user in owners)
            sql.Exec("insert into share_owners (share_id, user_id) values ($id, $user)", new { id, user });
    }

    /// <summary>Owners must be people who signed in at least once (that's how the broker knows them).</summary>
    public static string[]? UnknownUsers(this Sql sql, IEnumerable<string> ids) =>
        ids.Where(id => sql.Scalar<long>("select count(*) from users where id = $id", new { id }) == 0).ToArray() is { Length: > 0 } unknown
            ? unknown
            : null;

    public static void SetLogin(this Sql sql, CurrentUser me, string id, string username, byte[] secret) =>
        sql.Exec(
            """
            update shares set login_username = $username, login_secret = $secret, version = version + 1,
                updated_by = $me, updated_at = $now
            where id = $id
            """,
            new { id, username, secret, me = me.Id, now = Sql.Now() });

    public static (string Mode, string? Username, byte[]? Secret)? Login(this Sql sql, string id) =>
        sql.Query(
            "select login_mode, login_username, login_secret from shares where id = $id",
            r => (r.Str("login_mode")!, r.Str("login_username"), r.Bytes("login_secret")),
            new { id })
        is [var row] ? row : null;

    public static Me Me(this Sql sql, string userId)
    {
        var user = sql.One(
            "select id, name, email, is_admin from users where id = $userId",
            r => new { Ref = new PersonRef(r.Str("id")!, r.Str("name")!, r.Str("email")), Admin = r.Bool("is_admin") },
            new { userId })!;
        var installs = sql.Query(
            "select share_id from installs where user_id = $userId order by installed_at",
            r => r.Str("share_id")!,
            new { userId });
        return new Me(user.Ref, user.Admin, installs.ToArray());
    }
}
