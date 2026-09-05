using Microsoft.Extensions.Options;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Tests.Services.Auth;

public class SapCredentialCipherTests
{
    // Arbitrary 32-byte key for tests only — never the real SAP_CRED_ENCRYPTION_KEY.
    private const string TestKeyHex = "4c971aa75d9e25eb4b78ead1590c92ba5f633b82122afc1d51e86ab50c87dfce";

    private static SapCredentialCipher CreateCipher(string keyHex = TestKeyHex) =>
        new(Options.Create(new SapCredentialOptions { EncryptionKeyHex = keyHex }));

    [Fact]
    public void Decrypt_reverses_Encrypt_for_a_typical_password()
    {
        var cipher = CreateCipher();

        var packed = cipher.Encrypt("Sup3r$ecretPassword!");

        Assert.Equal("Sup3r$ecretPassword!", cipher.Decrypt(packed));
    }

    [Fact]
    public void Encrypt_produces_a_different_ciphertext_each_time_due_to_a_random_IV()
    {
        var cipher = CreateCipher();

        var first = cipher.Encrypt("same-plaintext");
        var second = cipher.Encrypt("same-plaintext");

        Assert.NotEqual(first, second);
        Assert.Equal("same-plaintext", cipher.Decrypt(first));
        Assert.Equal("same-plaintext", cipher.Decrypt(second));
    }

    [Fact]
    public void Decrypt_round_trips_unicode_characters_correctly()
    {
        var cipher = CreateCipher();

        var packed = cipher.Encrypt("pässwörd-日本語-🔒");

        Assert.Equal("pässwörd-日本語-🔒", cipher.Decrypt(packed));
    }

    [Fact]
    public void Encrypt_throws_when_the_key_is_not_configured()
    {
        var cipher = CreateCipher(keyHex: "");

        Assert.Throws<InvalidOperationException>(() => cipher.Encrypt("x"));
    }

    [Fact]
    public void Encrypt_throws_when_the_configured_key_is_the_wrong_length()
    {
        var cipher = CreateCipher(keyHex: "abcd"); // 2 bytes, not 32

        Assert.Throws<InvalidOperationException>(() => cipher.Encrypt("x"));
    }

    [Fact]
    public void Decrypt_throws_when_a_tampered_ciphertext_fails_the_GCM_auth_tag_check()
    {
        var cipher = CreateCipher();
        var packed = cipher.Encrypt("original");
        // Byte 12 is the first byte of the 16-byte auth tag (after the 12-byte IV) —
        // flipping it always exists regardless of plaintext length, unlike a fixed
        // offset into the ciphertext region.
        var tampered = Convert.ToBase64String(Convert.FromBase64String(packed).Select((b, i) => i == 12 ? (byte)(b ^ 0xFF) : b).ToArray());

        Assert.ThrowsAny<System.Security.Cryptography.CryptographicException>(() => cipher.Decrypt(tampered));
    }
}
