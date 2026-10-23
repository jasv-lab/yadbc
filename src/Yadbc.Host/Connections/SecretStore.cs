using System.ComponentModel;
using System.Diagnostics;
using Meziantou.Framework.Win32;

namespace Yadbc.Host.Connections;

/// <summary>
/// Passwords and app secrets in the OS's own store, never in config files: Windows Credential Manager
/// (DPAPI-protected, per Windows user), or on Linux the desktop keyring through libsecret's `secret-tool`
/// (GNOME Keyring, KWallet). macOS Keychain goes here when there's a macOS build.
/// Entries are `yadbc:{connectionId}` and `yadbc:app:{name}`; YADBC_CREDENTIAL_PREFIX replaces `yadbc`
/// so a test instance (with its own YADBC_DATA_DIR) never reads or overwrites the real app's secrets.
/// </summary>
public sealed class SecretStore
{
    static readonly string Prefix = Environment.GetEnvironmentVariable("YADBC_CREDENTIAL_PREFIX") is { Length: > 0 } p ? p : "yadbc";

    static string Target(string connectionId) => $"{Prefix}:{connectionId}";

    static string AppTarget(string name) => $"{Prefix}:app:{name}";

    public string? GetPassword(string connectionId) => ReadSecret(Target(connectionId));

    public void SetPassword(string connectionId, string username, string password) =>
        WriteSecret(Target(connectionId), username, password, "yadbc connection password");

    /// <summary>App-level secrets (e.g. the MCP token), under `yadbc:app:{name}`.</summary>
    public string? GetAppSecret(string name) => ReadSecret(AppTarget(name));

    public void SetAppSecret(string name, string value) => WriteSecret(AppTarget(name), "yadbc", value, "yadbc");

    public void DeleteAppSecret(string name) => DeleteSecret(AppTarget(name));

    public void Delete(string connectionId) => DeleteSecret(Target(connectionId));

    static string? ReadSecret(string target)
    {
        if (OperatingSystem.IsWindowsVersionAtLeast(5, 1, 2600)) return CredentialManager.ReadCredential(target)?.Password;
        if (OperatingSystem.IsLinux()) return SecretTool.Lookup(target);
        throw NotSupported();
    }

    static void WriteSecret(string target, string username, string value, string comment)
    {
        if (OperatingSystem.IsWindowsVersionAtLeast(5, 1, 2600))
            CredentialManager.WriteCredential(target, username, value, comment, CredentialPersistence.LocalMachine);
        else if (OperatingSystem.IsLinux()) SecretTool.Store(target, username, value);
        else throw NotSupported();
    }

    static void DeleteSecret(string target)
    {
        if (OperatingSystem.IsWindowsVersionAtLeast(5, 1, 2600))
        {
            if (CredentialManager.ReadCredential(target) is not null) CredentialManager.DeleteCredential(target);
        }
        else if (OperatingSystem.IsLinux()) SecretTool.Clear(target);
        else throw NotSupported();
    }

    static PlatformNotSupportedException NotSupported() => new("Saving passwords isn't supported on this OS yet");

    /// <summary>
    /// libsecret's command-line client, so there's no native binding to ship. Entries carry the attributes
    /// application=yadbc and target={target}; the secret goes through stdin, never the command line.
    /// </summary>
    static class SecretTool
    {
        const string Missing =
            "Saving passwords on Linux needs secret-tool (package libsecret-tools) and a running keyring (GNOME Keyring or KWallet).";

        public static string? Lookup(string target)
        {
            var (exit, output, error) = Run(["lookup", "application", "yadbc", "target", target], null);
            // Not found is exit 1 with nothing on stderr; a missing or locked keyring says why on stderr.
            if (exit == 0) return output;
            if (error.Length == 0) return null;
            throw new InvalidOperationException($"The keyring couldn't be read: {error}");
        }

        public static void Store(string target, string username, string value)
        {
            var (exit, _, error) = Run(
                ["store", $"--label=yadbc: {target}", "application", "yadbc", "target", target, "user", username], value);
            if (exit != 0) throw new InvalidOperationException($"The keyring couldn't save the secret: {error}");
        }

        public static void Clear(string target)
        {
            var (exit, _, error) = Run(["clear", "application", "yadbc", "target", target], null);
            if (exit != 0 && error.Length > 0) throw new InvalidOperationException($"The keyring couldn't delete the secret: {error}");
        }

        static (int Exit, string Output, string Error) Run(string[] args, string? stdin)
        {
            var start = new ProcessStartInfo("secret-tool")
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (var a in args) start.ArgumentList.Add(a);
            Process process;
            try
            {
                process = Process.Start(start)!;
            }
            catch (Win32Exception)
            {
                throw new InvalidOperationException(Missing);
            }
            using (process)
            {
                if (stdin is not null) process.StandardInput.Write(stdin);
                process.StandardInput.Close();
                var output = process.StandardOutput.ReadToEndAsync();
                var error = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(15_000))
                {
                    process.Kill();
                    throw new InvalidOperationException("The keyring didn't answer (is it locked and waiting for a password?).");
                }
                return (process.ExitCode, output.Result, error.Result.Trim());
            }
        }
    }
}
