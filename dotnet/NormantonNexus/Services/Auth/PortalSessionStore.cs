using System.Security.Cryptography;
using Dapper;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Services.Auth;

/// <summary>
/// SQL-backed cookie authentication ticket store — the direct C# analog of
/// lib/sqlSessionStore.js's express-session Store. The browser cookie holds
/// only an opaque session key; the real ticket (claims, expiry) lives in
/// dbo.PortalSessions, so a deploy/app-pool-recycle doesn't log everyone out
/// and a per-tile-permission claim list of any size never bloats the cookie.
///
/// Table shape is unchanged from the existing app's PortalSessions
/// (SessionID/SessionData/ExpiresUtc/CreatedUtc/UpdatedUtc) — see the
/// migration plan's "Schema stays as-is" principle. SessionData here holds a
/// base64-encoded serialized AuthenticationTicket instead of Node's JSON
/// session blob; the two apps share the table shape, not the row format —
/// consistent with users needing to re-log-in once at cutover regardless
/// (see Phase 11 in the plan).
///
/// RetrieveAsync filters on ExpiresUtc itself (WHERE ExpiresUtc &gt; GETUTCDATE())
/// rather than trusting a separate timeout check, so an expired row is
/// silently treated as "not authenticated" — exactly mirroring
/// sqlSessionStore.js's get() behavior (see that file's own comments).
/// Physical cleanup of expired rows is separate housekeeping (a Quartz.NET
/// job in Phase 10, mirroring Node's hourly cron job), not required for
/// correctness here.
/// </summary>
internal sealed class PortalSessionStore(INexusDb db, IIdleTimeoutPolicy idleTimeoutPolicy) : ITicketStore
{
    public async Task<string> StoreAsync(AuthenticationTicket ticket)
    {
        var key = NewSessionKey();
        await SaveAsync(key, ticket);
        return key;
    }

    public async Task RenewAsync(string key, AuthenticationTicket ticket) =>
        await SaveAsync(key, ticket);

    public async Task<AuthenticationTicket?> RetrieveAsync(string key)
    {
        const string sql = """
            SELECT SessionData FROM dbo.PortalSessions
            WHERE SessionID = @key AND ExpiresUtc > GETUTCDATE()
            """;

        using var connection = await db.CreateConnectionAsync();
        var base64 = await connection.QuerySingleOrDefaultAsync<string?>(sql, new { key });
        if (base64 is null) return null;

        var bytes = Convert.FromBase64String(base64);
        return TicketSerializer.Default.Deserialize(bytes);
    }

    public async Task RemoveAsync(string key)
    {
        using var connection = await db.CreateConnectionAsync();
        await connection.ExecuteAsync("DELETE FROM dbo.PortalSessions WHERE SessionID = @key", new { key });
    }

    private async Task SaveAsync(string key, AuthenticationTicket ticket)
    {
        var bytes = TicketSerializer.Default.Serialize(ticket)
            ?? throw new InvalidOperationException("Failed to serialize authentication ticket.");
        var base64 = Convert.ToBase64String(bytes);

        // Same fallback as sqlSessionStore.js's expiryOf(): the caller (OnValidatePrincipal
        // in Program.cs) always sets Properties.ExpiresUtc explicitly per the per-user
        // idle timeout, so this fallback should only ever fire for a ticket built
        // without going through that path (defensive, not expected in practice).
        var expiresUtc = ticket.Properties.ExpiresUtc?.UtcDateTime
            ?? DateTime.UtcNow.Add(idleTimeoutPolicy.DefaultTimeout);

        const string upsertSql = """
            IF EXISTS (SELECT 1 FROM dbo.PortalSessions WHERE SessionID = @key)
                UPDATE dbo.PortalSessions
                SET SessionData = @data, ExpiresUtc = @expiresUtc, UpdatedUtc = GETUTCDATE()
                WHERE SessionID = @key
            ELSE
                INSERT INTO dbo.PortalSessions (SessionID, SessionData, ExpiresUtc, CreatedUtc, UpdatedUtc)
                VALUES (@key, @data, @expiresUtc, GETUTCDATE(), GETUTCDATE())
            """;

        using var connection = await db.CreateConnectionAsync();
        await connection.ExecuteAsync(upsertSql, new { key, data = base64, expiresUtc });
    }

    private static string NewSessionKey() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
}
