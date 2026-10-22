using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Yadbc.Broker.Auth;
using Yadbc.Broker.Storage;
using Yadbc.Contracts.Broker;

namespace Yadbc.Broker.Tests;

/// <summary>
/// The broker over HTTP, with a fresh database. The provider's part of sign-in is skipped: a person is
/// created as /login/complete would, then signs in through the real one-time code and /token.
/// </summary>
public sealed class BrokerFixture : IDisposable
{
    public readonly WebApplicationFactory<Program> Factory;
    public readonly string DataDir = Path.Combine(Path.GetTempPath(), "yadbc-broker-tests-" + Guid.NewGuid().ToString("N"));

    public BrokerFixture()
    {
        // Program reads its options before the host is built, so they go in as environment variables.
        Environment.SetEnvironmentVariable("Broker__DataDir", DataDir);
        Environment.SetEnvironmentVariable("Broker__LoginKey", Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)));
        Environment.SetEnvironmentVariable("Broker__Oidc__Authority", "https://login.example.invalid/");
        Environment.SetEnvironmentVariable("Broker__Oidc__ClientId", "yadbc-broker-tests");
        Factory = new WebApplicationFactory<Program>();
        _ = Factory.Server; // start it now, while the variables are set
    }

    public void Dispose()
    {
        Factory.Dispose();
        SqliteClearPools();
        try { Directory.Delete(DataDir, recursive: true); } catch (IOException) { }
    }

    static void SqliteClearPools() => Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
}

