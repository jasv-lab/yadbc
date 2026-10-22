namespace Yadbc.Broker;

/// <summary>
/// The "Broker" config section (appsettings, or env vars like <c>Broker__Oidc__ClientSecret</c>).
/// Secrets — the OIDC client secret and the login key — come from a k8s Secret, never from the repo.
/// </summary>
public sealed class BrokerOptions
{
    /// <summary>broker.db and its nightly backups (a PVC in the cluster).</summary>
    public string DataDir { get; set; } = "data";

    /// <summary>Base64 of 32 random bytes: the AES-GCM key for share logins. Losing it loses every stored login.</summary>
    public string LoginKey { get; set; } = "";

    /// <summary>How long a device stays signed in without being used; every use extends it.</summary>
    public int DeviceTokenDays { get; set; } = 90;

    public int BackupKeepDays { get; set; } = 7;

    public OidcOptions Oidc { get; set; } = new();

    public sealed class OidcOptions
    {
        /// <summary>Issuer, e.g. https://login.microsoftonline.com/{tenant}/v2.0 or a Keycloak realm URL.</summary>
        public string Authority { get; set; } = "";
        public string ClientId { get; set; } = "";
        public string ClientSecret { get; set; } = "";
        /// <summary>Extra scopes besides openid; profile and email give names in the owner picker.</summary>
        public string[] Scopes { get; set; } = ["profile", "email"];
        /// <summary>Providers that keep names and emails out of the ID token need the userinfo call.</summary>
        public bool UseUserInfo { get; set; }
        /// <summary>Stable user id: the first claim present. Entra's oid is the same across its apps.</summary>
        public string[] IdClaims { get; set; } = ["oid", "sub"];
        /// <summary>Admins (edit or delete any share): an app role in Entra's roles claim by default.</summary>
        public string AdminClaim { get; set; } = "roles";
        public string AdminValue { get; set; } = "yadbc.admin";
        /// <summary>Only for a local test provider on plain http; real providers are https.</summary>
        public bool RequireHttpsMetadata { get; set; } = true;
    }

    public void Validate()
    {
        var missing = new List<string>();
        if (string.IsNullOrWhiteSpace(Oidc.Authority)) missing.Add("Broker:Oidc:Authority");
        if (string.IsNullOrWhiteSpace(Oidc.ClientId)) missing.Add("Broker:Oidc:ClientId");
        if (string.IsNullOrWhiteSpace(LoginKey)) missing.Add("Broker:LoginKey");
        if (missing.Count > 0) throw new InvalidOperationException($"Missing configuration: {string.Join(", ", missing)}");
    }
}
