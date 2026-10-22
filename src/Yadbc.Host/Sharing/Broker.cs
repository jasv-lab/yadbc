using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Yadbc.Contracts.Broker;
using Yadbc.Host.Connections;
using Yadbc.Host.Hosting;

namespace Yadbc.Host.Sharing;

/// <summary>A broker call that didn't work; the message is shown to the user.</summary>
public class BrokerException(string message, HttpStatusCode? status = null) : Exception(message)
{
    public HttpStatusCode? Status { get; } = status;
}

/// <summary>Someone else saved the share since we read it.</summary>
public sealed class BrokerConflictException(ShareConflict conflict)
    : BrokerException($"{conflict.UpdatedBy.Name} changed this shared connection {Ago(conflict.UpdatedAt)}. Close and reopen it to see their version.", HttpStatusCode.PreconditionFailed)
{
    public ShareConflict Conflict { get; } = conflict;

    static string Ago(DateTimeOffset at)
    {
        var span = DateTimeOffset.UtcNow - at;
        return span.TotalMinutes < 1 ? "just now" : span.TotalHours < 1 ? $"{(int)span.TotalMinutes} min ago" : $"at {at.ToLocalTime():g}";
    }
}

public sealed record SharingStatus(string? BrokerUrl, bool SignedIn, bool SigningIn, PersonRef? User, bool IsAdmin, string? Error);

/// <summary>
/// yadbc's side of the shared-connections broker (docs/design.md §10b): its URL (sharing.json), the
/// device token (Credential Manager), the sign-in round trip, and the HTTP calls. Optional: without a
/// broker URL and a sign-in, nothing here runs and the app is purely local.
/// </summary>
public sealed class Broker(SecretStore secrets, ILogger<Broker> log)
{
    public const string CallbackPath = "/sharing/callback";
    const string TokenName = "broker-token";

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    static string SettingsFile => Path.Combine(AppPaths.DataDir, "sharing.json");

    readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(15) };
    readonly Lock _lock = new();
    string? _url = LoadUrl();
    string? _token;
    bool _tokenLoaded;
    Me? _me;
    string? _error;
    PendingSignIn? _pending;
    string? _catalogTag;
    List<Share> _catalog = [];

    sealed record PendingSignIn(string Url, string State, string Verifier, string RedirectUri, DateTimeOffset Started);

    sealed record Settings(string? BrokerUrl);

    public string? Url => _url;

    string? Token
    {
        get
        {
            lock (_lock)
            {
                if (!_tokenLoaded)
                {
                    _token = secrets.GetAppSecret(TokenName);
                    _tokenLoaded = true;
                }
                return _token;
            }
        }
    }

    public bool SignedIn => _url is not null && Token is not null;

    public async Task<SharingStatus> StatusAsync(CancellationToken ct)
    {
        if (SignedIn && _me is null)
        {
            try
            {
                _me = await SendAsync<Me>(HttpMethod.Get, "/me", null, null, ct);
            }
            catch (BrokerException e)
            {
                _error = e.Message;
            }
        }
        var signingIn = _pending is { } p && DateTimeOffset.UtcNow - p.Started < TimeSpan.FromMinutes(10);
        return new SharingStatus(_url, SignedIn, signingIn, SignedIn ? _me?.User : null, SignedIn && _me?.IsAdmin == true, _error);
    }

    /// <summary>
    /// Starts the browser round trip: remembers a PKCE verifier and state, and opens the broker's /login
    /// in the system browser (the provider's sign-in, 2FA and SSO belong there, not in an embedded view).
    /// Returns the URL too, for when no browser could be opened from here.
    /// </summary>
    public (string LoginUrl, bool Opened) BeginSignIn(string brokerUrl, int localPort)
    {
        var url = NormalizeUrl(brokerUrl);
        var verifier = Base64Url(RandomNumberGenerator.GetBytes(32));
        var state = Base64Url(RandomNumberGenerator.GetBytes(16));
        var redirect = $"http://127.0.0.1:{localPort}{CallbackPath}";
        var challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        lock (_lock)
        {
            _pending = new PendingSignIn(url, state, verifier, redirect, DateTimeOffset.UtcNow);
            _error = null;
        }
        var login = $"{url}/login?redirect_uri={Uri.EscapeDataString(redirect)}&code_challenge={challenge}&state={state}";
        var opened = false;
        if (Environment.GetEnvironmentVariable("YADBC_HEADLESS") != "1")
        {
            try
            {
                Process.Start(new ProcessStartInfo(login) { UseShellExecute = true });
                opened = true;
            }
            catch (Exception e)
            {
                log.LogWarning(e, "Couldn't open the browser for sign-in");
            }
        }
        return (login, opened);
    }

    /// <summary>The browser came back with a code: trade it (plus the verifier) for a device token.</summary>
    public async Task<string?> CompleteSignInAsync(string? code, string? state, CancellationToken ct)
    {
        PendingSignIn? pending;
        lock (_lock)
        {
            pending = _pending;
            if (pending is null || state is null || !CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(state), Encoding.ASCII.GetBytes(pending.State)))
                return "This sign-in wasn't started from this yadbc window (or it was already finished). Start again from yadbc.";
            _pending = null;
        }
        if (string.IsNullOrEmpty(code)) return "The broker didn't send a sign-in code.";
        try
        {
            using var response = await _http.PostAsJsonAsync(
                $"{pending.Url}/token",
                new TokenRequest(code, pending.Verifier, $"{Environment.MachineName} · yadbc"),
                Json,
                ct);
            if (!response.IsSuccessStatusCode) return await ErrorText(response, ct);
            var token = (await response.Content.ReadFromJsonAsync<TokenResponse>(Json, ct))!;
            secrets.SetAppSecret(TokenName, token.Token);
            lock (_lock)
            {
                _url = pending.Url;
                _token = token.Token;
                _tokenLoaded = true;
                _me = token.Me;
                _error = null;
                _catalogTag = null;
            }
            SaveUrl(pending.Url);
            return null;
        }
        catch (HttpRequestException e)
        {
            return $"The broker can't be reached: {e.Message}";
        }
    }

    /// <summary>Signs this device out on the broker (best effort) and forgets the token here.</summary>
    public async Task SignOutAsync(CancellationToken ct)
    {
        if (SignedIn)
        {
            try
            {
                var devices = await SendAsync<List<Device>>(HttpMethod.Get, "/me/devices", null, null, ct);
                if (devices.FirstOrDefault(d => d.Current) is { } current)
                    await SendAsync(HttpMethod.Delete, $"/me/devices/{current.Id}", null, null, ct);
            }
            catch (BrokerException e)
            {
                log.LogInformation("Broker sign-out: {Message}", e.Message);
            }
        }
        Forget();
    }

    void Forget()
    {
        secrets.DeleteAppSecret(TokenName);
        lock (_lock)
        {
            _token = null;
            _tokenLoaded = true;
            _me = null;
            _catalogTag = null;
            _catalog = [];
        }
    }

    // --- broker API -------------------------------------------------------------------------------

    /// <summary>The whole catalog; a 304 reuses the copy from last time.</summary>
    public async Task<List<Share>> CatalogAsync(CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, "/shares", null);
        if (_catalogTag is not null) request.Headers.TryAddWithoutValidation("If-None-Match", _catalogTag);
        using var response = await Send(request, ct);
        if (response.StatusCode == HttpStatusCode.NotModified) return _catalog;
        await EnsureOk(response, ct);
        var list = (await response.Content.ReadFromJsonAsync<List<Share>>(Json, ct))!;
        lock (_lock)
        {
            _catalog = list;
            _catalogTag = response.Headers.ETag?.Tag;
        }
        return list;
    }

    public Task<Share> GetShareAsync(string id, CancellationToken ct) => SendAsync<Share>(HttpMethod.Get, $"/shares/{id}", null, null, ct);

    public Task<Share> PutShareAsync(string id, ShareInput input, int? version, CancellationToken ct) =>
        SendAsync<Share>(HttpMethod.Put, $"/shares/{id}", input, version is null ? null : $"\"{version}\"", ct);

    public Task<Share> SetLoginAsync(string id, ShareLogin login, CancellationToken ct) =>
        SendAsync<Share>(HttpMethod.Put, $"/shares/{id}/login", login, null, ct);

    public Task<ShareLogin> GetLoginAsync(string id, CancellationToken ct) =>
        SendAsync<ShareLogin>(HttpMethod.Get, $"/shares/{id}/login", null, null, ct);

    public Task DeleteShareAsync(string id, CancellationToken ct) => SendAsync(HttpMethod.Delete, $"/shares/{id}", null, null, ct);

    public Task InstallAsync(string id, CancellationToken ct) => SendAsync(HttpMethod.Put, $"/me/installs/{id}", null, null, ct);

    public Task UninstallAsync(string id, CancellationToken ct) => SendAsync(HttpMethod.Delete, $"/me/installs/{id}", null, null, ct);

    public Task<List<PersonRef>> UsersAsync(CancellationToken ct) => SendAsync<List<PersonRef>>(HttpMethod.Get, "/users", null, null, ct);

    async Task<T> SendAsync<T>(HttpMethod method, string path, object? body, string? ifMatch, CancellationToken ct)
    {
        using var response = await SendRaw(method, path, body, ifMatch, ct);
        return (await response.Content.ReadFromJsonAsync<T>(Json, ct))!;
    }

    async Task SendAsync(HttpMethod method, string path, object? body, string? ifMatch, CancellationToken ct)
    {
        using var _ = await SendRaw(method, path, body, ifMatch, ct);
    }

    async Task<HttpResponseMessage> SendRaw(HttpMethod method, string path, object? body, string? ifMatch, CancellationToken ct)
    {
        using var request = Request(method, path, body);
        if (ifMatch is not null) request.Headers.TryAddWithoutValidation("If-Match", ifMatch);
        var response = await Send(request, ct);
        try
        {
            await EnsureOk(response, ct);
            return response;
        }
        catch
        {
            response.Dispose();
            throw;
        }
    }

    HttpRequestMessage Request(HttpMethod method, string path, object? body)
    {
        if (!SignedIn) throw new BrokerException("Not signed in to the shared-connections broker.");
        var request = new HttpRequestMessage(method, _url + path);
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", Token);
        if (body is not null) request.Content = JsonContent.Create(body, options: Json);
        return request;
    }

    async Task<HttpResponseMessage> Send(HttpRequestMessage request, CancellationToken ct)
    {
        try
        {
            return await _http.SendAsync(request, ct);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new BrokerException($"The broker can't be reached ({_url}).");
        }
    }

    async Task EnsureOk(HttpResponseMessage response, CancellationToken ct)
    {
        if (response.IsSuccessStatusCode) return;
        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            // Revoked, expired (90 days unused) or signed out elsewhere: the token is useless now.
            Forget();
            throw new BrokerException("Sign in to the shared-connections broker again.", HttpStatusCode.Unauthorized);
        }
        if (response.StatusCode == HttpStatusCode.PreconditionFailed
            && await response.Content.ReadFromJsonAsync<ShareConflict>(Json, ct) is { } conflict)
            throw new BrokerConflictException(conflict);
        throw new BrokerException(await ErrorText(response, ct), response.StatusCode);
    }

    static async Task<string> ErrorText(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            if (await response.Content.ReadFromJsonAsync<BrokerError>(Json, ct) is { Error: { Length: > 0 } message }) return message;
        }
        catch (JsonException)
        {
        }
        return $"The broker answered {(int)response.StatusCode} {response.ReasonPhrase}.";
    }

    /// <summary>https, or http only for a broker on this machine (testing).</summary>
    public static string NormalizeUrl(string url)
    {
        if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri)
            || !(uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback)))
            throw new BrokerException("The broker address must be an https:// URL.");
        return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
    }

    static string? LoadUrl()
    {
        try
        {
            return File.Exists(SettingsFile) ? JsonSerializer.Deserialize<Settings>(File.ReadAllText(SettingsFile), Json)?.BrokerUrl : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    static void SaveUrl(string url)
    {
        var tmp = SettingsFile + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(new Settings(url), Json));
        File.Move(tmp, SettingsFile, overwrite: true);
    }

    static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
