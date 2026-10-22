using System.Threading.Channels;
using Microsoft.Data.Sqlite;
using Yadbc.Host.Hosting;

namespace Yadbc.Host.History;

public sealed record HistoryEntry(
    long Id,
    string ConnectionId,
    string ConnectionName,
    string Sql,
    DateTimeOffset StartedAt,
    long DurationMs,
    long? Rows,
    /// <summary>"ok", "error" or "cancelled"</summary>
    string Outcome,
    string? Error,
    /// <summary>"run", "explain" or "explain-analyze"</summary>
    string Kind);

/// <summary>
/// Every executed statement, in SQLite at %APPDATA%\yadbc\yadbc.db. Writes go through a queue drained
/// by one background task, so recording never adds latency to a query; reads use their own connection.
/// </summary>
public sealed class HistoryStore : IAsyncDisposable
{
    /// <summary>Oldest entries beyond this are pruned (checked every few hundred writes).</summary>
    const int Keep = 50_000;

    readonly string _connectionString;
    readonly Channel<HistoryEntry> _queue = Channel.CreateUnbounded<HistoryEntry>(new() { SingleReader = true });
    readonly Task _writer;
    readonly ILogger<HistoryStore> _log;

    public HistoryStore(ILogger<HistoryStore> log)
    {
        _log = log;
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(AppPaths.DataDir, "yadbc.db"),
            Cache = SqliteCacheMode.Shared,
        }.ToString();
        using (var conn = Open())
        using (var cmd = conn.CreateCommand())
        {
            // WAL: the writer and the history list don't block each other.
            cmd.CommandText = """
                pragma journal_mode = wal;
                create table if not exists history (
                    id              integer primary key,
                    connection_id   text not null,
                    connection_name text not null,
                    sql             text not null,
                    started_at      text not null,
                    duration_ms     integer not null,
                    rows            integer,
                    outcome         text not null,
                    error           text,
                    kind            text not null
                );
                create index if not exists history_connection on history (connection_id, id desc);
                """;
            cmd.ExecuteNonQuery();
        }
        _writer = Task.Run(WriteLoopAsync);
    }

    SqliteConnection Open()
    {
        var conn = new SqliteConnection(_connectionString);
        conn.Open();
        return conn;
    }

    /// <summary>Fire and forget; the entry is written shortly after.</summary>
    public void Record(HistoryEntry entry) => _queue.Writer.TryWrite(entry);

    async Task WriteLoopAsync()
    {
        var written = 0;
        await foreach (var e in _queue.Reader.ReadAllAsync())
        {
            try
            {
                await using var conn = Open();
                await using var cmd = conn.CreateCommand();
                cmd.CommandText = """
                    insert into history (connection_id, connection_name, sql, started_at, duration_ms, rows, outcome, error, kind)
                    values ($cid, $cname, $sql, $at, $ms, $rows, $outcome, $error, $kind)
                    """;
                cmd.Parameters.AddWithValue("$cid", e.ConnectionId);
                cmd.Parameters.AddWithValue("$cname", e.ConnectionName);
                cmd.Parameters.AddWithValue("$sql", e.Sql);
                cmd.Parameters.AddWithValue("$at", e.StartedAt.ToString("O"));
                cmd.Parameters.AddWithValue("$ms", e.DurationMs);
                cmd.Parameters.AddWithValue("$rows", (object?)e.Rows ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$outcome", e.Outcome);
                cmd.Parameters.AddWithValue("$error", (object?)e.Error ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$kind", e.Kind);
                await cmd.ExecuteNonQueryAsync();

                if (++written % 500 == 0)
                {
                    cmd.Parameters.Clear();
                    cmd.CommandText = $"delete from history where id <= (select id from history order by id desc limit 1 offset {Keep})";
                    await cmd.ExecuteNonQueryAsync();
                }
            }
            catch (SqliteException ex)
            {
                // History is a convenience: never let it break querying.
                _log.LogWarning(ex, "Could not record history");
            }
        }
    }

    /// <summary>Newest first; `before` pages by id; `search` matches anywhere in the SQL (case-insensitive).</summary>
    public async Task<List<HistoryEntry>> ListAsync(string? connectionId, string? search, long? before, int limit, CancellationToken ct)
    {
        await using var conn = Open();
        await using var cmd = conn.CreateCommand();
        var where = new List<string>();
        if (connectionId is not null)
        {
            where.Add("connection_id = $cid");
            cmd.Parameters.AddWithValue("$cid", connectionId);
        }
        if (!string.IsNullOrWhiteSpace(search))
        {
            // instr(lower()) instead of LIKE: no escaping of % and _ in what people search for.
            where.Add("instr(lower(sql), lower($q)) > 0");
            cmd.Parameters.AddWithValue("$q", search.Trim());
        }
        if (before is not null)
        {
            where.Add("id < $before");
            cmd.Parameters.AddWithValue("$before", before);
        }
        cmd.CommandText = $"""
            select id, connection_id, connection_name, sql, started_at, duration_ms, rows, outcome, error, kind
            from history {(where.Count > 0 ? "where " + string.Join(" and ", where) : "")}
            order by id desc limit {Math.Clamp(limit, 1, 500)}
            """;
        var list = new List<HistoryEntry>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
            list.Add(new HistoryEntry(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetString(3),
                DateTimeOffset.Parse(r.GetString(4)), r.GetInt64(5), r.IsDBNull(6) ? null : r.GetInt64(6),
                r.GetString(7), r.IsDBNull(8) ? null : r.GetString(8), r.GetString(9)));
        return list;
    }

    public async Task<bool> DeleteAsync(long id, CancellationToken ct)
    {
        await using var conn = Open();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "delete from history where id = $id";
        cmd.Parameters.AddWithValue("$id", id);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    public async ValueTask DisposeAsync()
    {
        _queue.Writer.TryComplete();
        await _writer;
    }
}

public static class HistoryEndpoints
{
    public static void MapHistoryEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/history", (string? connectionId, string? q, long? before, int? limit, HistoryStore history, CancellationToken ct) =>
            history.ListAsync(connectionId, q, before, limit ?? 100, ct));

        app.MapDelete("/api/history/{id:long}", async (long id, HistoryStore history, CancellationToken ct) =>
            await history.DeleteAsync(id, ct) ? Results.NoContent() : Results.NotFound());
    }
}