public class ApiTests(BrokerFixture broker) : IClassFixture<BrokerFixture>
{
    const string Verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const string Challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    async Task<HttpClient> SignIn(string name, bool admin = false)
    {
        var id = name.ToLowerInvariant() + "-" + Guid.NewGuid().ToString("N")[..6];
        var services = broker.Factory.Services;
        await services.GetRequiredService<Db>().Run(sql => sql.Upsert(id, name, $"{id}@example.com", admin));
        var code = services.GetRequiredService<LoginCodes>().Create(id, Challenge);
        var client = broker.Factory.CreateClient();
        var token = await (await client.PostAsJsonAsync("/token", new TokenRequest(code, Verifier, "test pc"), Json))
            .EnsureSuccessStatusCode().Content.ReadFromJsonAsync<TokenResponse>(Json);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token!.Token);
        Assert.Equal(name, token.Me.User.Name);
        return client;
    }

    static ShareInput Input(string name, LoginMode mode = LoginMode.Included, string[]? owners = null) =>
        new(name, "db.example.internal", 5432, "app", ShareEnv.Prod, mode, new ShareTunnel(TunnelKind.Kubernetes, KubeNamespace: "app", KubeTarget: "svc/pg"), false, owners);

    static string NewId() => "s" + Guid.NewGuid().ToString("N")[..10];

    static async Task<Share> Create(HttpClient client, string id, ShareInput input)
    {
        var res = await client.PutAsJsonAsync($"/shares/{id}", input, Json);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<Share>(Json))!;
    }

    static Task<HttpResponseMessage> Update(HttpClient client, string id, ShareInput input, int version)
    {
        var req = new HttpRequestMessage(HttpMethod.Put, $"/shares/{id}") { Content = JsonContent.Create(input, options: Json) };
        req.Headers.TryAddWithoutValidation("If-Match", $"\"{version}\"");
        return client.SendAsync(req);
    }

    [Fact]
    public async Task Without_a_token_nothing_is_visible()
    {
        var anonymous = broker.Factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/shares")).StatusCode);
        anonymous.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "ybt_made-up");
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/me")).StatusCode);
    }

    [Fact]
    public async Task A_code_signs_in_once()
    {
        var code = broker.Factory.Services.GetRequiredService<LoginCodes>().Create("nobody", Challenge);
        var client = broker.Factory.CreateClient();
        await broker.Factory.Services.GetRequiredService<Db>().Run(sql => sql.Upsert("nobody", "Nobody", null, false));
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/token", new TokenRequest(code, Verifier, "pc"), Json)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/token", new TokenRequest(code, Verifier, "pc"), Json)).StatusCode);
    }

    [Fact]
    public async Task Everyone_sees_a_share_and_its_login_but_only_owners_change_it()
    {
        var jan = await SignIn("Jan");
        var petr = await SignIn("Petr");
        var id = NewId();

        var share = await Create(jan, id, Input("Billing prod"));
        Assert.True(share.CanEdit);
        Assert.False(share.HasLogin);
        Assert.Equal(1, share.Version);
        Assert.Equal(TunnelKind.Kubernetes, share.Tunnel!.Kind);

        Assert.Equal(HttpStatusCode.OK, (await jan.PutAsJsonAsync($"/shares/{id}/login", new ShareLogin("app_ro", "s3cret"), Json)).StatusCode);

        var seen = (await petr.GetFromJsonAsync<Share[]>("/shares", Json))!.Single(s => s.Id == id);
        Assert.False(seen.CanEdit);
        Assert.True(seen.HasLogin);
        Assert.Equal("app_ro", seen.Username);

        var login = await petr.GetFromJsonAsync<ShareLogin>($"/shares/{id}/login", Json);
        Assert.Equal(new ShareLogin("app_ro", "s3cret"), login);

        Assert.Equal(HttpStatusCode.Forbidden, (await Update(petr, id, Input("Hijacked"), seen.Version)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await petr.DeleteAsync($"/shares/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await petr.PutAsJsonAsync($"/shares/{id}/login", new ShareLogin("x", "y"), Json)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await petr.GetAsync($"/shares/{id}/audit")).StatusCode);

        var audit = (await jan.GetFromJsonAsync<AuditEntry[]>($"/shares/{id}/audit", Json))!;
        Assert.Equal([Audit.LoginFetched, Audit.LoginSet, Audit.ShareCreated], audit.Select(a => a.Action));
        Assert.Equal("Petr", audit[0].User!.Name);
    }

    [Fact]
    public async Task Saving_over_someone_elses_change_is_refused()
    {
        var jan = await SignIn("Jan");
        var id = NewId();
        var share = await Create(jan, id, Input("Orders"));

        Assert.Equal(HttpStatusCode.OK, (await Update(jan, id, Input("Orders (new)"), share.Version)).StatusCode);
        var stale = await Update(jan, id, Input("Orders (stale)"), share.Version);
        Assert.Equal(HttpStatusCode.PreconditionFailed, stale.StatusCode);
        var conflict = await stale.Content.ReadFromJsonAsync<ShareConflict>(Json);
        Assert.Equal(2, conflict!.Version);
        Assert.Equal("Jan", conflict.UpdatedBy.Name);

        var blind = await jan.PutAsJsonAsync($"/shares/{id}", Input("Orders (blind)"), Json);
        Assert.Equal((HttpStatusCode)428, blind.StatusCode);
    }

    [Fact]
    public async Task A_template_share_has_no_login_to_give()
    {
        var jan = await SignIn("Jan");
        var id = NewId();
        var share = await Create(jan, id, Input("Reporting"));
        await jan.PutAsJsonAsync($"/shares/{id}/login", new ShareLogin("report", "pw"), Json);

        // Switching to "everyone brings their own" drops the stored login.
        var res = await Update(jan, id, Input("Reporting", LoginMode.Own), share.Version + 1);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var updated = (await res.Content.ReadFromJsonAsync<Share>(Json))!;
        Assert.False(updated.HasLogin);
        Assert.Null(updated.Username);
        Assert.Equal(HttpStatusCode.Conflict, (await jan.GetAsync($"/shares/{id}/login")).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await jan.PutAsJsonAsync($"/shares/{id}/login", new ShareLogin("a", "b"), Json)).StatusCode);
    }

    [Fact]
    public async Task Co_owners_and_admins_can_edit()
    {
        var jan = await SignIn("Jan");
        var petr = await SignIn("Petr");
        var admin = await SignIn("Admin", admin: true);
        var petrId = (await petr.GetFromJsonAsync<Me>("/me", Json))!.User.Id;
        var id = NewId();

        var share = await Create(jan, id, Input("Shared", owners: [petrId]));
        Assert.Equal(2, share.Owners.Length); // the person sharing always stays an owner
        Assert.Equal(HttpStatusCode.OK, (await Update(petr, id, Input("Shared by Petr"), share.Version)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Update(admin, id, Input("Shared by admin"), share.Version + 1)).StatusCode);

        var unknown = await jan.PutAsJsonAsync($"/shares/{NewId()}", Input("X", owners: ["never-signed-in"]), Json);
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync($"/shares/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await jan.GetAsync($"/shares/{id}")).StatusCode);
    }

    [Fact]
    public async Task Installs_are_counted_and_follow_a_deleted_share()
    {
        var jan = await SignIn("Jan");
        var petr = await SignIn("Petr");
        var id = NewId();
        await Create(jan, id, Input("Installed"));

        Assert.Equal(HttpStatusCode.NoContent, (await petr.PutAsync($"/me/installs/{id}", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await petr.PutAsync($"/me/installs/{id}", null)).StatusCode); // idempotent
        Assert.Equal(HttpStatusCode.NotFound, (await petr.PutAsync($"/me/installs/{NewId()}", null)).StatusCode);

        var seen = (await petr.GetFromJsonAsync<Share>($"/shares/{id}", Json))!;
        Assert.True(seen.InstalledByMe);
        Assert.Equal(1, seen.Installs);
        Assert.Contains(id, (await petr.GetFromJsonAsync<Me>("/me", Json))!.Installs);

        await jan.DeleteAsync($"/shares/{id}");
        Assert.DoesNotContain(id, (await petr.GetFromJsonAsync<Me>("/me", Json))!.Installs);
    }

    [Fact]
    public async Task An_unchanged_catalog_is_a_304()
    {
        var jan = await SignIn("Jan");
        var first = await jan.GetAsync("/shares");
        var etag = first.Headers.ETag!.Tag;

        var again = new HttpRequestMessage(HttpMethod.Get, "/shares");
        again.Headers.TryAddWithoutValidation("If-None-Match", etag);
        Assert.Equal(HttpStatusCode.NotModified, (await jan.SendAsync(again)).StatusCode);

        await Create(jan, NewId(), Input("Changes the catalog"));
        var after = new HttpRequestMessage(HttpMethod.Get, "/shares");
        after.Headers.TryAddWithoutValidation("If-None-Match", etag);
        Assert.Equal(HttpStatusCode.OK, (await jan.SendAsync(after)).StatusCode);
    }

    [Fact]
    public async Task Signing_a_device_out_stops_its_token()
    {
        var jan = await SignIn("Jan");
        var devices = (await jan.GetFromJsonAsync<Device[]>("/me/devices", Json))!;
        var current = Assert.Single(devices);
        Assert.True(current.Current);
        Assert.Equal("test pc", current.Name);

        Assert.Equal(HttpStatusCode.NoContent, (await jan.DeleteAsync($"/me/devices/{current.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await jan.GetAsync("/me")).StatusCode);
    }

    [Fact]
    public async Task Invalid_shares_are_refused_with_a_reason()
    {
        var jan = await SignIn("Jan");
        var res = await jan.PutAsJsonAsync($"/shares/{NewId()}", Input("X") with { Port = 0 }, Json);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Contains("port", (await res.Content.ReadFromJsonAsync<BrokerError>(Json))!.Error);

        var tunnel = Input("X") with { Tunnel = new ShareTunnel(TunnelKind.Ssh) };
        Assert.Equal(HttpStatusCode.BadRequest, (await jan.PutAsJsonAsync($"/shares/{NewId()}", tunnel, Json)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await jan.PutAsJsonAsync("/shares/bad id!", Input("X"), Json)).StatusCode);
    }

    [Fact]
    public async Task Backup_writes_a_readable_copy()
    {
        var jan = await SignIn("Jan");
        await Create(jan, NewId(), Input("Backed up"));
        var file = await broker.Factory.Services.GetRequiredService<Backup>().RunOnce();
        Assert.True(File.Exists(file));
        using var copy = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={file};Mode=ReadOnly;Pooling=False");
        copy.Open();
        using var cmd = copy.CreateCommand();
        cmd.CommandText = "select count(*) from shares where name = 'Backed up'";
        Assert.Equal(1L, cmd.ExecuteScalar());
    }
}
