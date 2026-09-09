using NormantonNexus.Services.Auth;

namespace NormantonNexus.Tests.Services.Auth;

public class AuthServiceTests
{
    // Matches routes/profile.js's POST /change-password validation exactly
    // (>= 10 chars, one uppercase letter, one digit) — the bug this test
    // guards against: an earlier version of this port used only a bare
    // `length < 8` check with no complexity requirement, silently weaker
    // than Node's real policy.

    [Theory]
    [InlineData("Abcdefghij1", true)]
    [InlineData("Abcdefghi1", true)] // exactly 10 chars
    [InlineData("Abcdefgh1", false)] // 9 chars — too short
    [InlineData("abcdefghij1", false)] // no uppercase
    [InlineData("Abcdefghijk", false)] // no digit
    public void IsStrongEnoughPassword_matches_Nodes_10char_uppercase_digit_rule(string password, bool expected)
    {
        Assert.Equal(expected, AuthService.IsStrongEnoughPassword(password));
    }
}
