using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace NormantonNexus.Services.Auth;

public sealed class SapCredentialOptions
{
    public const string SectionName = "SapCredentials";

    /// <summary>64-character hex string (32 raw bytes) — MUST be the exact same value as the Node app's SAP_CRED_ENCRYPTION_KEY env var, or existing encrypted rows can't be decrypted and newly-encrypted ones can't be read back by Node.</summary>
    public string EncryptionKeyHex { get; set; } = "";
}

/// <summary>
/// Faithful C# port of lib/sapCredentials.js's encrypt/decrypt pair —
/// AES-256-GCM, 12-byte nonce, 16-byte tag, packed as
/// base64(IV[12] || authTag[16] || ciphertext), UTF-8 plaintext. Used to
/// read a user's own saved SAP password (PortalUsers.SapPasswordEncrypted)
/// for the Engineering "New Packaging Creation" tile's elevated SAP call —
/// see Helpers/Engineering/EngineeringHelper.cs. Byte-for-byte compatible
/// with the Node implementation as long as EncryptionKeyHex matches
/// SAP_CRED_ENCRYPTION_KEY exactly (confirmed against the real Node source,
/// not guessed — see lib/sapCredentials.js).
/// </summary>
public interface ISapCredentialCipher
{
    string Encrypt(string plaintext);
    string Decrypt(string packedBase64);
}

internal sealed class SapCredentialCipher(IOptions<SapCredentialOptions> options) : ISapCredentialCipher
{
    private const int IvLength = 12;
    private const int TagLength = 16;
    private const int KeyLength = 32;

    private byte[] ResolveKey()
    {
        var configured = options.Value.EncryptionKeyHex;
        if (string.IsNullOrEmpty(configured))
        {
            throw new InvalidOperationException(
                "SapCredentials:EncryptionKeyHex is not configured — cannot save or use SAP credentials.");
        }

        var key = Convert.FromHexString(configured);
        if (key.Length != KeyLength)
        {
            throw new InvalidOperationException(
                $"SapCredentials:EncryptionKeyHex must decode to {KeyLength} bytes (a 64-character hex string) — got {key.Length}.");
        }

        return key;
    }

    public string Encrypt(string plaintext)
    {
        var key = ResolveKey();
        var iv = RandomNumberGenerator.GetBytes(IvLength);
        var plaintextBytes = Encoding.UTF8.GetBytes(plaintext);
        var ciphertext = new byte[plaintextBytes.Length];
        var tag = new byte[TagLength];

        using (var aesGcm = new AesGcm(key, TagLength))
        {
            aesGcm.Encrypt(iv, plaintextBytes, ciphertext, tag);
        }

        var packed = new byte[IvLength + TagLength + ciphertext.Length];
        iv.CopyTo(packed, 0);
        tag.CopyTo(packed, IvLength);
        ciphertext.CopyTo(packed, IvLength + TagLength);

        return Convert.ToBase64String(packed);
    }

    public string Decrypt(string packedBase64)
    {
        var key = ResolveKey();
        var packed = Convert.FromBase64String(packedBase64);

        var iv = packed.AsSpan(0, IvLength);
        var tag = packed.AsSpan(IvLength, TagLength);
        var ciphertext = packed.AsSpan(IvLength + TagLength);

        var plaintextBytes = new byte[ciphertext.Length];
        using (var aesGcm = new AesGcm(key, TagLength))
        {
            aesGcm.Decrypt(iv, ciphertext, tag, plaintextBytes);
        }

        return Encoding.UTF8.GetString(plaintextBytes);
    }
}
