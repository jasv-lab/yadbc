using Velopack;
using Velopack.Sources;

namespace Yadbc.Host.Hosting;

/// <summary>What the status bar shows: nothing, a download in progress, or "Restart to update".</summary>
public sealed record UpdateStatus(bool Enabled, string? Current, string? Available, string State, int Progress, string? Error);

/// <summary>
/// Updates from the GitHub releases (Velopack, docs/design.md §11). Checks a minute after start and then
/// every few hours, and downloads a new version quietly. Nothing restarts on its own: the UI offers
/// "Restart to update", and an update downloaded but not restarted into is applied when yadbc quits.
/// Only for an installed yadbc; `dotnet run` and the headless dev setup never update.
/// YADBC_UPDATE_SOURCE (a folder or URL with a Velopack feed) replaces GitHub, for testing.
/// </summary>
public sealed class Updates(ILogger<Updates> log) : BackgroundService
{
    const string Repository = "https://github.com/jasv-lab/yadbc";
    static readonly TimeSpan FirstCheck = TimeSpan.FromMinutes(1);
    static readonly TimeSpan Every = TimeSpan.FromHours(4);

    readonly UpdateManager? _manager = Create();
    readonly Lock _lock = new();
    VelopackAsset? _ready;
    string? _available;
    string _state = "idle";
    int _progress;
    string? _error;
    bool _restart;

    public UpdateStatus Status
    {
        get
        {
            lock (_lock)
                return new UpdateStatus(_manager is not null, _manager?.CurrentVersion?.ToString(), _available, _state, _progress, _error);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (_manager is null) return;
        // Downloaded last time but never applied (yadbc was killed rather than closed): offer it again.
        if (_manager.UpdatePendingRestart is { } pending) Ready(pending);
        try
        {
            await Task.Delay(FirstCheck, ct);
            while (!ct.IsCancellationRequested)
            {
                await CheckAsync(ct);
                await Task.Delay(Every, ct);
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    /// <summary>Checks now (also behind the UI's "check for updates"); downloads what it finds.</summary>
    public async Task CheckAsync(CancellationToken ct)
    {
        if (_manager is null) return;
        try
        {
            var info = await _manager.CheckForUpdatesAsync();
            if (info is null || info.TargetFullRelease.Version.ToString() == _ready?.Version.ToString()) return;
            lock (_lock)
            {
                _available = info.TargetFullRelease.Version.ToString();
                _state = "downloading";
                _progress = 0;
                _error = null;
            }
            await _manager.DownloadUpdatesAsync(info, p => { lock (_lock) _progress = p; }, ct);
            Ready(info.TargetFullRelease);
            log.LogInformation("Update {Version} downloaded; applied on restart or when yadbc quits", _available);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // Offline, GitHub's rate limit, a broken download: try again at the next check.
            log.LogInformation("Update check failed: {Message}", e.Message);
            lock (_lock)
            {
                if (_state == "downloading") _state = "idle";
                _error = e.Message;
            }
        }
    }

    /// <summary>The user asked to restart into the update: once yadbc has closed, it starts again.</summary>
    public bool RequestRestart()
    {
        lock (_lock)
        {
            if (_ready is null) return false;
            _restart = true;
            return true;
        }
    }

    /// <summary>
    /// Called as the process ends, after the window closed and the services were disposed: hands a
    /// downloaded update to Velopack's updater, which waits for this process to exit, swaps the files in,
    /// and starts yadbc again only if the user asked for it.
    /// </summary>
    public void ApplyOnExit()
    {
        VelopackAsset? ready;
        bool restart;
        lock (_lock)
        {
            ready = _ready;
            restart = _restart;
        }
        if (_manager is null || ready is null) return;
        try
        {
            _manager.WaitExitThenApplyUpdates(ready, silent: true, restart: restart);
        }
        catch (Exception e)
        {
            log.LogWarning(e, "Couldn't start the updater");
        }
    }

    void Ready(VelopackAsset asset)
    {
        lock (_lock)
        {
            _ready = asset;
            _available = asset.Version.ToString();
            _state = "ready";
            _progress = 100;
            _error = null;
        }
    }

    static UpdateManager? Create()
    {
        var source = Environment.GetEnvironmentVariable("YADBC_UPDATE_SOURCE");
        var manager = string.IsNullOrWhiteSpace(source)
            ? new UpdateManager(new GithubSource(Repository, accessToken: null, prerelease: false))
            : new UpdateManager(source);
        return manager.IsInstalled ? manager : null;
    }
}

public static class UpdateEndpoints
{
    public static void MapUpdateEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/update", (Updates updates) => updates.Status);

        app.MapPost("/api/update/check", async (Updates updates, CancellationToken ct) =>
        {
            await updates.CheckAsync(ct);
            return updates.Status;
        });

        // Closes yadbc the normal way (window position, workspace, tunnels) and lets the updater restart
        // it. A moment's delay so this answer still reaches the page.
        app.MapPost("/api/update/restart", (Updates updates, IHostApplicationLifetime lifetime) =>
        {
            if (!updates.RequestRestart()) return Results.Conflict(new { error = "No update is ready yet." });
            _ = Task.Run(async () =>
            {
                await Task.Delay(300);
                if (!DesktopWindow.Close()) lifetime.StopApplication();
            });
            return Results.Accepted();
        });
    }
}
