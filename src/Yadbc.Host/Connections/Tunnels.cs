using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;

namespace Yadbc.Host.Connections;

/// <summary>
/// How to reach a database that isn't directly reachable. The database Host/Port of the profile are
/// as seen from the far end: from the SSH server, or (port only) on the Kubernetes target.
/// </summary>
public sealed record TunnelConfig(
    /// <summary>"ssh" or "kubernetes"</summary>
    string Kind,
    /// <summary>SSH server: a host, or an alias from ~/.ssh/config (user, port, ProxyJump… come along).</summary>
    string? SshHost = null,
    string? SshUser = null,
    int? SshPort = null,
    /// <summary>Optional key file; empty = whatever ssh would use (agent, ~/.ssh/config).</summary>
    string? SshIdentityFile = null,
    /// <summary>Kubeconfig file; empty = kubectl's default (KUBECONFIG / ~/.kube/config).</summary>
    string? Kubeconfig = null,
    string? KubeContext = null,
    string? KubeNamespace = null,
    /// <summary>svc/name, pod/name, statefulset/name… — anything `kubectl port-forward` accepts.</summary>
    string? KubeTarget = null);

/// <summary>
/// Couldn't get as far as talking to Postgres: the tunnel didn't come up, or (shared connections) the
/// login couldn't be had. Its message is meant for the user as-is.
/// </summary>
public class ConnectException(string message) : Exception(message);

public sealed class TunnelException(string message) : ConnectException(message);

/// <summary>
/// Runs tunnels as child processes — the user's own `ssh` (Windows OpenSSH, so the 1Password / Windows
/// SSH agent works) and `kubectl` (their kubeconfig and RBAC) — instead of re-implementing either.
/// One tunnel per connection, on a local port fixed for the app's lifetime; started on first use,
/// restarted when it died, killed when the profile changes or yadbc exits.
/// </summary>
public sealed class TunnelManager(ILogger<TunnelManager> log) : IAsyncDisposable
{
    readonly ConcurrentDictionary<string, Tunnel> _tunnels = new();

    /// <summary>Where Npgsql should connect: the profile itself, or the tunnel's local end (not started yet).</summary>
    public (string Host, int Port) Endpoint(ConnectionProfile profile) =>
        profile.Tunnel is null ? (profile.Host, profile.Port) : ("127.0.0.1", For(profile).LocalPort);

    /// <summary>Makes sure the tunnel is up (starting or restarting it) before a connection is opened.</summary>
    public async Task EnsureAsync(ConnectionProfile profile, CancellationToken ct)
    {
        if (profile.Tunnel is not null) await For(profile).EnsureRunningAsync(ct);
    }

    /// <summary>A short-lived tunnel for "Test connection" on unsaved settings.</summary>
    public async Task<Tunnel> StartTemporaryAsync(ConnectionProfile profile, CancellationToken ct)
    {
        var tunnel = new Tunnel(profile, FreePort(), log);
        try
        {
            await tunnel.EnsureRunningAsync(ct);
            return tunnel;
        }
        catch
        {
            await tunnel.DisposeAsync();
            throw;
        }
    }

    /// <summary>The profile changed or was deleted: its tunnel (and settings) must not be reused.</summary>
    public void Stop(string connectionId)
    {
        if (_tunnels.TryRemove(connectionId, out var t)) _ = t.DisposeAsync().AsTask();
    }

    /// <summary>No tunnel, or a running one. A tunnel that died reports false until it's restarted.</summary>
    public bool IsAlive(string connectionId) => !_tunnels.TryGetValue(connectionId, out var t) || t.IsRunning;

    public object? Status(string connectionId) =>
        _tunnels.TryGetValue(connectionId, out var t) ? new { running = t.IsRunning, localPort = t.LocalPort, t.LastError } : null;

    Tunnel For(ConnectionProfile profile) => _tunnels.GetOrAdd(profile.Id, _ => new Tunnel(profile, FreePort(), log));

