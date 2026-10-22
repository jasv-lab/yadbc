using System.Security.Cryptography;
using System.Text;

namespace Yadbc.Broker.Shares;

/// <summary>
/// Share passwords at rest: AES-256-GCM with the key from config (a k8s Secret), bound to their share
/// id (associated data) so a ciphertext copied onto another share won't decrypt. Layout:
/// version byte · 12-byte nonce · 16-byte tag · ciphertext. The version byte leaves room to rotate keys.
/// </summary>
public sealed class LoginVault
{
    const byte Version = 1;
    readonly byte[] _key;

    public LoginVault(BrokerOptions options)
    {
        try
        {
            _key = Convert.FromBase64String(options.LoginKey);
        }
        catch (FormatException)
        {
            throw new InvalidOperationException("Broker:LoginKey must be base64 (openssl rand -base64 32)");
        }
        if (_key.Length != 32) throw new InvalidOperationException("Broker:LoginKey must be 32 bytes (openssl rand -base64 32)");
    }

    public byte[] Seal(string shareId, string password)
    {
        var plain = Encoding.UTF8.GetBytes(password);
        var output = new byte[1 + 12 + 16 + plain.Length];
        output[0] = Version;
        var nonce = output.AsSpan(1, 12);
        RandomNumberGenerator.Fill(nonce);
        using var aes = new AesGcm(_key, 16);
        aes.Encrypt(nonce, plain, output.AsSpan(29), output.AsSpan(13, 16), Encoding.UTF8.GetBytes(shareId));
        return output;
    }

    public string Open(string shareId, byte[] sealedBytes)
    {
        if (sealedBytes.Length < 29 || sealedBytes[0] != Version) throw new CryptographicException("Unknown login format");
        var plain = new byte[sealedBytes.Length - 29];
        using var aes = new AesGcm(_key, 16);
        aes.Decrypt(
            sealedBytes.AsSpan(1, 12),
            sealedBytes.AsSpan(29),
            sealedBytes.AsSpan(13, 16),
            plain,
            Encoding.UTF8.GetBytes(shareId));
        return Encoding.UTF8.GetString(plain);
    }
}
