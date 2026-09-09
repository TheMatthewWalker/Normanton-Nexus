using Microsoft.Extensions.Options;

namespace NormantonNexus.Services.Auth;

public sealed class AuthOptions
{
    public const string SectionName = "Auth";

    /// <summary>Mirrors config.js's IDLE_TIMEOUT_MS default (30 min).</summary>
    public int DefaultIdleTimeoutMinutes { get; set; } = 30;

    /// <summary>Mirrors config.js's SHORT_IDLE_TIMEOUT_MS default (5 min) — PortalUsers.ShortIdleTimeout users.</summary>
    public int ShortIdleTimeoutMinutes { get; set; } = 5;

    /// <summary>Mirrors routes/auth.js's lockout threshold — locks the account permanently until an admin unlocks it.</summary>
    public int MaxFailedLoginsBeforeLock { get; set; } = 10;
}

/// <summary>
/// Per-user variable idle timeout, computed from a claim baked into the auth
/// ticket at login (PortalUsers.ShortIdleTimeout — same "read once at login,
/// only takes effect on next login if changed" semantics as Node's
/// idleTimeoutMsFor/session.user.shortIdleTimeout). Applied every request by
/// CookieAuthenticationEvents.OnValidatePrincipal (Program.cs) to reproduce
/// express-session's rolling:true per-request expiry refresh.
/// </summary>
public interface IIdleTimeoutPolicy
{
    TimeSpan DefaultTimeout { get; }
    TimeSpan ShortTimeout { get; }
    TimeSpan TimeoutFor(bool shortIdleTimeout);
}

internal sealed class IdleTimeoutPolicy(IOptions<AuthOptions> options) : IIdleTimeoutPolicy
{
    private readonly AuthOptions _options = options.Value;

    public TimeSpan DefaultTimeout => TimeSpan.FromMinutes(_options.DefaultIdleTimeoutMinutes);
    public TimeSpan ShortTimeout => TimeSpan.FromMinutes(_options.ShortIdleTimeoutMinutes);

    public TimeSpan TimeoutFor(bool shortIdleTimeout) => shortIdleTimeout ? ShortTimeout : DefaultTimeout;
}
