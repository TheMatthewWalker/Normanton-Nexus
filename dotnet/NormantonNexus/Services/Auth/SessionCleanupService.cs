using Dapper;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Services.Auth;

/// <summary>
/// Expired dbo.PortalSessions row cleanup — C# analog of Node's hourly
/// `sessionStore.cleanupExpired()` cron job (server.js). `PortalSessionStore.RetrieveAsync`
/// already filters on `ExpiresUtc &gt; GETUTCDATE()` itself, so an expired row is silently
/// treated as "not authenticated" regardless of whether this runs — this is pure
/// housekeeping to stop the table growing unbounded with rows nobody will ever read
/// again, not something correctness depends on. Deferred from Phase 1 to Phase 10's
/// Quartz.NET job wiring — see PortalSessionStore's own header comment.
/// </summary>
public interface ISessionCleanupService
{
    Task<int> CleanupExpiredAsync(CancellationToken ct = default);
}

internal sealed class SessionCleanupService(INexusDb db) : ISessionCleanupService
{
    public async Task<int> CleanupExpiredAsync(CancellationToken ct = default)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.ExecuteAsync(new CommandDefinition(
            "DELETE FROM dbo.PortalSessions WHERE ExpiresUtc <= GETUTCDATE()", cancellationToken: ct));
    }
}
