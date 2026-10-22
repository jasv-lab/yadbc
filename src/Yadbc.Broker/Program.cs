using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using Yadbc.Broker;
using Yadbc.Broker.Auth;
using Yadbc.Broker.Shares;
using Yadbc.Broker.Storage;

// yadbc's shared-connections broker: a team catalog of connections and their logins (docs/design.md §10b).
// It never connects to a database; it hands out connection details to signed-in people.

var builder = WebApplication.CreateBuilder(args);
var options = builder.Configuration.GetSection("Broker").Get<BrokerOptions>() ?? new BrokerOptions();
options.Validate();

builder.Services.AddSingleton(options);
builder.Services.AddSingleton<Db>();
builder.Services.AddSingleton<LoginVault>();
builder.Services.AddSingleton<LoginCodes>();
builder.Services.AddSingleton<Backup>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<Backup>());

// The OIDC handler's correlation and nonce cookies are encrypted with ASP.NET's key ring. Kept on the
// data volume: the image's filesystem is read-only, and a restart mid-sign-in shouldn't break it.
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(options.DataDir, "keys")))
    .SetApplicationName("yadbc-broker");

builder.Services.ConfigureHttpJsonOptions(o =>
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase)));

builder.Services
    .AddAuthentication(DeviceTokens.Scheme)
    .AddScheme<Microsoft.AspNetCore.Authentication.AuthenticationSchemeOptions, DeviceTokenHandler>(DeviceTokens.Scheme, null)
    .AddProviderSignIn(options);
builder.Services.AddAuthorization();

// TLS ends at the gateway (Envoy): take the scheme and client address from its headers, so the OIDC
// redirect URL is https. Only the gateway reaches the pod, so its headers are trusted as they come.
builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    o.KnownIPNetworks.Clear();
    o.KnownProxies.Clear();
});

var app = builder.Build();
app.Services.GetRequiredService<LoginVault>(); // a bad key fails at startup, not at the first login
app.UseForwardedHeaders();
// No stack traces to the browser; the usual cause is the identity provider being unreachable.
app.UseExceptionHandler(errors => errors.Run(async http =>
{
    http.Response.StatusCode = StatusCodes.Status502BadGateway;
    await http.Response.WriteAsJsonAsync(new Yadbc.Contracts.Broker.BrokerError(
        http.Request.Path.StartsWithSegments("/login")
            ? "Sign-in is unavailable: the broker can't reach the identity provider. Try again later."
            : "The broker hit an error. Try again; if it keeps happening, check the broker's log."));
}));
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/healthz", async (Db db) => await db.Run(sql => sql.Scalar<long>("select 1")) == 1 ? Results.Ok("ok") : Results.StatusCode(503));
app.MapLoginFlow();
app.MapDeviceEndpoints();
app.MapShareEndpoints();

app.Run();

public partial class Program;
