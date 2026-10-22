using Meziantou.Framework.Win32;

namespace Yadbc.Host.Connections;

/// <summary>
/// Passwords in Windows Credential Manager (DPAPI-protected, per Windows user).
/// Windows-only for now; macOS Keychain / libsecret go here when Photino runs elsewhere.
/// Entries are `yadbc:{connectionId}` and `yadbc:app:{name}`; YADBC_CREDENTIAL_PREFIX replaces `yadbc`
/// so a test instance (with its own YADBC_DATA_DIR) never reads or overwrites the real app's secrets.
/// </summary>
public sealed class SecretStore
{
    static readonly string Prefix = Environment.GetEnvironmentVariable("YADBC_CREDENTIAL_PREFIX") is { Length: > 0 } p ? p : "yadbc";

    static string Target(string connectionId) => $"{Prefix}:{connectionId}";

    static string AppTarget(string name) => $"{Prefix}:app:{name}";

    public string? GetPassword(string connectionId)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(5, 1, 2600)) throw NotSupported();
        return CredentialManager.ReadCredential(Target(connectionId))?.Password;
    }

    public void SetPassword(string connectionId, string username, string password)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(5, 1, 2600)) throw NotSupported();
        CredentialManager.WriteCredential(Target(connectionId), username, password,
            "yadbc connection password", CredentialPersistence.LocalMachine);
    }

    /// <summary>App-level secrets (e.g. the MCP token), under `yadbc:app:{name}`.</summary>
    public string? GetAppSecret(string name)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(5, 1, 2600)) throw NotSupported();
        return CredentialManager.ReadCredential(AppTarget(name))?.Password;
    }

    public void SetAppSecret(string name, string value)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(5, 1, 2600)) throw NotSupported();
        CredentialManager.WriteCredential(AppTarget(name), "yadbc", value, "yadbc", CredentialPersistence.LocalMachine);
    }

    public void DeleteAppSecret(string name)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(5, 1, 2600)) throw NotSupported();
        if (CredentialManager.ReadCredential(AppTarget(name)) is not null)
            CredentialManager.DeleteCredential(AppTarget(name));
    }

    public void Delete(string connectionId)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(5, 1, 2600)) throw NotSupported();
        if (CredentialManager.ReadCredential(Target(connectionId)) is not null)
            CredentialManager.DeleteCredential(Target(connectionId));
    }

    static PlatformNotSupportedException NotSupported() => new("Credential storage is Windows-only for now");
}
