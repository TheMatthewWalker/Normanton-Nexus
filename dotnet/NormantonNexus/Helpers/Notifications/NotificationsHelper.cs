using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Notifications;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Notifications;

/// <summary>
/// Port of routes/notifications.js in full: the user-facing tray (GET /,
/// GET /history, PATCH /read-all, PATCH /:deliveryId/dismiss — any logged-in
/// user, scoped to their own dbo.NotificationDeliveries rows) plus the
/// admin compose/list/targets/expire surface (POST/GET/DELETE admin*,
/// GET admin/targets — Role:admin, found missing by a later gap audit
/// against the Node tile inventory, not a deliberate deferral). Writing/
/// fanning-out a notification itself is Services/Notifications/
/// NotificationService.cs, already built and in use since Phase 7d for
/// programmatic notify() calls — the admin compose form is just its first
/// direct, user-driven caller.
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

    // ── Admin compose/list/targets/expire — Role:admin, matching Node's
    // requireRole('admin') on all four routes exactly. ────────────────────

    /// <summary>Create a notification and fan it out via the already-built NotificationService, then count how many deliveries it actually created — matches Node's own two-step create-then-count exactly.</summary>
    internal static async Task<CreateNotificationResult> CreateAdminAsync(
        INexusDb db, INotificationService notificationService, CreateNotificationRequest request, int createdByUserId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Title) || string.IsNullOrWhiteSpace(request.Body))
            throw new NexusValidationException("title and body are required.");

        var severity = request.Severity ?? 1;
        if (severity is not (1 or 2 or 3))
            throw new NexusValidationException("severity must be 1, 2 or 3.");

        var target = ParseTarget(request.Target);
        var notificationId = await notificationService.NotifyAsync(new NotificationRequest(
            request.Title!, request.Body!, severity, request.Category,
            request.ActionLabel, request.ActionUrl, request.ExpiresAt, target, createdByUserId), ct);

        using var connection = await db.CreateConnectionAsync(ct);
        var recipients = await connection.QuerySingleAsync<int>(new CommandDefinition(
            "SELECT COUNT(*) FROM dbo.NotificationDeliveries WHERE NotificationID = @notificationId",
            new { notificationId }, cancellationToken: ct));

        return new CreateNotificationResult(notificationId, recipients);
    }

    private static NotificationTarget ParseTarget(NotificationTargetInput? input)
    {
        if (input is null || string.IsNullOrWhiteSpace(input.Type)) return NotificationTarget.All;
        var type = input.Type.Trim().ToLowerInvariant() switch
        {
            "user" => NotificationTargetType.User,
            "department" => NotificationTargetType.Department,
            "permission" => NotificationTargetType.Permission,
            "role" => NotificationTargetType.Role,
            _ => NotificationTargetType.All,
        };
        return new NotificationTarget(type, input.Value);
    }

    /// <summary>Every notification ever sent, with delivery/read/dismissed counts — matches Node's own GROUP BY exactly.</summary>
    internal static async Task<IReadOnlyList<AdminNotificationRow>> ListAdminAsync(INexusDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<AdminNotificationRow>(new CommandDefinition("""
            SELECT
                n.NotificationID, n.Title, n.Severity, n.Category,
                n.TargetType, n.TargetValue,
                n.CreatedAt, n.ExpiresAt,
                pu.Username AS CreatedBy,
                COUNT(d.DeliveryID)              AS TotalSent,
                SUM(CAST(d.IsRead AS INT))       AS TotalRead,
                SUM(CAST(d.IsDismissed AS INT))  AS TotalDismissed
            FROM   dbo.Notifications n
            LEFT JOIN dbo.NotificationDeliveries d  ON d.NotificationID = n.NotificationID
            LEFT JOIN dbo.PortalUsers            pu ON pu.UserID = n.CreatedByUserID
            GROUP BY
                n.NotificationID, n.Title, n.Severity, n.Category,
                n.TargetType, n.TargetValue,
                n.CreatedAt, n.ExpiresAt, pu.Username
            ORDER BY n.CreatedAt DESC
            """, cancellationToken: ct));
        return rows.AsList();
    }

    /// <summary>Expires a notification immediately (ExpiresAt = now) rather than deleting the row — matches Node's own DELETE route, which is really just an expiry despite the HTTP verb.</summary>
    internal static async Task ExpireAsync(INexusDb db, int notificationId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE dbo.Notifications SET ExpiresAt = GETDATE() WHERE NotificationID = @notificationId",
            new { notificationId }, cancellationToken: ct));
    }

    /// <summary>Departments/permissions for the compose form's target dropdowns.</summary>
    internal static async Task<NotificationTargetOptionsResult> GetTargetOptionsAsync(INexusDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var departments = await connection.QueryAsync<string>(new CommandDefinition(
            "SELECT DISTINCT Department FROM dbo.PortalUserDepartments ORDER BY Department", cancellationToken: ct));
        var permissions = await connection.QueryAsync<NotificationPermissionOption>(new CommandDefinition(
            "SELECT PermissionCode, PermissionName, Category FROM dbo.PortalPermissions ORDER BY Category, PermissionName", cancellationToken: ct));
        return new NotificationTargetOptionsResult(departments.AsList(), permissions.AsList());
    }
}
