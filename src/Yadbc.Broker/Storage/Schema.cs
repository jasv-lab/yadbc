namespace Yadbc.Broker.Storage;

/// <summary>Forward-only migrations keyed by <c>pragma user_version</c>. Times are unix milliseconds (UTC).</summary>
static class Schema
{
    static readonly string[] Steps =
    [
        """
        create table users (
            id text primary key,
            name text not null,
            email text,
            is_admin integer not null default 0,
            created_at integer not null,
            last_login_at integer not null
        );
        create table devices (
            id text primary key,
            user_id text not null references users(id),
            name text not null,
            token_hash text not null unique,
            created_at integer not null,
            last_used_at integer not null,
            expires_at integer not null,
            revoked_at integer
        );
        create table shares (
            id text primary key,
            name text not null,
            host text not null,
            port integer not null,
            database text not null,
            env text not null,
            login_mode text not null,
            tunnel text,
            mcp_allowed integer not null,
            version integer not null,
            created_by text not null references users(id),
            created_at integer not null,
            updated_by text not null references users(id),
            updated_at integer not null,
            login_username text,
            login_secret blob
        );
        create table share_owners (
            share_id text not null references shares(id) on delete cascade,
            user_id text not null references users(id),
            primary key (share_id, user_id)
        );
        create table installs (
            user_id text not null references users(id),
            share_id text not null references shares(id) on delete cascade,
            installed_at integer not null,
            primary key (user_id, share_id)
        );
        -- No foreign keys: the trail outlives deleted shares.
        create table audit (
            id integer primary key,
            at integer not null,
            user_id text,
            share_id text,
            action text not null,
            detail text
        );
        create index audit_share on audit (share_id, id);
        """,
        """
        -- Team-wide settings (the AI assistant's endpoint and model; its key encrypted like share logins).
        create table settings (
            name text primary key,
            value text not null,
            secret blob,
            updated_by text not null references users(id),
            updated_at integer not null
        );
        """,
        """
        -- Shared snippets: with everyone who installed a share (share_id), or with the whole team (null).
        create table snippets (
            id text primary key,
            share_id text references shares(id) on delete cascade,
            name text not null,
            sql text not null,
            created_by text not null references users(id),
            updated_by text not null references users(id),
            updated_at integer not null
        );
        """,
    ];

    public static void Migrate(Sql sql)
    {
        var version = sql.Scalar<long>("pragma user_version");
        for (var i = (int)version; i < Steps.Length; i++)
            sql.Transaction(() => sql.Exec(Steps[i] + $"; pragma user_version = {i + 1}"));
    }
}
