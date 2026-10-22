using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Npgsql;
using Yadbc.Host.Connections;
using Yadbc.Host.Editing;
using Yadbc.Host.Export;
using Yadbc.Host.History;

namespace Yadbc.Host.Query;

/// <summary>
/// One WebSocket per window carries everything query-related. Client ops: open, run, cancel, window,
/// close. Server events: opened, result, result-progress, command, notice, run-finished, window, error.
/// </summary>
public sealed class QuerySocketHandler(ConnectionStore store, DataSourceCache dataSources, ResultStore results, TableSources sources, HistoryStore history, ILogger<QuerySocketHandler> log)
{
    public async Task Handle(HttpContext ctx)
    {
        if (!ctx.WebSockets.IsWebSocketRequest)
        {
            ctx.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
        await using var conn = new SocketConnection(ws, store, dataSources, results, sources, history, log);
        await conn.RunAsync(ctx.RequestAborted);
    }
}

sealed class SocketConnection(WebSocket ws, ConnectionStore store, DataSourceCache dataSources, ResultStore results, TableSources sources, HistoryStore history, ILogger log) : IAsyncDisposable
{
    const int MaxWindow = 1000;
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    readonly ConcurrentDictionary<string, QuerySession> _sessions = new();
    readonly string _owner = Guid.NewGuid().ToString("n");
    readonly SemaphoreSlim _sendLock = new(1, 1);

    public async Task RunAsync(CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();

        while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            WebSocketReceiveResult received;
            try
            {
                received = await ws.ReceiveAsync(buffer, ct);
            }
            catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
            {
                return;
            }

            if (received.MessageType == WebSocketMessageType.Close) return;
            message.Write(buffer, 0, received.Count);
            if (!received.EndOfMessage) continue;

            var json = Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
            message.SetLength(0);
            _ = DispatchAsync(json, ct);
        }
    }

