using Dapper;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Services;

/// <summary>
/// Best-effort attribution correction for dbo.DataChangeLog — C# port of
/// config.js's stampDbChange. A database trigger auto-populates
/// DataChangeLog rows on writes to certain tables but has no notion of
/// which application user made the change, so this patches the most
/// recent matching row (within the last 5 seconds) with the real
/// username. Fire-and-forget by design — callers don't await this the way
/// Node's own call sites don't either, and any failure here must never
/// affect the request it's describing.
/// </summary>
public interface IDataChangeLogService
{
    Task StampAsync(string? username, string tableName, CancellationToken ct = default);
}

internal sealed class DataChangeLogService(INexusDb db, ILogger<DataChangeLogService> logger) : IDataChangeLogService
{
    public async Task StampAsync(string? username, string tableName, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(username)) return;

        try
        {
            using var connection = await db.CreateConnectionAsync(ct);
            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE TOP (1) dbo.DataChangeLog
                SET DBUser = @username
                WHERE TableName = @tableName
                  AND DBUser != @username
                  AND ChangedAt >= DATEADD(second, -5, GETDATE())
                  AND LogID = (
                      SELECT MAX(LogID) FROM dbo.DataChangeLog
                      WHERE TableName = @tableName AND ChangedAt >= DATEADD(second, -5, GETDATE())
                  )
                """, new { username, tableName }, cancellationToken: ct));
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to stamp DataChangeLog attribution for {TableName}", tableName);
        }
    }
}
