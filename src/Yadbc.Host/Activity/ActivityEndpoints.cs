using System.Diagnostics;
using Npgsql;
using Yadbc.Host.Connections;
using Yadbc.Host.History;

namespace Yadbc.Host.Activity;

/// <summary>
/// Who is connected and what they're doing, who waits on whom, and cancel / terminate. Read over the
/// catalog pool (read-only, never a tab's session); the activity tab polls it every couple of seconds.
/// </summary>
public static class ActivityEndpoints
{
    public static void MapActivityEndpoints(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/activity/{connectionId}");

        api.MapGet("/", (string connectionId, DataSourceCache sources, CancellationToken ct) =>
            Guard(async () =>
            {
                await using var conn = await sources.OpenCatalogAsync(connectionId, ct);
                var sw = Stopwatch.StartNew();
                var sessions = await SessionsAsync(conn, ct);
                var locks = await LocksAsync(conn, ct);
                return Results.Ok(new { sessions, locks, pid = conn.ProcessID, ms = sw.ElapsedMilliseconds });
            }));

        // Which sessions wait on locks held by these (yadbc's own tab sessions), and the tabs' transaction age.
        api.MapPost("/blocked-by", (string connectionId, BlockedByRequest req, DataSourceCache sources, CancellationToken ct) =>
            Guard(async () =>
            {
                if (req.Pids is not { Length: > 0 }) return Results.Ok(new { blocked = Array.Empty<object>(), ours = Array.Empty<object>() });
                await using var conn = await sources.OpenCatalogAsync(connectionId, ct);
                var blocked = new List<object>();
                await using (var cmd = new NpgsqlCommand("""
                    select a.pid, a.usename, a.application_name, left(a.query, 500),
                           extract(epoch from now() - coalesce((select min((to_jsonb(l) ->> 'waitstart')::timestamptz) from pg_locks l
                                                               where l.pid = a.pid and not l.granted), a.state_change))::float8,
                           pg_blocking_pids(a.pid)
                    from pg_stat_activity a
                    where a.wait_event_type = 'Lock' and pg_blocking_pids(a.pid) && $1
                    """, conn) { Parameters = { new() { Value = req.Pids } } })
                await using (var r = await cmd.ExecuteReaderAsync(ct))
                    while (await r.ReadAsync(ct))
                        blocked.Add(new
                        {
                            pid = r.GetInt32(0),
                            user = r.IsDBNull(1) ? null : r.GetString(1),
                            application = r.IsDBNull(2) ? null : r.GetString(2),
                            query = r.IsDBNull(3) ? null : r.GetString(3),
                            waitSeconds = r.IsDBNull(4) ? 0 : Math.Round(r.GetDouble(4), 1),
                            blockedBy = r.GetFieldValue<int[]>(5),
                        });
                var ours = new List<object>();
                await using (var cmd = new NpgsqlCommand("""
                    select pid, state, extract(epoch from now() - xact_start)::float8 from pg_stat_activity where pid = any($1)
                    """, conn) { Parameters = { new() { Value = req.Pids } } })
                await using (var r = await cmd.ExecuteReaderAsync(ct))
                    while (await r.ReadAsync(ct))
                        ours.Add(new { pid = r.GetInt32(0), state = r.IsDBNull(1) ? null : r.GetString(1), xactSeconds = r.IsDBNull(2) ? (double?)null : Math.Round(r.GetDouble(2), 1) });
                return Results.Ok(new { blocked, ours });
            }));

        // pg_cancel_backend stops the running query; pg_terminate_backend ends the session (its open transaction
        // rolls back). Neither writes, so they work over the read-only catalog session. Recorded in history.
        api.MapPost("/{pid:int}/{action}",
            (string connectionId, int pid, string action, DataSourceCache sources, ConnectionStore store, HistoryStore history,
                CancellationToken ct) =>
                Guard(async () =>
                {
                    if (action is not ("cancel" or "terminate")) return Results.NotFound();
                    var profile = store.Get(connectionId) ?? throw new KeyNotFoundException($"Unknown connection '{connectionId}'");
                    await using var conn = await sources.OpenCatalogAsync(connectionId, ct);
                    var who = await DescribeAsync(conn, pid, ct);
                    var fn = action == "cancel" ? "pg_cancel_backend" : "pg_terminate_backend";
                    var started = DateTimeOffset.Now;
                    var sw = Stopwatch.StartNew();
                    try
                    {
                        await using var cmd = new NpgsqlCommand($"select {fn}($1)", conn) { Parameters = { new() { Value = pid } } };
                        var ok = (bool)(await cmd.ExecuteScalarAsync(ct))!;
                        Record(history, profile, $"select {fn}({pid}) -- {who}", started, sw, ok ? "ok" : "error",
                            ok ? null : "No such session (it may have just ended).");
                        return Results.Ok(new { ok, error = ok ? null : $"Session {pid} wasn't there any more." });
                    }
                    catch (PostgresException pg)
                    {
                        Record(history, profile, $"select {fn}({pid}) -- {who}", started, sw, "error", pg.MessageText);
                        throw;
                    }
                }));
    }

    public sealed record BlockedByRequest(int[] Pids);

