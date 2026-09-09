using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Admin;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Admin;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// User &amp; permission administration — Phase 9. Port of
/// routes/useradmin.js, mounted at api/admin (server.js's real mount —
/// the Node file's own header comment claiming api/useradmin is stale).
/// Class-level Role:admin, matching requireLogin + requireRole('admin');
/// permission-definition CRUD and bulk-create are further gated
/// Role:superadmin, matching the file's own per-route requireSuperadmin
/// calls exactly.
/// </summary>
[Route("api/admin")]
[Authorize(Policy = "Role:admin")]
public sealed class UserAdminController(INexusDb nexusDb, IAuditLogger audit, IPermissionGroupAdminService groupAdmin) : NexusControllerBase
{
    [HttpGet("pending")]
    public async Task<IActionResult> ListPending(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<PendingUserRow>>.Ok(await UserAdminHelper.ListPendingAsync(nexusDb, ct)));

    [HttpGet("users")]
    public async Task<IActionResult> ListUsers(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<AdminUserRow>>.Ok(await UserAdminHelper.ListUsersAsync(nexusDb, ct)));

    [HttpPut("users/{id:int}")]
    public async Task<IActionResult> UpdateUser(int id, [FromBody] UpdateUserRequest body, CancellationToken ct)
    {
        await UserAdminHelper.UpdateUserAsync(nexusDb, audit, id, body, GetRole(), GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("users/{id:int}/approve")]
    public async Task<IActionResult> ApproveUser(int id, [FromBody] ApproveUserRequest? body, CancellationToken ct)
    {
        await UserAdminHelper.ApproveUserAsync(nexusDb, audit, id, body ?? new ApproveUserRequest(null, null), GetRole(), GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("users/{id:int}/reject")]
    public async Task<IActionResult> RejectUser(int id, CancellationToken ct)
    {
        await UserAdminHelper.RejectUserAsync(nexusDb, audit, id, GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("users/bulk-create")]
    [Authorize(Policy = "Role:superadmin")]
    public async Task<IActionResult> BulkCreateUsers([FromBody] BulkCreateUsersRequest body, CancellationToken ct) =>
        Ok(ApiResponse<BulkCreateUsersResult>.Ok(await UserAdminHelper.BulkCreateUsersAsync(nexusDb, audit, body, GetUsername(), GetUserId(), GetIpAddress(), ct)));

    [HttpPost("users/bulk-departments")]
    public async Task<IActionResult> BulkGrantDepartments([FromBody] BulkDepartmentsRequest body, CancellationToken ct) =>
        Ok(ApiResponse<BulkGrantResult>.Ok(await UserAdminHelper.BulkGrantDepartmentsAsync(nexusDb, audit, body, GetUsername(), GetIpAddress(), ct)));

    [HttpPost("users/bulk-status")]
    public async Task<IActionResult> BulkSetStatus([FromBody] BulkStatusRequest body, CancellationToken ct) =>
        Ok(ApiResponse<BulkStatusResult>.Ok(await UserAdminHelper.BulkSetStatusAsync(nexusDb, audit, body, GetRole(), GetUsername(), GetIpAddress(), ct)));

    [HttpGet("audit")]
    public async Task<IActionResult> ListAuditLog([FromQuery] AuditLogQuery? query, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<AuditLogRow>>.Ok(await UserAdminHelper.ListAuditLogAsync(nexusDb, query ?? new AuditLogQuery(null, null, null, null, null), ct)));

    // ── Permission definitions (superadmin only) ─────────────────────

    [HttpGet("permissions")]
    public async Task<IActionResult> ListPermissionDefinitions(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<PermissionDefinitionRow>>.Ok(await UserAdminHelper.ListPermissionDefinitionsAsync(nexusDb, ct)));

    [HttpPost("permissions")]
    [Authorize(Policy = "Role:superadmin")]
    public async Task<IActionResult> CreatePermissionDefinition([FromBody] CreatePermissionRequest body, CancellationToken ct)
    {
        var code = await UserAdminHelper.CreatePermissionDefinitionAsync(nexusDb, audit, body, GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<object>.Ok(new { permissionCode = code }));
    }

    [HttpPut("permissions/{code}")]
    [Authorize(Policy = "Role:superadmin")]
    public async Task<IActionResult> UpdatePermissionDefinition(string code, [FromBody] UpdatePermissionRequest body, CancellationToken ct)
    {
        await UserAdminHelper.UpdatePermissionDefinitionAsync(nexusDb, audit, code, body, GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("permissions/{code}")]
    [Authorize(Policy = "Role:superadmin")]
    public async Task<IActionResult> DeletePermissionDefinition(string code, CancellationToken ct)
    {
        await UserAdminHelper.DeletePermissionDefinitionAsync(nexusDb, audit, code, GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    // ── User ↔ permission (admin or superadmin) ──────────────────────

    [HttpGet("users/{id:int}/permissions")]
    public async Task<IActionResult> ListUserPermissions(int id, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<UserPermissionRow>>.Ok(await UserAdminHelper.ListUserPermissionsAsync(nexusDb, id, ct)));

    [HttpPost("users/{id:int}/permissions")]
    public async Task<IActionResult> GrantPermission(int id, [FromBody] GrantPermissionRequest body, CancellationToken ct)
    {
        await UserAdminHelper.GrantPermissionAsync(nexusDb, audit, id, body, GetUserId(), GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("users/{id:int}/permissions/{code}")]
    public async Task<IActionResult> RevokePermission(int id, string code, CancellationToken ct)
    {
        await UserAdminHelper.RevokePermissionAsync(nexusDb, audit, id, code, GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("users/bulk-permissions")]
    public async Task<IActionResult> BulkGrantPermissions([FromBody] BulkPermissionsRequest body, CancellationToken ct) =>
        Ok(ApiResponse<BulkGrantResult>.Ok(await UserAdminHelper.BulkGrantPermissionsAsync(nexusDb, audit, body, GetUserId(), GetUsername(), GetIpAddress(), ct)));

    // ── Permission groups ─────────────────────────────────────────────
    // Full CRUD + bulk-set-permissions + bulk-assign-to-users — see
    // PermissionGroupAdminService's own header comment for why this
    // replaced the earlier one-row-at-a-time Razor Page handlers.

    [HttpGet("permission-groups")]
    public async Task<IActionResult> ListPermissionGroups(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<PermissionGroupSummary>>.Ok(await groupAdmin.ListGroupsAsync(ct)));

    [HttpGet("permission-groups/{groupId:int}")]
    public async Task<IActionResult> GetPermissionGroup(int groupId, CancellationToken ct)
    {
        var group = await groupAdmin.GetGroupAsync(groupId, ct);
        return group is null
            ? StatusCode(404, new ApiResponse<PermissionGroupDetail?>(false, null, new ApiError("NOT_FOUND", "Permission group not found.")))
            : Ok(ApiResponse<PermissionGroupDetail?>.Ok(group));
    }

    [HttpPost("permission-groups")]
    public async Task<IActionResult> CreatePermissionGroup([FromBody] CreatePermissionGroupRequest body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.GroupName))
            return StatusCode(400, new ApiResponse<object?>(false, null, new ApiError("VALIDATION_ERROR", "Group name is required.")));

        var groupId = await groupAdmin.CreateGroupAsync(body.GroupName.Trim(), body.Description, GetUsername(), ct);
        await audit.LogAsync("PERMISSION_GROUP_CREATE", GetUsername(), $"Created group '{body.GroupName.Trim()}' (GroupID {groupId})", GetIpAddress(), ct);
        return StatusCode(201, ApiResponse<object>.Ok(new { groupId }));
    }

    [HttpPut("permission-groups/{groupId:int}")]
    public async Task<IActionResult> UpdatePermissionGroup(int groupId, [FromBody] UpdatePermissionGroupRequest body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.GroupName))
            return StatusCode(400, new ApiResponse<object?>(false, null, new ApiError("VALIDATION_ERROR", "Group name is required.")));

        await groupAdmin.UpdateGroupAsync(groupId, body.GroupName.Trim(), body.Description, ct);
        await audit.LogAsync("PERMISSION_GROUP_UPDATE", GetUsername(), $"Updated group {groupId} — name '{body.GroupName.Trim()}'", GetIpAddress(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("permission-groups/{groupId:int}")]
    public async Task<IActionResult> DeletePermissionGroup(int groupId, CancellationToken ct)
    {
        await groupAdmin.DeleteGroupAsync(groupId, ct);
        await audit.LogAsync("PERMISSION_GROUP_DELETE", GetUsername(), $"Deleted group {groupId}", GetIpAddress(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPut("permission-groups/{groupId:int}/permissions")]
    public async Task<IActionResult> SetGroupPermissions(int groupId, [FromBody] SetGroupPermissionsRequest body, CancellationToken ct)
    {
        await groupAdmin.SetGroupPermissionsAsync(groupId, body.PermissionCodes ?? [], ct);
        await audit.LogAsync("PERMISSION_GROUP_SET_PERMISSIONS", GetUsername(), $"Set {body.PermissionCodes?.Count ?? 0} permission(s) on group {groupId}", GetIpAddress(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("permission-groups/{groupId:int}/users")]
    public async Task<IActionResult> AssignGroupToUsers(int groupId, [FromBody] AssignGroupToUsersRequest body, CancellationToken ct)
    {
        if (body.UserIds is not { Count: > 0 })
            return StatusCode(400, new ApiResponse<object?>(false, null, new ApiError("VALIDATION_ERROR", "Select at least one user.")));

        var assigned = await groupAdmin.AssignGroupToUsersAsync(groupId, body.UserIds, GetUserId(), ct);
        await audit.LogAsync("PERMISSION_GROUP_ASSIGN_USERS", GetUsername(), $"Assigned group {groupId} to {assigned} user(s)", GetIpAddress(), ct);
        return Ok(ApiResponse<object>.Ok(new { assigned }));
    }

    [HttpDelete("permission-groups/{groupId:int}/users/{userId:int}")]
    public async Task<IActionResult> RemoveGroupFromUser(int groupId, int userId, CancellationToken ct)
    {
        await groupAdmin.RemoveGroupFromUserAsync(userId, groupId, ct);
        await audit.LogAsync("PERMISSION_GROUP_REMOVE_USER", GetUsername(), $"Removed user {userId} from group {groupId}", GetIpAddress(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("permission-groups-options/users")]
    public async Task<IActionResult> ListPermissionGroupUserOptions(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<UserOption>>.Ok(await groupAdmin.ListAllUsersAsync(ct)));

    [HttpGet("permission-groups-options/permissions")]
    public async Task<IActionResult> ListPermissionGroupPermissionOptions(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<PermissionOption>>.Ok(await groupAdmin.ListAllPermissionsAsync(ct)));
}
