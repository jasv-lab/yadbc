using Npgsql;
using Yadbc.Contracts.Broker;
using Yadbc.Host.Sharing;

namespace Yadbc.Host.Connections;

public static class ConnectionEndpoints
{
    public static void MapConnectionEndpoints(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/connections");

        // A "bring your own login" share without one entered yet asks for it before connecting.
        api.MapGet("/", (ConnectionStore store, SecretStore secrets) => store.All()
            .Select(p => p.Shared is { LoginMode: LoginMode.Own } && secrets.GetPassword(p.Id) is null ? p with { NeedsLogin = true } : p));

        api.MapPost("/", (ConnectionInput input, ConnectionStore store, SecretStore secrets) =>
        {
            var profile = ToProfile(Guid.NewGuid().ToString("n")[..12], input);
            store.Upsert(profile);
            if (!string.IsNullOrEmpty(input.Password)) secrets.SetPassword(profile.Id, profile.Username, input.Password);
            return Results.Ok(profile);
        });

        api.MapPut("/{id}", async (string id, ConnectionInput input, ConnectionStore store, SecretStore secrets, DataSourceCache cache, Broker broker, CancellationToken ct) =>
        {
            if (store.Get(id) is not { } current) return Results.NotFound();
            if (current.Shared is not null)
            {
                var result = await SharingEndpoints.UpdateAsync(current, ToProfile(id, input) with { Shared = current.Shared }, input, broker, store, secrets, ct);
                cache.Invalidate(id);
                return result;
            }
            var profile = ToProfile(id, input);
            store.Upsert(profile);
            if (!string.IsNullOrEmpty(input.Password)) secrets.SetPassword(id, profile.Username, input.Password);
            cache.Invalidate(id);
            return Results.Ok(profile);
        });

        // For an installed share this is "uninstall": gone from this list, the share itself stays.
        api.MapDelete("/{id}", async (string id, ConnectionStore store, SecretStore secrets, DataSourceCache cache, Broker broker, CancellationToken ct) =>
        {
            if (store.Get(id) is { Shared: not null } shared) await SharingEndpoints.UninstallAsync(shared, broker, ct);
            cache.Invalidate(id);
            secrets.Delete(id);
            return store.Remove(id) ? Results.NoContent() : Results.NotFound();
        });

        // Tests unsaved input; when editing an existing profile without retyping the password, `id` supplies it.
        api.MapPost("/test", async (ConnectionInput input, string? id, SecretStore secrets, TunnelManager tunnels, SharedLogins logins, CancellationToken ct) =>
        {
            if (id is not null) await logins.EnsureAsync(id, ct);
            var password = !string.IsNullOrEmpty(input.Password) ? input.Password
                : id is not null ? secrets.GetPassword(id) : null;
            var profile = ToProfile(id ?? "test", input);
            // Unsaved settings get their own short-lived tunnel.
            TunnelManager.Tunnel? tunnel = null;
            try
            {
                if (profile.Tunnel is not null) tunnel = await tunnels.StartTemporaryAsync(profile, ct);
                var endpoint = tunnel is null ? (profile.Host, profile.Port) : ("127.0.0.1", tunnel.LocalPort);
                await using var ds = DataSourceCache.Build(profile, password, endpoint);
                await using var conn = await ds.OpenConnectionAsync(ct);
                return Results.Ok(new { ok = true, serverVersion = conn.PostgreSqlVersion.ToString(), tunnel = tunnel is not null });
            }
            catch (Exception ex) when (ex is NpgsqlException or TimeoutException or ConnectException)
            {
                return Results.Ok(new { ok = false, error = ex.Message });
            }
            finally
            {
                if (tunnel is not null) await tunnel.DisposeAsync();
            }
        });

        // Helpers for the Kubernetes tunnel fields: your kubeconfig files, their contexts, namespaces, services.
        app.MapGet("/api/kube/configs", () =>
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".kube");
            return Directory.Exists(dir)
                ? Directory.EnumerateFiles(dir).Where(f => Path.GetFileName(f) == "config" || f.EndsWith(".yaml") || f.EndsWith(".yml")).Order().ToList()
                : [];
        });
        app.MapGet("/api/kube/contexts", (string? kubeconfig, CancellationToken ct) =>
            Kubectl(kubeconfig, null, ["config", "get-contexts", "-o", "name"], ct));
        app.MapGet("/api/kube/namespaces", (string? kubeconfig, string? context, CancellationToken ct) =>
            Kubectl(kubeconfig, context, ["get", "namespaces", "-o", "name", "--request-timeout=8s"], ct));
        app.MapGet("/api/kube/services", (string? kubeconfig, string? context, string ns, CancellationToken ct) =>
            Kubectl(kubeconfig, context, ["get", "services", "-n", ns, "-o", "name", "--request-timeout=8s"], ct));
    }

    /// <summary>Runs a read-only kubectl query, returning output lines ("namespace/x" → "x", "service/x" → "svc/x").</summary>
    static async Task<IResult> Kubectl(string? kubeconfig, string? context, string[] args, CancellationToken ct)
    {
        var psi = new System.Diagnostics.ProcessStartInfo(Environment.GetEnvironmentVariable("YADBC_KUBECTL") ?? "kubectl")
        {
            RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
        };
        if (!string.IsNullOrWhiteSpace(kubeconfig)) { psi.ArgumentList.Add("--kubeconfig"); psi.ArgumentList.Add(kubeconfig); }
        if (!string.IsNullOrWhiteSpace(context)) { psi.ArgumentList.Add("--context"); psi.ArgumentList.Add(context); }
        foreach (var a in args) psi.ArgumentList.Add(a);
        try
        {
            using var p = System.Diagnostics.Process.Start(psi)!;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(12));
            var output = await p.StandardOutput.ReadToEndAsync(timeout.Token);
            var error = await p.StandardError.ReadToEndAsync(timeout.Token);
            await p.WaitForExitAsync(timeout.Token);
            if (p.ExitCode != 0) return Results.Ok(new { items = Array.Empty<string>(), error = error.Trim().Split('\n').LastOrDefault() });
            var items = output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(l => l.StartsWith("namespace/") ? l["namespace/".Length..] : l.StartsWith("service/") ? "svc/" + l["service/".Length..] : l)
                .ToList();
            return Results.Ok(new { items, error = (string?)null });
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or OperationCanceledException)
        {
            return Results.Ok(new { items = Array.Empty<string>(), error = ex is OperationCanceledException ? "kubectl timed out" : "kubectl not found" });
        }
    }

    static ConnectionProfile ToProfile(string id, ConnectionInput i) =>
        new(id, i.Name.Trim(), i.Host.Trim(), i.Port, i.Database.Trim(), i.Username.Trim(), i.Env, i.Mcp,
            i.Tunnel is null || string.IsNullOrWhiteSpace(i.Tunnel.Kind) ? null : i.Tunnel);
}
