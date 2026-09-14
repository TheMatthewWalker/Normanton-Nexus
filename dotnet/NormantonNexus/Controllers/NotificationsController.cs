using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Notifications;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Notifications;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Port of routes/notifications.js in full — the user-facing tray (any
/// logged-in user, matching Node's requireLogin-only mount; every query is
/// already scoped to the caller's own UserID inside NotificationsHelper)
/// plus the admin compose/list/targets/expire surface (Role:admin per
/// action, matching Node's own requireRole('admin') on those four routes
/// exactly — a genuinely missing piece found by a later gap audit against
/// the Node tile inventory, backing admin.html's "Send Notification"
/// section, not a deliberate deferral).
/// </summary>
[Route("api/notifications")]
[Authorize]
public sealed class NotificationsController(INexusDb db, INotificationService notificationService) : NexusControllerBase
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

    // ── Admin compose/list/targets/expire ───────────────────────────────

    [HttpPost("admin")]
    [Authorize(Policy = "Role:" + NexusRoles.Admin)]
    public async Task<IActionResult> CreateAdmin([FromBody] CreateNotificationRequest? body, CancellationToken ct)
    {
        var result = await NotificationsHelper.CreateAdminAsync(
            db, notificationService, body ?? new CreateNotificationRequest(null, null, null, null, null, null, null, null), GetUserId(), ct);
        return StatusCode(201, ApiResponse<CreateNotificationResult>.Ok(result));
    }

    [HttpGet("admin")]
    [Authorize(Policy = "Role:" + NexusRoles.Admin)]
    public async Task<IActionResult> ListAdmin(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<AdminNotificationRow>>.Ok(await NotificationsHelper.ListAdminAsync(db, ct)));

    [HttpDelete("admin/{id:int}")]
    [Authorize(Policy = "Role:" + NexusRoles.Admin)]
    public async Task<IActionResult> ExpireAdmin(int id, CancellationToken ct)
    {
        await NotificationsHelper.ExpireAsync(db, id, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("admin/targets")]
    [Authorize(Policy = "Role:" + NexusRoles.Admin)]
    public async Task<IActionResult> GetAdminTargets(CancellationToken ct) =>
        Ok(ApiResponse<NotificationTargetOptionsResult>.Ok(await NotificationsHelper.GetTargetOptionsAsync(db, ct)));
}
