using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using NormantonNexus.Services;

namespace NormantonNexus.Services.Auth;

/// <summary>
/// Mints the short-lived bearer token backing POST /api/auth/orderbook-token
/// — the Month End Breakdown Excel macro's credential exchange (see
/// middleware/auth.js's requireSessionOrApiToken and routes/auth.js's
/// orderbook-token route). Deliberately signed with the SAME secret
/// SapServerClient already uses (SapServerOptions.JwtSecret — Node's own
/// sapServerSecret, shared with SapServer) but scoped to a different
/// issuer/audience pair, so a token minted here can never be replayed
/// against SapServer (or vice versa) even though both happen to share an
/// underlying secret — matches Node's own design exactly, not a new
/// architecture invented for this port.
/// </summary>
public interface IOrderbookTokenService
{
    /// <summary>20-minute expiry, matching Node's routes/auth.js exactly.</summary>
    string CreateToken(int userId, string username);
}

internal sealed class OrderbookTokenService(IOptions<SapServerOptions> sapServerOptions) : IOrderbookTokenService
{
    internal const string Issuer = "kongsberg-portal";
    internal const string Audience = "orderbook-notes-upload";

    public string CreateToken(int userId, string username)
    {
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(sapServerOptions.Value.JwtSecret));
        var credentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        // ClaimTypes.NameIdentifier/Name — not a custom "userId"/"username" claim shape —
        // so NexusControllerBase.GetUserId()/GetUsername() work identically regardless of
        // whether the request authenticated via the cookie scheme or this bearer scheme.
        var token = new JwtSecurityToken(
            issuer: Issuer,
            audience: Audience,
            claims: [new Claim(ClaimTypes.NameIdentifier, userId.ToString()), new Claim(ClaimTypes.Name, username)],
            expires: DateTime.UtcNow.AddMinutes(20),
            signingCredentials: credentials);

        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}