    public sealed record Session(
        int Pid,
        string? Database,
        string? User,
        string? Application,
        string? Client,
        string BackendType,
        string? State,
        string? WaitType,
        string? Wait,
        double? BackendSeconds,
        double? XactSeconds,
        double? QuerySeconds,
        double? StateSeconds,
        int[] BlockedBy,
        string? Query,
        /// <summary>Whether this login may cancel / terminate it (own role, pg_signal_backend, or superuser).</summary>
        bool CanSignal);

    public sealed record Lock(int Pid, string LockType, string Mode, bool Granted, string? Relation, double? WaitSeconds);

    /// <summary>
    /// Client sessions and autovacuum workers on the whole server (the UI filters by database).
    /// pg_blocking_pids takes the lock manager's locks, so it's only called for sessions actually waiting on one.
    /// </summary>
    static async Task<List<Session>> SessionsAsync(NpgsqlConnection conn, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            with me as (
              select r.rolsuper as super, pg_has_role('pg_signal_backend', 'member') as signal
              from pg_roles r where r.rolname = current_user
            )
            select a.pid, a.datname, a.usename, a.application_name, host(a.client_addr), a.backend_type,
                   a.state, a.wait_event_type, a.wait_event,
                   extract(epoch from now() - a.backend_start)::float8,
                   extract(epoch from now() - a.xact_start)::float8,
                   extract(epoch from now() - a.query_start)::float8,
                   extract(epoch from now() - a.state_change)::float8,
                   case when a.wait_event_type = 'Lock' then pg_blocking_pids(a.pid) else '{}'::int[] end,
                   a.query,
                   case when me.super then true
                        when a.usesysid is null then false
                        when pg_has_role(a.usesysid, 'usage') then true
                        else me.signal and not coalesce(r.rolsuper, false) end
            from pg_stat_activity a
            cross join me
            left join pg_roles r on r.oid = a.usesysid
            where a.pid <> pg_backend_pid()
              and a.backend_type in ('client backend', 'autovacuum worker')
            order by a.pid
            limit 2000
            """, conn);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<Session>();
        while (await r.ReadAsync(ct))
            list.Add(new Session(
                r.GetInt32(0), Str(r, 1), Str(r, 2), Str(r, 3), Str(r, 4), r.GetString(5), Str(r, 6), Str(r, 7), Str(r, 8),
                Num(r, 9), Num(r, 10), Num(r, 11), Num(r, 12), r.GetFieldValue<int[]>(13), Str(r, 14), r.GetBoolean(15)));
        return list;
    }

    /// <summary>
    /// Locks in this database. Every transaction holds a lock on its own (virtual) transaction id; only the
    /// waits on those are interesting (row locks, CREATE INDEX CONCURRENTLY), so the granted ones are left out.
    /// waitstart only exists from PG 14 — read via jsonb so older servers still work.
    /// </summary>
    static async Task<List<Lock>> LocksAsync(NpgsqlConnection conn, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            select l.pid, l.locktype, l.mode, l.granted,
                   case when l.relation is not null then l.relation::regclass::text
                        when l.locktype = 'transactionid' then 'transaction ' || l.transactionid
                        when l.locktype = 'virtualxid' then 'transaction ' || l.virtualxid
                        when l.locktype = 'advisory' then 'advisory ' || l.classid || ':' || l.objid
                   end,
                   extract(epoch from now() - (to_jsonb(l) ->> 'waitstart')::timestamptz)::float8
            from pg_locks l
            where l.pid is not null and l.pid <> pg_backend_pid()
              and (l.database is null or l.database = (select oid from pg_database where datname = current_database()))
              and not (l.granted and l.locktype in ('virtualxid', 'transactionid'))
            order by l.granted, l.pid
            limit 2000
            """, conn);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<Lock>();
        while (await r.ReadAsync(ct))
            list.Add(new Lock(r.GetInt32(0), r.GetString(1), r.GetString(2), r.GetBoolean(3), Str(r, 4), Num(r, 5)));
        return list;
    }

    /// <summary>"user@app: query…" for the history entry, so the log says whose session it was.</summary>
    static async Task<string> DescribeAsync(NpgsqlConnection conn, int pid, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(
            "select coalesce(usename, backend_type) || '@' || coalesce(nullif(application_name, ''), '?') || ': ' || " +
            "coalesce(left(regexp_replace(query, '\\s+', ' ', 'g'), 200), '') from pg_stat_activity where pid = $1", conn)
        {
            Parameters = { new() { Value = pid } },
        };
        return (await cmd.ExecuteScalarAsync(ct)) as string ?? "session gone";
    }

    static void Record(HistoryStore history, ConnectionProfile profile, string sql, DateTimeOffset started, Stopwatch sw, string outcome, string? error) =>
        history.Record(new HistoryEntry(0, profile.Id, profile.Name, sql, started, sw.ElapsedMilliseconds, null, outcome, error, "activity"));

    static string? Str(NpgsqlDataReader r, int i) => r.IsDBNull(i) ? null : r.GetString(i);
    static double? Num(NpgsqlDataReader r, int i) => r.IsDBNull(i) ? null : Math.Round(r.GetDouble(i), 1);

    static async Task<IResult> Guard(Func<Task<IResult>> action)
    {
        try
        {
            return await action();
        }
        catch (Exception ex) when (ex is NpgsqlException or TimeoutException or KeyNotFoundException or ConnectException)
        {
            return Results.BadRequest(new { error = ex is PostgresException pg ? pg.MessageText : ex.Message });
        }
    }
}
