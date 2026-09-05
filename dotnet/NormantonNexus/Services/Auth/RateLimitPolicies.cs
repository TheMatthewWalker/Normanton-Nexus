namespace NormantonNexus.Services.Auth;

public static class RateLimitPolicies
{
    /// <summary>Matches routes/auth.js's express-rate-limit config exactly: 10 attempts / 15 min / IP.</summary>
    public const string Login = "login";

    /// <summary>POST /api/auth/orderbook-token — same 10/15min/IP shape as Login, but a genuinely separate counter bucket (Node registers its own independent rateLimit() instance for this route too).</summary>
    public const string OrderbookToken = "orderbook-token";
}