    async Task DispatchAsync(string json, CancellationToken ct)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var op = root.GetProperty("op").GetString();
            switch (op)
            {
                case "open": await OpenAsync(root.GetProperty("tabId").GetString()!, root.GetProperty("connectionId").GetString()!, ct); break;
                case "run": await RunAsync(root, ct); break;
                case "explain": await ExplainAsync(root, ct); break;
                case "cancel": Session(root)?.Cancel(); break;
                case "window": await WindowAsync(root); break;
                case "cell": await CellAsync(root); break;
                case "close": await CloseAsync(root.GetProperty("tabId").GetString()!); break;
                case "set-readonly": await SetReadOnlyAsync(root, ct); break;
                case "end-tx": await EndTransactionAsync(root, ct); break;
                case "edits-apply": await ApplyEditsAsync(root, ct); break;
                default: await Send(new { ev = "error", message = $"Unknown op '{op}'" }); break;
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogError(ex, "WebSocket message failed");
            await Send(new { ev = "error", message = ex.Message });
        }
    }

    async Task OpenAsync(string tabId, string connectionId, CancellationToken ct)
    {
        var profile = store.Get(connectionId);
        if (profile is null)
        {
            await Send(new { ev = "opened", tabId, ok = false, error = "Unknown connection" });
            return;
        }

        await CloseAsync(tabId);
        var session = new QuerySession(tabId, profile, ct => dataSources.OpenAsync(connectionId, ct), history, () => dataSources.TransportAlive(connectionId));
        session.Notice += (severity, text) => _ = Send(new { ev = "notice", tabId, severity, message = text });
        try
        {
            var info = await session.OpenAsync(ct);
            _sessions[tabId] = session;
            await Send(new { ev = "opened", tabId, ok = true, info });
        }
        catch (Exception ex) when (ex is NpgsqlException or TimeoutException or ConnectException)
        {
            await session.DisposeAsync();
            await Send(new { ev = "opened", tabId, ok = false, error = ex.Message });
        }
    }

    async Task ExplainAsync(JsonElement root, CancellationToken ct)
    {
        var session = Session(root);
        var runId = root.GetProperty("runId").GetString()!;
        if (session is null || session.IsRunning)
        {
            await Send(new
            {
                ev = "run-finished", tabId = root.GetProperty("tabId").GetString(), runId, ok = false, cancelled = false, elapsedMs = 0,
                error = new { messageText = session is null ? "Tab is not connected" : "A query is already running in this tab" },
            });
            return;
        }
        var statement = root.GetProperty("statement").Deserialize<Statement>(Json)!;
        results.RemoveTab(_owner, session.TabId);
        await Send(new { ev = "run-started", tabId = session.TabId, runId });
        await session.ExplainAsync(runId, statement, root.GetProperty("analyze").GetBoolean(), Send, ct);
    }

    async Task RunAsync(JsonElement root, CancellationToken ct)
    {
        var session = Session(root);
        var runId = root.GetProperty("runId").GetString()!;
        if (session is null || session.IsRunning)
        {
            await Send(new
            {
                ev = "run-finished", tabId = root.GetProperty("tabId").GetString(), runId, ok = false, cancelled = false, elapsedMs = 0,
                error = new { messageText = session is null ? "Tab is not connected" : "A query is already running in this tab" },
            });
            return;
        }

        var statements = root.GetProperty("statements").Deserialize<List<Statement>>(Json)!;

        // A re-run replaces the tab's previous results; keep backend memory bounded by open tabs.
        results.RemoveTab(_owner, session.TabId);

        await Send(new { ev = "run-started", tabId = session.TabId, runId });
        await session.RunAsync(runId, statements,
            r => { results.Add(_owner, r); return Task.CompletedTask; },
            Send, ct);
    }

    async Task WindowAsync(JsonElement root)
    {
        var reqId = root.GetProperty("reqId").GetInt32();
        var resultId = root.GetProperty("resultId").GetString()!;
        var from = root.GetProperty("from").GetInt32();
        var count = Math.Min(root.GetProperty("count").GetInt32(), MaxWindow);
        var full = root.TryGetProperty("full", out var f) && f.GetBoolean();
        var rows = results.Get(resultId)?.Window(from, count, full) ?? [];
        await Send(new { ev = "window", reqId, resultId, from, rows });
    }

    /// <summary>One full, untruncated value — for the cell inspector.</summary>
    async Task CellAsync(JsonElement root)
    {
        var reqId = root.GetProperty("reqId").GetInt32();
        var row = root.GetProperty("row").GetInt32();
        var col = root.GetProperty("col").GetInt32();
        if (results.Get(root.GetProperty("resultId").GetString()!) is not { } result)
        {
            await Send(new { ev = "cell", reqId, found = false });
            return;
        }
        await Send(new { ev = "cell", reqId, found = true, value = result.Cell(row, col) });
    }

    async Task EndTransactionAsync(JsonElement root, CancellationToken ct)
    {
        var tabId = root.GetProperty("tabId").GetString()!;
        if (Session(root) is not { } session) return;
        var commit = root.GetProperty("commit").GetBoolean();
        try
        {
            var info = await session.EndTransactionAsync(commit, ct);
            await Send(new { ev = "notice", tabId, severity = "NOTICE", message = commit ? "Committed — the transaction's locks are released." : "Rolled back — the transaction's locks are released." });
            await Send(new { ev = "session", tabId, info });
        }
        catch (Exception ex) when (ex is NpgsqlException or InvalidOperationException)
        {
            await Send(new { ev = "notice", tabId, severity = "ERROR", message = ex.Message });
        }
    }

    async Task SetReadOnlyAsync(JsonElement root, CancellationToken ct)
    {
        var tabId = root.GetProperty("tabId").GetString()!;
        if (Session(root) is not { } session) return;
        try
        {
            var info = await session.SetReadOnlyAsync(root.GetProperty("readOnly").GetBoolean(), ct);
            await Send(new { ev = "session", tabId, info });
        }
        catch (Exception ex) when (ex is NpgsqlException or InvalidOperationException)
        {
            await Send(new { ev = "error", tabId, message = ex.Message });
        }
    }

    /// <summary>Plans and applies staged grid edits on the tab's own session.</summary>
    async Task ApplyEditsAsync(JsonElement root, CancellationToken ct)
    {
        var reqId = root.GetProperty("reqId").GetInt32();
        var resultId = root.GetProperty("resultId").GetString()!;
        if (Session(root) is not { } session || results.Get(resultId) is not { } buffer)
        {
            await Send(new { ev = "edits-applied", reqId, ok = false, error = "This result is no longer available. Run the query again." });
            return;
        }

        try
        {
            var edits = root.GetProperty("edits").Deserialize<EditSet>(Json)!;
            var source = await sources.Get(buffer, ct);
            var plan = EditPlanner.Plan(buffer, source, edits);
            var outcome = await session.ApplyEditsAsync(buffer, plan, source, ct);
            var failed = outcome.StatementIndex is { } i ? plan[i] : null;
            await Send(new
            {
                ev = "edits-applied", reqId, outcome.Ok, outcome.Error, outcome.InTransaction,
                rowCount = buffer.Count,
                // Lets the grid point at the row that caused a rollback.
                failedRow = failed?.Kind is EditKind.Update or EditKind.Delete ? failed.Row : (int?)null,
                failedInsert = failed?.Kind == EditKind.Insert ? failed.Row : (int?)null,
            });
        }
        catch (EditException ex)
        {
            await Send(new { ev = "edits-applied", reqId, ok = false, error = ex.Message });
        }
    }

    async Task CloseAsync(string tabId)
    {
        results.RemoveTab(_owner, tabId);
        if (_sessions.TryRemove(tabId, out var session)) await session.DisposeAsync();
    }

    QuerySession? Session(JsonElement root) =>
        _sessions.TryGetValue(root.GetProperty("tabId").GetString()!, out var s) ? s : null;

    async Task Send(object payload)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(payload, Json);
        await _sendLock.WaitAsync();
        try
        {
            if (ws.State == WebSocketState.Open)
                await ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
        }
        catch (WebSocketException)
        {
            // Window closed mid-send; the receive loop will notice and tear down.
        }
        finally
        {
            _sendLock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var session in _sessions.Values) await session.DisposeAsync();
        _sessions.Clear();
        results.RemoveOwner(_owner);
    }
}