    static int FreePort()
    {
        using var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var t in _tunnels.Values) await t.DisposeAsync();
        _tunnels.Clear();
    }

    public sealed class Tunnel(ConnectionProfile profile, int localPort, ILogger log) : IAsyncDisposable
    {
        static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(25);
        readonly SemaphoreSlim _gate = new(1, 1);
        readonly ConcurrentQueue<string> _output = new();
        Process? _process;

        public int LocalPort { get; } = localPort;
        public string? LastError { get; private set; }
        public bool IsRunning => _process is { HasExited: false };

        public async Task EnsureRunningAsync(CancellationToken ct)
        {
            await _gate.WaitAsync(ct);
            try
            {
                if (IsRunning && await AcceptsAsync(ct)) return;
                Kill();
                await StartAsync(ct);
            }
            finally
            {
                _gate.Release();
            }
        }

        async Task StartAsync(CancellationToken ct)
        {
            var (file, args) = Command(profile.Tunnel!, profile, LocalPort);
            var psi = new ProcessStartInfo(file)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);
            while (_output.TryDequeue(out _)) { }

            try
            {
                _process = Process.Start(psi) ?? throw new TunnelException($"Couldn't start {file}");
            }
            catch (System.ComponentModel.Win32Exception ex)
            {
                throw new TunnelException($"Couldn't start {Path.GetFileName(file)}: {ex.Message}. Is it installed and on PATH?");
            }
            ChildProcessJob.Add(_process);
            var started = _process;
            started.EnableRaisingEvents = true;
            started.Exited += (_, _) =>
            {
                // Not ours to report if we killed it; otherwise the next use restarts it, and this says why it went.
                if (ReferenceEquals(_process, started))
                    log.LogWarning("Tunnel for {Connection} exited ({Code}): {Output}", profile.Name, started.ExitCode, string.Join(" | ", _output));
            };
            _process.OutputDataReceived += (_, e) => Keep(e.Data);
            _process.ErrorDataReceived += (_, e) => Keep(e.Data);
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();
            log.LogInformation("Tunnel for {Connection}: {File} {Args}", profile.Name, file, string.Join(' ', args));

            // Ready = the local end accepts connections. A process that exits first failed; say why.
            var deadline = Stopwatch.StartNew();
            while (deadline.Elapsed < StartTimeout)
            {
                if (_process.HasExited)
                {
                    await Task.Delay(100, ct); // let the last stderr lines arrive
                    LastError = Explain(string.Join("\n", _output));
                    throw new TunnelException(LastError);
                }
                if (await AcceptsAsync(ct))
                {
                    LastError = null;
                    return;
                }
                await Task.Delay(150, ct);
            }
            Kill();
            LastError = $"The tunnel didn't come up within {StartTimeout.TotalSeconds:0} s. {Explain(string.Join("\n", _output))}".Trim();
            throw new TunnelException(LastError);
        }

        void Keep(string? line)
        {
            if (string.IsNullOrWhiteSpace(line)) return;
            _output.Enqueue(line.Trim());
            while (_output.Count > 20) _output.TryDequeue(out _);
        }

        /// <summary>The usual failures, in words that say what to do.</summary>
        string Explain(string output)
        {
            var o = output.Trim();
            if (o.Contains("Host key verification failed", StringComparison.OrdinalIgnoreCase))
                return $"The SSH server's host key isn't trusted yet. Connect once with `ssh {profile.Tunnel!.SshHost}` in a terminal and accept it, then retry.";
            if (o.Contains("Permission denied", StringComparison.OrdinalIgnoreCase))
                return $"SSH refused the login ({o.Split('\n').Last()}). Check the user and key — or that your SSH agent (1Password) has it unlocked.";
            if (o.Contains("Could not resolve hostname", StringComparison.OrdinalIgnoreCase))
                return $"SSH can't resolve {profile.Tunnel!.SshHost}. ({o.Split('\n').Last()})";
            if (o.Contains("Unable to connect to the server", StringComparison.OrdinalIgnoreCase) || o.Contains("dial tcp", StringComparison.OrdinalIgnoreCase))
                return $"kubectl can't reach the cluster API ({o.Split('\n').Last()}). VPN / WireGuard up?";
            if (o.Contains("forbidden", StringComparison.OrdinalIgnoreCase))
                return $"The cluster refused the port-forward (RBAC): {o.Split('\n').Last()}";
            if (o.Contains("NotFound", StringComparison.OrdinalIgnoreCase) || o.Contains("not found", StringComparison.OrdinalIgnoreCase))
                return $"kubectl couldn't find it: {o.Split('\n').Last()}";
            return o.Length > 0 ? o : "The tunnel process exited without saying why.";
        }

        async Task<bool> AcceptsAsync(CancellationToken ct)
        {
            using var client = new TcpClient();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(400);
            try
            {
                await client.ConnectAsync(IPAddress.Loopback, LocalPort, timeout.Token);
                return true;
            }
            catch (Exception ex) when (ex is SocketException or OperationCanceledException && !ct.IsCancellationRequested)
            {
                return false;
            }
        }

        void Kill()
        {
            var p = _process;
            _process = null; // first, so its Exited handler knows this was on purpose
            try
            {
                if (p is { HasExited: false }) p.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // already gone
            }
            p?.Dispose();
        }

        public ValueTask DisposeAsync()
        {
            Kill();
            return ValueTask.CompletedTask;
        }
    }

    /// <summary>The exact command line; env YADBC_SSH / YADBC_KUBECTL override the executables (tests, odd installs).</summary>
    public static (string File, List<string> Args) Command(TunnelConfig t, ConnectionProfile profile, int localPort)
    {
        switch (t.Kind)
        {
            case "ssh":
            {
                if (string.IsNullOrWhiteSpace(t.SshHost)) throw new TunnelException("SSH tunnel needs an SSH server.");
                // Windows OpenSSH talks to the Windows / 1Password SSH agent; git-bash's ssh can't.
                var windowsSsh = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "OpenSSH", "ssh.exe");
                var file = Environment.GetEnvironmentVariable("YADBC_SSH") ?? (File.Exists(windowsSsh) ? windowsSsh : "ssh");
                var args = new List<string>
                {
                    "-N", // no remote command, just the forward
                    "-L", $"127.0.0.1:{localPort}:{profile.Host}:{profile.Port}",
                    "-o", "ExitOnForwardFailure=yes",
                    "-o", "ServerAliveInterval=15",
                    "-o", "ServerAliveCountMax=3",
                    // Never sit waiting for a password or a host-key prompt nobody can see.
                    "-o", "BatchMode=yes",
                };
                if (t.SshPort is { } port) args.AddRange(["-p", port.ToString()]);
                if (!string.IsNullOrWhiteSpace(t.SshIdentityFile)) args.AddRange(["-i", t.SshIdentityFile, "-o", "IdentitiesOnly=yes"]);
                if (Environment.GetEnvironmentVariable("YADBC_SSH_OPTIONS") is { Length: > 0 } extra)
                    args.AddRange(extra.Split(' ', StringSplitOptions.RemoveEmptyEntries));
                args.Add(string.IsNullOrWhiteSpace(t.SshUser) ? t.SshHost : $"{t.SshUser}@{t.SshHost}");
                return (file, args);
            }
            case "kubernetes":
            {
                if (string.IsNullOrWhiteSpace(t.KubeTarget)) throw new TunnelException("Kubernetes tunnel needs a target (e.g. svc/postgres).");
                var file = Environment.GetEnvironmentVariable("YADBC_KUBECTL") ?? "kubectl";
                var args = new List<string>();
                if (!string.IsNullOrWhiteSpace(t.Kubeconfig)) args.AddRange(["--kubeconfig", t.Kubeconfig]);
                if (!string.IsNullOrWhiteSpace(t.KubeContext)) args.AddRange(["--context", t.KubeContext]);
                if (!string.IsNullOrWhiteSpace(t.KubeNamespace)) args.AddRange(["--namespace", t.KubeNamespace]);
                args.AddRange(["port-forward", "--address", "127.0.0.1", t.KubeTarget, $"{localPort}:{profile.Port}"]);
                return (file, args);
            }
            default:
                throw new TunnelException($"Unknown tunnel kind '{t.Kind}'.");
        }
    }
}
