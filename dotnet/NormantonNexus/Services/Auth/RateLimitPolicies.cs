namespace NormantonNexus.Services.Auth;

public static class RateLimitPolicies
{
    /// <summary>Matches routes/auth.js's express-rate-limit config exactly: 10 attempts / 15 min / IP.</summary>
    public const string Login = "login";
}
