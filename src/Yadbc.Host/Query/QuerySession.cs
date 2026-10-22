using System.Diagnostics;
using Npgsql;
using Yadbc.Host.Connections;
using Yadbc.Host.Editing;
using Yadbc.Host.Export;
using Yadbc.Host.History;

namespace Yadbc.Host.Query;

public sealed record Statement(string Sql, int Offset);

/// <summary>
/// One editor tab = one dedicated server session. Transaction state, SET, temp tables and
/// search_path are per session, and per tab is how you think about them.
/// </summary>
/// <param name="transportAlive">False when the connection's tunnel has died since the session connected.</param>
public sealed class QuerySession(
    string tabId,
    ConnectionProfile profile,
    Func<CancellationToken, Task<NpgsqlConnection>> open,
    HistoryStore? history = null,
    Func<bool>? transportAlive = null)
    : IAsyncDisposable
{
    public const int DefaultRowCap = 10_000;
    /// <summary>Rows are capped by count, but a few huge jsonb/text values per row must not eat the machine either.</summary>
    public const long MaxBufferBytes = 256L * 1024 * 1024;
    const int FirstBatchRows = 100;
    static readonly TimeSpan ProgressInterval = TimeSpan.FromMilliseconds(250);

    NpgsqlConnection? _conn;
    CancellationTokenSource? _runCts;
    // Prod starts read-only; the tab's lock toggles it. Re-applied whenever the connection is reopened.
    bool _readOnly = profile.Env == ConnectionEnv.Prod;

    public string TabId { get; } = tabId;
    public ConnectionProfile Profile { get; } = profile;
    public bool IsRunning => _runCts is not null;
    public int RowCap { get; init; } = DefaultRowCap;

    public event Action<string, string>? Notice;

    public async Task<object> OpenAsync(CancellationToken ct)
    {
        var conn = await EnsureOpenAsync(ct);
        return Info(conn);
    }

    object Info(NpgsqlConnection conn) =>
        new { serverVersion = conn.PostgreSqlVersion.ToString(), pid = conn.ProcessID, readOnly = _readOnly };

    /// <summary>
    /// Opens (or reopens after a drop) the tab's connection. Read-only is enforced by the server —
    /// even `SELECT purge()` can't write — and must survive a reconnect.
    /// </summary>
    async Task<NpgsqlConnection> EnsureOpenAsync(CancellationToken ct)
    {
        // A connection whose tunnel died while the tab sat idle still *looks* open; reconnect before
        // running instead of failing the run — and say what was lost.
        var tunnelDropped = _conn is { State: System.Data.ConnectionState.Open } && transportAlive?.Invoke() == false;
        if (_conn is { State: System.Data.ConnectionState.Open } && !tunnelDropped) return _conn;
        var reconnecting = _conn is not null;
        if (_conn is not null) await _conn.DisposeAsync();
        _conn = await open(ct);
        _conn.Notice += (_, e) => Notice?.Invoke(e.Notice.Severity, e.Notice.MessageText);
        if (_readOnly) await ExecAsync(_conn, "SET default_transaction_read_only = on", ct);
        if (reconnecting)
            Notice?.Invoke("NOTICE", "Reconnected — the connection had dropped. Session settings, temp tables and any open transaction from before are gone.");
        return _conn;
    }

    /// <summary>A dropped connection (tunnel, VPN, server restart) in words, instead of Npgsql's stream errors.</summary>
    string Describe(Exception ex) =>
        _conn is null || _conn.FullState.HasFlag(System.Data.ConnectionState.Broken) || _conn.State != System.Data.ConnectionState.Open
            ? $"Lost the connection to the server{(Profile.Tunnel is null ? "" : " (through the " + Profile.Tunnel.Kind + " tunnel)")}. It reconnects on the next run. ({ex.Message})"
            : ex.Message;

    static async Task ExecAsync(NpgsqlConnection conn, string sql, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(sql, conn);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    /// <summary>The tab's lock: one click, no ceremony; the server does the enforcing.</summary>
    public async Task<object> SetReadOnlyAsync(bool readOnly, CancellationToken ct)
    {
        if (IsRunning) throw new InvalidOperationException("A query is running in this tab");
        var conn = await EnsureOpenAsync(ct);
        await ExecAsync(conn, $"SET default_transaction_read_only = {(readOnly ? "on" : "off")}", ct);
        _readOnly = readOnly;
        return Info(conn);
    }

    public void Cancel() => _runCts?.Cancel();

    /// <summary>
    /// COMMIT or ROLLBACK the tab's open transaction without touching its results — for the "your tab is
    /// blocking others" banner. Recorded in history like any statement.
    /// </summary>
    public async Task<object> EndTransactionAsync(bool commit, CancellationToken ct)
    {
        if (IsRunning) throw new InvalidOperationException("A query is running in this tab");
        var conn = await EnsureOpenAsync(ct);
        var sql = commit ? "COMMIT" : "ROLLBACK";
        var started = DateTimeOffset.Now;
        var sw = Stopwatch.StartNew();
        await ExecAsync(conn, sql, ct);
        Record(sql, started, sw.ElapsedMilliseconds, null, "ok", null, "run");
        return Info(conn);
    }

    /// <summary>
    /// Runs statements one by one (stop on first error). Statements are split client-side so an error
    /// position can be mapped back to the editor via <see cref="Statement.Offset"/>.
    /// </summary>
    public async Task RunAsync(string runId, IReadOnlyList<Statement> statements, Func<ResultBuffer, Task> onResult,
        Func<object, Task> emit, CancellationToken socketCt)
    {
        _runCts = CancellationTokenSource.CreateLinkedTokenSource(socketCt);
        var ct = _runCts.Token;
        var total = Stopwatch.StartNew();
        // The statement in flight, so a cancel or a broken connection is recorded against it.
        Statement? current = null;
        var started = DateTimeOffset.Now;
        var sw = Stopwatch.StartNew();
        try
        {
            await EnsureOpenAsync(ct);

            for (var index = 0; index < statements.Count; index++)
            {
                var stmt = statements[index];
                await using var batch = new NpgsqlBatch(_conn) { BatchCommands = { new NpgsqlBatchCommand(stmt.Sql) } };
                current = stmt;
                started = DateTimeOffset.Now;
                sw.Restart();
                long? rows = null;

                try
                {
                    await using (var reader = await batch.ExecuteReaderAsync(ct))
                    {
                        if (reader.FieldCount > 0)
                            rows = await ReadResultAsync(reader, runId, index, sw, onResult, emit, ct);
                    }
                }
                catch (PostgresException pg) when (pg.SqlState != PostgresErrorCodes.QueryCanceled)
                {
                    Record(stmt.Sql, started, sw.ElapsedMilliseconds, null, "error", pg.MessageText, "run");
                    await emit(new
                    {
                        ev = "run-finished", tabId = TabId, runId, ok = false, cancelled = false,
                        elapsedMs = total.ElapsedMilliseconds,
                        error = new
                        {
                            statementIndex = index,
                            pg.SqlState, pg.MessageText, pg.Detail, pg.Hint, pg.Where,
                            // Postgres positions are 1-based within the statement; make it absolute in the editor.
                            position = pg.Position > 0 ? stmt.Offset + pg.Position - 1 : (int?)null,
                        },
                    });
                    return;
                }

                var bc = batch.BatchCommands[0];
                if (bc.StatementType != StatementType.Select)
                {
                    rows ??= bc.RecordsAffected >= 0 ? bc.RecordsAffected : null;
                    await emit(new
                    {
                        ev = "command", tabId = TabId, runId, index,
                        tag = CommandTag(bc), elapsedMs = sw.ElapsedMilliseconds,
                    });
                }
                Record(stmt.Sql, started, sw.ElapsedMilliseconds, rows, "ok", null, "run");
                current = null;
            }

            await emit(new { ev = "run-finished", tabId = TabId, runId, ok = true, cancelled = false, elapsedMs = total.ElapsedMilliseconds });
        }
        catch (Exception ex) when (ex is OperationCanceledException || ex is PostgresException { SqlState: PostgresErrorCodes.QueryCanceled })
        {
            if (current is not null) Record(current.Sql, started, sw.ElapsedMilliseconds, null, "cancelled", null, "run");
            if (socketCt.IsCancellationRequested) return;
            await emit(new { ev = "run-finished", tabId = TabId, runId, ok = false, cancelled = true, elapsedMs = total.ElapsedMilliseconds });
        }
        catch (Exception ex) when (ex is NpgsqlException or TimeoutException or InvalidOperationException or ConnectException)
        {
            var message = ex is ConnectException ? ex.Message : Describe(ex);
            if (current is not null) Record(current.Sql, started, sw.ElapsedMilliseconds, null, "error", message, "run");
            await emit(new
            {
                ev = "run-finished", tabId = TabId, runId, ok = false, cancelled = false, elapsedMs = total.ElapsedMilliseconds,
                error = new { messageText = message },
            });
        }
        finally
        {
            _runCts.Dispose();
            _runCts = null;
        }
    }

    /// <returns>Rows the statement returned (all of them, past the cap too).</returns>
    async Task<long> ReadResultAsync(NpgsqlDataReader reader, string runId, int index, Stopwatch sw,
        Func<ResultBuffer, Task> onResult, Func<object, Task> emit, CancellationToken ct)
    {
        // Without CommandBehavior.KeyInfo this reads only the row description (no catalog round trip).
        var schema = reader.GetColumnSchema();
        var columns = Enumerable.Range(0, reader.FieldCount)
            .Select(i => new ColumnInfo(reader.GetName(i), reader.GetPostgresType(i).InternalName,
                schema[i].TableOID, schema[i].ColumnAttributeNumber ?? 0, schema[i].TypeOID))
            .ToArray();
        var typeNames = columns.Select(c => c.Type).ToArray();

        var buffer = new ResultBuffer(Guid.NewGuid().ToString("n")[..16], TabId, Profile.Id, columns);
        await onResult(buffer);
        await emit(new { ev = "result", tabId = TabId, runId, index, resultId = buffer.Id, columns });

        var queryMs = sw.ElapsedMilliseconds;
        long total = 0;
        long bytes = 0;
        var firstSent = false;
        var lastProgress = Stopwatch.StartNew();

        while (await reader.ReadAsync(ct))
        {
            total++;
            // Past the cap rows are still drained (counted, not materialized): the honest total costs little,
            // and leaving the reader open would hold the session and its locks.
            if (total > RowCap || bytes > MaxBufferBytes) continue;

            var row = new string?[typeNames.Length];
            for (var i = 0; i < row.Length; i++)
            {
                row[i] = ValueFormatter.Format(reader, i, typeNames[i]);
                bytes += 2L * (row[i]?.Length ?? 0) + 24;
            }
            buffer.Add(row);

            if ((!firstSent && total == FirstBatchRows) || (firstSent && lastProgress.Elapsed > ProgressInterval))
            {
                firstSent = true;
                lastProgress.Restart();
                await emit(new { ev = "result-progress", resultId = buffer.Id, rowCount = buffer.Count, done = false });
            }
        }

        buffer.Complete(total, total > buffer.Count);
        await emit(new
        {
            ev = "result-progress", resultId = buffer.Id, rowCount = buffer.Count, done = true,
            totalRows = total, capped = buffer.Capped, queryMs, fetchMs = sw.ElapsedMilliseconds - queryMs,
        });
        return total;
    }

    void Record(string sql, DateTimeOffset started, long ms, long? rows, string outcome, string? error, string kind) =>
        history?.Record(new HistoryEntry(0, Profile.Id, Profile.Name, sql, started, ms, rows, outcome, error, kind));

    /// <summary>
    /// EXPLAIN as JSON for the visual plan. ANALYZE really executes the statement, so it always runs inside a
    /// transaction that is rolled back — a savepoint when the tab already has one open — whatever the statement
    /// looks like (`SELECT purge()` writes too). Sequence increments and external side effects can't be undone.
    /// </summary>
    public async Task ExplainAsync(string runId, Statement stmt, bool analyze, Func<object, Task> emit, CancellationToken socketCt)
    {
        _runCts = CancellationTokenSource.CreateLinkedTokenSource(socketCt);
        var ct = _runCts.Token;
        var total = Stopwatch.StartNew();
        var prefix = analyze ? "EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) " : "EXPLAIN (SETTINGS, FORMAT JSON) ";
        var kind = analyze ? "explain-analyze" : "explain";
        var started = DateTimeOffset.Now;
        bool? savepoint = null;
        try
        {
            var conn = await EnsureOpenAsync(ct);
            if (analyze)
            {
                try
                {
                    await ExecAsync(conn, "SAVEPOINT yadbc_explain", ct);
                    savepoint = true;
                }
                catch (PostgresException pg) when (pg.SqlState == PostgresErrorCodes.NoActiveSqlTransaction)
                {
                    await ExecAsync(conn, "BEGIN", ct);
                    savepoint = false;
                }
            }

            string plan;
            try
            {
                await using var cmd = new NpgsqlCommand(prefix + stmt.Sql, conn);
                plan = (string)(await cmd.ExecuteScalarAsync(ct))!;
            }
            catch (PostgresException pg) when (pg.SqlState != PostgresErrorCodes.QueryCanceled)
            {
                Record(stmt.Sql, started, total.ElapsedMilliseconds, null, "error", pg.MessageText, kind);
                await UndoExplainAsync(conn, savepoint);
                await emit(new
                {
                    ev = "run-finished", tabId = TabId, runId, ok = false, cancelled = false, elapsedMs = total.ElapsedMilliseconds,
                    error = new
                    {
                        statementIndex = 0,
                        pg.SqlState, pg.MessageText, pg.Detail, pg.Hint, pg.Where,
                        // Positions count from the start of the EXPLAIN command; map back into the editor.
                        position = pg.Position > prefix.Length ? stmt.Offset + pg.Position - prefix.Length - 1 : (int?)null,
                    },
                });
                return;
            }

            await UndoExplainAsync(conn, savepoint);
            Record(stmt.Sql, started, total.ElapsedMilliseconds, null, "ok", null, kind);
            await emit(new { ev = "plan", tabId = TabId, runId, analyze, plan, rolledBack = savepoint is not null });
            await emit(new { ev = "run-finished", tabId = TabId, runId, ok = true, cancelled = false, elapsedMs = total.ElapsedMilliseconds });
        }
        catch (Exception ex) when (ex is OperationCanceledException || ex is PostgresException { SqlState: PostgresErrorCodes.QueryCanceled })
        {
            if (_conn is { State: System.Data.ConnectionState.Open } c) await UndoExplainAsync(c, savepoint);
            Record(stmt.Sql, started, total.ElapsedMilliseconds, null, "cancelled", null, kind);
            if (socketCt.IsCancellationRequested) return;
            await emit(new { ev = "run-finished", tabId = TabId, runId, ok = false, cancelled = true, elapsedMs = total.ElapsedMilliseconds });
        }
        catch (Exception ex) when (ex is NpgsqlException or TimeoutException or InvalidOperationException)
        {
            await emit(new
            {
                ev = "run-finished", tabId = TabId, runId, ok = false, cancelled = false, elapsedMs = total.ElapsedMilliseconds,
                error = new { messageText = ex.Message },
            });
        }
        finally
        {
            _runCts?.Dispose();
            _runCts = null;
        }
    }

    /// <summary>Undo what EXPLAIN ANALYZE executed: back to the savepoint, or roll back our own transaction.</summary>
    static async Task UndoExplainAsync(NpgsqlConnection conn, bool? savepoint)
    {
        try
        {
            if (savepoint == true)
            {
                await ExecAsync(conn, "ROLLBACK TO SAVEPOINT yadbc_explain", CancellationToken.None);
                await ExecAsync(conn, "RELEASE SAVEPOINT yadbc_explain", CancellationToken.None);
            }
            else if (savepoint == false)
            {
                await ExecAsync(conn, "ROLLBACK", CancellationToken.None);
            }
        }
        catch (NpgsqlException)
        {
            // Connection broken: the server rolls back on its own.
        }
    }

    /// <summary>
    /// Runs planned edits as one unit. Outside a transaction: BEGIN … COMMIT. Inside the user's own open
    /// transaction: a savepoint, so the edits join it (and are committed or rolled back with it) instead
    /// of committing it behind their back. Any statement not affecting exactly one row rolls everything back.
    /// </summary>
    public async Task<EditOutcome> ApplyEditsAsync(ResultBuffer buffer, IReadOnlyList<PlannedStatement> plan, ResultSource source, CancellationToken ct)
    {
        if (IsRunning) return EditOutcome.Failed("A query is running in this tab");
        _runCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        ct = _runCts.Token;
        try
        {
            var conn = await EnsureOpenAsync(ct);
            // Try a savepoint: it only works inside a transaction block, and outside one it fails cleanly
            // (25P01) without leaving any state behind — the most reliable "am I in a transaction?" probe.
            bool inTransaction;
            try
            {
                await ExecAsync(conn, "SAVEPOINT yadbc_apply", ct);
                inTransaction = true;
            }
            catch (PostgresException pg) when (pg.SqlState == PostgresErrorCodes.NoActiveSqlTransaction)
            {
                await ExecAsync(conn, "BEGIN", ct);
                inTransaction = false;
            }
            catch (PostgresException pg) when (pg.SqlState == PostgresErrorCodes.InFailedSqlTransaction)
            {
                return EditOutcome.Failed("This tab's transaction has failed. Roll it back first, then apply.");
            }
            var replaced = new Dictionary<int, string?[]>();
            var appended = new List<string?[]>();
            var deleted = new List<int>();

            for (var i = 0; i < plan.Count; i++)
            {
                var stmt = plan[i];
                string? problem = null;
                try
                {
                    await using var cmd = new NpgsqlCommand(stmt.Sql, conn);
                    if (stmt.Kind == EditKind.Delete)
                    {
                        var affected = await cmd.ExecuteNonQueryAsync(ct);
                        if (affected != 1) problem = Conflict(stmt, affected);
                        else deleted.Add(stmt.Row);
                    }
                    else
                    {
                        await using var reader = await cmd.ExecuteReaderAsync(ct);
                        var rows = 0;
                        string?[]? updated = null;
                        while (await reader.ReadAsync(ct))
                        {
                            rows++;
                            updated = stmt.Kind == EditKind.Update
                                ? replaced.GetValueOrDefault(stmt.Row) ?? buffer.Row(stmt.Row)!
                                : new string?[buffer.Columns.Count];
                            CopyReturned(reader, buffer, source, stmt.Table, updated);
                        }
                        if (rows != 1) problem = Conflict(stmt, rows);
                        else if (stmt.Kind == EditKind.Update) replaced[stmt.Row] = updated!;
                        else appended.Add(updated!);
                    }
                }
                catch (PostgresException pg)
                {
                    problem = pg.Detail is { Length: > 0 } d ? $"{pg.MessageText} — {d}" : pg.MessageText;
                }

                if (problem is not null)
                {
                    await RollbackAsync(conn, inTransaction);
                    return EditOutcome.Failed(problem, i);
                }
            }

            await ExecAsync(conn, inTransaction ? "RELEASE SAVEPOINT yadbc_apply" : "COMMIT", ct);
            buffer.ApplyEdits(replaced, deleted, appended);
            // History doubles as the record of what changed through the grid.
            Record(EditPlanner.Script(plan), DateTimeOffset.Now, 0, plan.Count, "ok", inTransaction ? "inside an open transaction" : null, "edit");
            return new EditOutcome(true, null, null, inTransaction);
        }
        catch (Exception ex) when (ex is NpgsqlException or OperationCanceledException or TimeoutException)
        {
            if (_conn is { State: System.Data.ConnectionState.Open } c) await RollbackAsync(c, false);
            return EditOutcome.Failed(ex is OperationCanceledException ? "Cancelled" : ex.Message);
        }
        finally
        {
            _runCts?.Dispose();
            _runCts = null;
        }
    }

    static string Conflict(PlannedStatement stmt, int affected) => stmt.Kind switch
    {
        EditKind.Update when affected == 0 => "The row was changed or deleted by someone else since it was loaded. Nothing was applied; re-run the query.",
        EditKind.Delete when affected == 0 => "The row is already gone. Nothing was applied; re-run the query.",
        _ => $"Expected to change 1 row but changed {affected}. Nothing was applied. Is the primary key really unique?",
    };

    static async Task RollbackAsync(NpgsqlConnection conn, bool savepoint)
    {
        try
        {
            if (savepoint)
            {
                await ExecAsync(conn, "ROLLBACK TO SAVEPOINT yadbc_apply", CancellationToken.None);
                await ExecAsync(conn, "RELEASE SAVEPOINT yadbc_apply", CancellationToken.None);
            }
            else
            {
                await ExecAsync(conn, "ROLLBACK", CancellationToken.None);
            }
        }
        catch (NpgsqlException)
        {
            // The connection broke; the server rolls back on its own.
        }
    }

    /// <summary>Maps RETURNING * back onto the result's columns of that table, so the grid shows what was stored.</summary>
    static void CopyReturned(NpgsqlDataReader reader, ResultBuffer buffer, ResultSource source, string table, string?[] row)
    {
        var ordinals = new Dictionary<string, int>();
        for (var i = 0; i < reader.FieldCount; i++) ordinals[reader.GetName(i)] = i;
        for (var c = 0; c < buffer.Columns.Count; c++)
        {
            if (source.ColumnTables[c] != table || source.BaseColumns[c] is not { } name || !ordinals.TryGetValue(name, out var ord)) continue;
            row[c] = ValueFormatter.Format(reader, ord, reader.GetPostgresType(ord).InternalName);
        }
    }

    static string CommandTag(NpgsqlBatchCommand bc) => bc.StatementType switch
    {
        StatementType.Insert => $"INSERT {bc.RecordsAffected}",
        StatementType.Update => $"UPDATE {bc.RecordsAffected}",
        StatementType.Delete => $"DELETE {bc.RecordsAffected}",
        StatementType.Merge => $"MERGE {bc.RecordsAffected}",
        StatementType.CreateTableAs => $"SELECT {bc.RecordsAffected}",
        StatementType.Copy => $"COPY {bc.RecordsAffected}",
        _ => "OK",
    };

    public async ValueTask DisposeAsync()
    {
        _runCts?.Cancel();
        if (_conn is not null) await _conn.DisposeAsync();
    }
}
