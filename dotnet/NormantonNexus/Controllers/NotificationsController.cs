using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Notifications;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// User-facing notification tray — port of routes/notifications.js's non-admin
/// routes. Any logged-in user (matches Node's requireLogin-only mount) — every
/// query is already scoped to the caller's own UserID inside NotificationsHelper.
/// </summary>
[Route("api/notifications")]
[Authorize]
public sealed class NotificationsController(INexusDb db) : NexusControllerBase
{
    [HttpGet("")]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var result = await NotificationsHelper.ListAsync(db, GetUserId(), ct);
        return Ok(ApiResponse<NotificationListResult>.Ok(result));
    }

    [HttpGet("history")]
    public async Task<IActionResult> History(CancellationToken ct)
    {
        var rows = await NotificationsHelper.ListHistoryAsync(db, GetUserId(), ct);
        return Ok(ApiResponse<IReadOnlyList<NotificationRow>>.Ok(rows));
    }

    [HttpPatch("read-all")]
    public async Task<IActionResult> ReadAll(CancellationToken ct)
    {
        await NotificationsHelper.MarkAllReadAsync(db, GetUserId(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPatch("{deliveryId:int}/dismiss")]
    public async Task<IActionResult> Dismiss(int deliveryId, CancellationToken ct)
    {
        await NotificationsHelper.DismissAsync(db, GetUserId(), deliveryId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }
}
