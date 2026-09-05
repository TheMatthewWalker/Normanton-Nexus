using Dapper;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Services.Auth;

/// <summary>Writes to dbo.PortalAuditLog — C# analog of config.js's auditQuery() helper.</summary>
public interface IAuditLogger
{
    Task LogAsync(string eventType, string? username, string? detail, string? ipAddress, CancellationToken ct = default);
}

internal sealed class AuditLogger(INexusDb db, ILogger<AuditLogger> logger) : IAuditLogger
{
    public async Task LogAsync(string eventType, string? username, string? detail, string? ipAddress, CancellationToken ct = default)
    {
        try
        {
            const string sql = """
                INSERT INTO dbo.PortalAuditLog (EventTime, Username, EventType, Detail, IPAddress)
                VALUES (GETDATE(), @username, @eventType, @detail, @ipAddress)
                """;

            using var connection = await db.CreateConnectionAsync(ct);
            await connection.ExecuteAsync(new CommandDefinition(
                sql, new { username, eventType, detail, ipAddress }, cancellationToken: ct));
        }
        catch (Exception ex)
        {
            // Audit logging is fire-and-forget best-effort, same as auditQuery() in
            // config.js — a SQL hiccup here must never block or fail the login/logout
            // it's describing.
            logger.LogWarning(ex, "Failed to write audit log entry for {EventType}", eventType);
        }
    }
}
