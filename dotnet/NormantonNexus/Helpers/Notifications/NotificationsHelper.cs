using Dapper;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Notifications;

/// <summary>
/// User-facing notification tray — port of routes/notifications.js's
/// GET /, GET /history, PATCH /read-all, PATCH /:deliveryId/dismiss.
/// The admin compose/list/targets/expire endpoints in that same Node file
/// are a separate, not-yet-ported feature — this only covers the tray a
/// logged-in user sees for themselves (their own dbo.NotificationDeliveries
/// rows). Writing/fanning-out a notification is Services/Notifications/
/// NotificationService.cs, already built and in use since Phase 7d.
/// </summary>
internal static class NotificationsHelper
{
    private const string SelectColumns = """
        d.DeliveryID, d.NotificationID, n.Title, n.Body, n.Severity, n.Category,
        n.ActionLabel, n.ActionURL, n.CreatedAt, n.ExpiresAt,
        d.IsRead, d.IsDismissed, d.ReadAt, d.DismissedAt
        """;

    /// <summary>The tray: unread first, then read-but-not-dismissed, excluding expired/dismissed — matches Node's exact ORDER BY and WHERE clause.</summary>
    internal static async Task<NotificationListResult> ListAsync(INexusDb db, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = (await connection.QueryAsync<NotificationRow>(new CommandDefinition($"""
            SELECT {SelectColumns}
            FROM   dbo.NotificationDeliveries d
            JOIN   dbo.Notifications          n ON n.NotificationID = d.NotificationID
            WHERE  d.UserID      = @userId
              AND  d.IsDismissed = 0
              AND  (n.ExpiresAt IS NULL OR n.ExpiresAt > GETDATE())
            ORDER  BY d.IsRead ASC, n.CreatedAt DESC
            """, new { userId }, cancellationToken: ct))).ToList();

        return new NotificationListResult(rows, rows.Count(r => !r.IsRead));
    }

    /// <summary>Full history including dismissed — backs the "View all" history page.</summary>
    internal static async Task<IReadOnlyList<NotificationRow>> ListHistoryAsync(INexusDb db, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<NotificationRow>(new CommandDefinition($"""
            SELECT {SelectColumns}
            FROM   dbo.NotificationDeliveries d
            JOIN   dbo.Notifications          n ON n.NotificationID = d.NotificationID
            WHERE  d.UserID = @userId
            ORDER  BY n.CreatedAt DESC
            """, new { userId }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task MarkAllReadAsync(INexusDb db, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE dbo.NotificationDeliveries
            SET IsRead = 1, ReadAt = GETDATE()
            WHERE UserID = @userId AND IsRead = 0 AND IsDismissed = 0
            """, new { userId }, cancellationToken: ct));
    }

    /// <summary>Scoped to the caller's own UserID in the WHERE clause — matches Node exactly, so a deliveryId belonging to a different user silently affects zero rows rather than needing a separate ownership check.</summary>
    internal static async Task DismissAsync(INexusDb db, int userId, int deliveryId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE dbo.NotificationDeliveries
            SET IsDismissed = 1, DismissedAt = GETDATE(), IsRead = 1, ReadAt = COALESCE(ReadAt, GETDATE())
            WHERE DeliveryID = @deliveryId AND UserID = @userId
            """, new { deliveryId, userId }, cancellationToken: ct));
    }
}
