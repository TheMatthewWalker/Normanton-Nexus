namespace NormantonNexus.Models.Dto;

// C# port of routes/notifications.js's user-facing tray endpoints (the
// admin compose/list/targets/expire endpoints there are a separate,
// not-yet-ported admin feature — see Services/Notifications/NotificationService.cs
// for the write/fan-out side these read from).

public sealed record NotificationRow(
    int DeliveryId, int NotificationId, string Title, string Body, byte Severity, string? Category,
    string? ActionLabel, string? ActionUrl, DateTime CreatedAt, DateTime? ExpiresAt,
    bool IsRead, bool IsDismissed, DateTime? ReadAt, DateTime? DismissedAt);

/// <summary>Nested under this app's own {success,data,error} envelope as data.notifications/data.unreadCount — Node returns unreadCount as a sibling of data at the top level, which this app's uniform ApiResponse&lt;T&gt; envelope doesn't do for any other endpoint either.</summary>
public sealed record NotificationListResult(IReadOnlyList<NotificationRow> Notifications, int UnreadCount);
