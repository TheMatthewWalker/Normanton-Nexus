using Dapper;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Services.Notifications;

/// <summary>One notification target — mirrors lib/notify.js's `target: { type, value }` shape.</summary>
public enum NotificationTargetType { User, Department, Permission, Role, All }

public sealed record NotificationTarget(NotificationTargetType Type, string? Value = null)
{
    public static readonly NotificationTarget All = new(NotificationTargetType.All);
}

public sealed record NotificationRequest(
    string Title, string Body, byte Severity = 1, string? Category = null,
    string? ActionLabel = null, string? ActionUrl = null, DateTime? ExpiresAt = null,
    NotificationTarget? Target = null, int CreatedByUserId = 0);

/// <summary>
/// Programmatic notification helper — C# port of lib/notify.js. Call from
/// any Helper to create a notification and fan it out to the matching
/// users (dbo.Notifications + dbo.NotificationDeliveries, same schema
/// Node's own portal notification bell already reads).
/// </summary>
public interface INotificationService
{
    Task<int> NotifyAsync(NotificationRequest request, CancellationToken ct = default);
}

internal sealed class NotificationService(INexusDb db, ILogger<NotificationService> logger) : INotificationService
{
    public async Task<int> NotifyAsync(NotificationRequest request, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Title) || string.IsNullOrWhiteSpace(request.Body))
            throw new ArgumentException("notify: title and body are required");

        var target = request.Target ?? NotificationTarget.All;

        using var connection = await db.CreateConnectionAsync(ct);

        var notificationId = await connection.QuerySingleAsync<int>(new CommandDefinition("""
            INSERT INTO dbo.Notifications
                (Title,Body,Severity,Category,ActionLabel,ActionURL,TargetType,TargetValue,CreatedByUserID,ExpiresAt)
            OUTPUT INSERTED.NotificationID
            VALUES (@title,@body,@severity,@category,@actionLabel,@actionUrl,@targetType,@targetValue,@createdBy,@expiresAt)
            """, new
        {
            title = request.Title,
            body = request.Body,
            severity = request.Severity,
            category = request.Category,
            actionLabel = request.ActionLabel,
            actionUrl = request.ActionUrl,
            targetType = TargetTypeName(target.Type),
            targetValue = target.Value,
            createdBy = request.CreatedByUserId == 0 ? (int?)null : request.CreatedByUserId,
            expiresAt = request.ExpiresAt,
        }, cancellationToken: ct));

        try
        {
            await FanOutAsync(connection, notificationId, target, ct);
        }
        catch (Exception ex)
        {
            // The notification itself is already recorded (it'll show up
            // for anyone who visits the bell/target list later) — a
            // fan-out failure must never surface as a failure of whatever
            // business action triggered the notify() call.
            logger.LogWarning(ex, "Failed to fan out notification {NotificationId} to its targets", notificationId);
        }

        return notificationId;
    }

    private static string TargetTypeName(NotificationTargetType type) => type switch
    {
        NotificationTargetType.User => "user",
        NotificationTargetType.Department => "department",
        NotificationTargetType.Permission => "permission",
        NotificationTargetType.Role => "role",
        _ => "all",
    };

    // DEVIATION, deliberate improvement over Node: Node's own fan-out for
    // target type 'permission' only checks dbo.PortalUserPermissions (the
    // flat direct-grant table) — this app additionally has a permission-
    // GROUP mechanism (PortalUserPermissionGroups/PortalPermissionGroupPermissions,
    // see PermissionResolver's own effective-permission union) that Node has
    // no equivalent of. Porting Node's flat-table-only query here would
    // silently miss anyone who holds the target permission only via group
    // membership — a real gap against THIS app's own already-built
    // permission model, not a Node behavior change. Every other target type
    // is an exact port.
    private static async Task FanOutAsync(System.Data.Common.DbConnection connection, int notificationId, NotificationTarget target, CancellationToken ct)
    {
        var userIdsSql = target.Type switch
        {
            NotificationTargetType.User => "SELECT UserID FROM dbo.PortalUsers WHERE Username = @val AND IsActive = 1",
            NotificationTargetType.Department => """
                SELECT DISTINCT ud.UserID
                FROM   dbo.PortalUserDepartments ud
                JOIN   dbo.PortalUsers           pu ON pu.UserID = ud.UserID
                WHERE  ud.Department = @val AND pu.IsActive = 1
                """,
            NotificationTargetType.Permission => """
                SELECT DISTINCT pu.UserID
                FROM dbo.PortalUsers pu
                WHERE pu.IsActive = 1 AND pu.UserID IN (
                    SELECT UserID FROM dbo.PortalUserPermissions WHERE PermissionCode = @val
                    UNION
                    SELECT ug.UserID
                    FROM dbo.PortalUserPermissionGroups ug
                    JOIN dbo.PortalPermissionGroupPermissions gp ON gp.GroupID = ug.GroupID
                    WHERE gp.PermissionCode = @val
                )
                """,
            NotificationTargetType.Role => "SELECT UserID FROM dbo.PortalUsers WHERE Role = @val AND IsActive = 1",
            _ => "SELECT UserID FROM dbo.PortalUsers WHERE IsActive = 1",
        };

        await connection.ExecuteAsync(new CommandDefinition($"""
            INSERT INTO dbo.NotificationDeliveries (NotificationID, UserID)
            SELECT @notificationId, UserID FROM ({userIdsSql}) AS u
            WHERE NOT EXISTS (
                SELECT 1 FROM dbo.NotificationDeliveries
                WHERE NotificationID = @notificationId AND UserID = u.UserID
            )
            """, new { notificationId, val = target.Value }, cancellationToken: ct));
    }
}
