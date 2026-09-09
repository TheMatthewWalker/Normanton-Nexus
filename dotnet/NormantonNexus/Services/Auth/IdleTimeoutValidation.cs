using Microsoft.AspNetCore.Authentication.Cookies;

namespace NormantonNexus.Services.Auth;

/// <summary>
/// Registered as CookieAuthenticationOptions.Events.OnValidatePrincipal in
/// Program.cs. Runs on every authenticated request and unconditionally
/// extends the ticket's expiry by the user's own idle timeout (30 min
/// default, 5 min for PortalUsers.ShortIdleTimeout users) — the direct
/// analog of server.js's per-request middleware that resets
/// req.session.cookie.maxAge = idleTimeoutMsFor(req.session.user) on every
/// request, which is what makes express-session's rolling:true actually
/// apply the CORRECT per-user duration rather than a single fixed one.
///
/// An already-expired ticket never reaches this handler at all —
/// PortalSessionStore.RetrieveAsync filters ExpiresUtc &gt; GETUTCDATE() itself,
/// so the cookie middleware treats it as "no ticket" before validation ever
/// runs, exactly mirroring sqlSessionStore.js's get()-side expiry filter
/// (see that class's own comments). Nothing here needs to explicitly reject
/// a timed-out request — there's nothing left to reject by the time we'd see it.
/// </summary>
internal static class IdleTimeoutValidation
{
    public static Task OnValidatePrincipal(CookieValidatePrincipalContext context)
    {
        var idleTimeoutPolicy = context.HttpContext.RequestServices.GetRequiredService<IIdleTimeoutPolicy>();

        var isShortIdleTimeout = context.Principal?.HasClaim(c => c.Type == NexusClaimTypes.ShortIdleTimeout) ?? false;
        var timeout = idleTimeoutPolicy.TimeoutFor(isShortIdleTimeout);

        context.Properties.ExpiresUtc = DateTimeOffset.UtcNow.Add(timeout);
        context.ShouldRenew = true;

        return Task.CompletedTask;
    }
}
