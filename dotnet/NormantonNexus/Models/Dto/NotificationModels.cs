namespace NormantonNexus.Models.Dto;

// C# port of routes/notifications.js's user-facing tray endpoints — see
// Services/Notifications/NotificationService.cs for the write/fan-out side
// these read from. The admin compose/list/targets/expire DTOs are further
// down this file.

public sealed record NotificationRow(
    int DeliveryId, int NotificationId, string Title, string Body, byte Severity, string? Category,
    string? ActionLabel, string? ActionUrl, DateTime CreatedAt, DateTime? ExpiresAt,
    bool IsRead, bool IsDismissed, DateTime? ReadAt, DateTime? DismissedAt);

/// <summary>Nested under this app's own {success,data,error} envelope as data.notifications/data.unreadCount — Node returns unreadCount as a sibling of data at the top level, which this app's uniform ApiResponse&lt;T&gt; envelope doesn't do for any other endpoint either.</summary>
public sealed record NotificationListResult(IReadOnlyList<NotificationRow> Notifications, int UnreadCount);

// ── Admin compose/list/targets/expire (POST/GET/DELETE api/notifications/admin*) ──
// The admin-side send/manage surface backing admin.html's "Send Notification"
// section — found missing by a later gap audit against the Node tile
// inventory, not a deliberate deferral. Writing/fanning-out a notification
// itself is Services/Notifications/NotificationService.cs (already built
// and in use since Phase 7d for programmatic notify() calls) — these DTOs
// are just the admin compose-form's own request/list/target-picker shapes.

/// <summary>The admin compose form's raw {type, value} target picker — mapped onto Services/Notifications/NotificationTarget's typed enum inside NotificationsHelper, same shape lib/notify.js's own target param takes.</summary>
public sealed record NotificationTargetInput(string? Type, string? Value);

public sealed record CreateNotificationRequest(
    string? Title, string? Body, byte? Severity, string? Category,
    string? ActionLabel, string? ActionUrl, DateTime? ExpiresAt, NotificationTargetInput? Target);

public sealed record CreateNotificationResult(int NotificationId, int Recipients);

/// <summary>
/// One sent notification with delivery stats — matches Node's own GET /admin
/// list query exactly. TotalRead/TotalDismissed are nullable, not a plain
/// int: SQL Server's SUM() over zero rows (a notification whose fan-out
/// matched no active users — e.g. a mistyped username target) returns NULL,
/// not 0, even though COUNT(d.DeliveryID)/TotalSent itself is a real 0 in
/// that same case — mapping that NULL into a non-nullable int would throw.
/// </summary>
public sealed record AdminNotificationRow(
    int NotificationId, string Title, byte Severity, string? Category,
    string TargetType, string? TargetValue, DateTime CreatedAt, DateTime? ExpiresAt,
    string? CreatedBy, int TotalSent, int? TotalRead, int? TotalDismissed);

/// <summary>One row of dbo.PortalPermissions — deliberately narrower than UserAdminModels.cs's own PermissionDefinitionRow (no Description/CreatedAt), matching the admin compose form's own targets query exactly rather than reusing a wider DTO shaped for a different screen.</summary>
public sealed record NotificationPermissionOption(string PermissionCode, string PermissionName, string Category);

public sealed record NotificationTargetOptionsResult(IReadOnlyList<string> Departments, IReadOnlyList<NotificationPermissionOption> Permissions);
