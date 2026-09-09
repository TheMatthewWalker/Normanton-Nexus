namespace NormantonNexus.Models.Dto;

// ── Phase 9: Admin — User & Permission Administration ──────────────────────
// Port of routes/useradmin.js. Mounted (per server.js, not this file's own
// stale header comment claiming /api/useradmin) at api/admin, gated
// Role:admin at class level with several actions further gated
// Role:superadmin, matching requireLogin + requireRole('admin') + the
// file's own per-route requireSuperadmin calls exactly.

public sealed record PendingUserRow(int UserId, string Username, string? FirstName, string? LastName, string Email, DateTime CreatedAt);

public sealed record AdminUserRow(
    int UserId, string Username, string? FirstName, string? LastName, string Email, string Role,
    bool IsActive, bool IsLocked, int FailedLogins, bool ShortIdleTimeout, DateTime CreatedAt, DateTime? LastLogin, string? Notes,
    IReadOnlyList<string> Departments, IReadOnlyList<string> Permissions);

/// <summary>A null field means "leave unchanged" for role/isActive/isLocked/notes/departments/shortIdleTimeout (matching Node's `?? prev.X` fallback); username/firstName/lastName/email use "field present in the request at all" to decide whether to touch them (Node's own `!== undefined` checks) — see UpdateUserRequestPresence.</summary>
public sealed record UpdateUserRequest(
    string? Role, bool? IsActive, bool? IsLocked, string? Notes, List<string>? Departments,
    string? Username, string? FirstName, string? LastName, string? Email, bool? ShortIdleTimeout);

public sealed record ApproveUserRequest(string? Role, List<string>? Departments);

public sealed record BulkCreateUserRow(
    string? Role, string? Username, string? Email, string? FirstName, string? LastName, string? Password,
    bool? Approved, bool? Unlocked, string? PermissionCode);

public sealed record BulkCreateUsersRequest(string? Department, List<BulkCreateUserRow>? Rows);

public sealed record BulkCreateRowResult(int Row, string? Username, bool Success, string? Error, int? UserId);

public sealed record BulkCreateSummary(int Total, int Succeeded, int Failed);

public sealed record BulkCreateUsersResult(IReadOnlyList<BulkCreateRowResult> Results, BulkCreateSummary Summary);

public sealed record BulkDepartmentsRequest(List<int>? UserIds, List<string>? Departments);

public sealed record BulkStatusRequest(List<int>? UserIds, bool? IsActive, bool? IsLocked, bool? ShortIdleTimeout);

/// <summary>Shared per-user outcome shape for bulk department/permission grants — Granted/AlreadyHad count how many of the requested codes landed vs. were already held; Error is set instead when the user itself wasn't found.</summary>
public sealed record BulkGrantRowResult(int UserId, string? Username, int Granted, int AlreadyHad, string? Error);

public sealed record BulkGrantSummary(int Users, int Granted, int AlreadyHad, int Failed);

public sealed record BulkGrantResult(IReadOnlyList<BulkGrantRowResult> Results, BulkGrantSummary Summary);

public sealed record BulkStatusRowResult(int UserId, string? Username, bool Success, string? Error);

public sealed record BulkStatusResult(IReadOnlyList<BulkStatusRowResult> Results, BulkCreateSummary Summary);

public sealed record AuditLogQuery(string? Event, string? Username, string? Detail, DateTime? From, DateTime? To);

public sealed record AuditLogRow(long LogId, DateTime EventTime, string? Username, string EventType, string? Detail, string? IpAddress);

public sealed record PermissionDefinitionRow(string PermissionCode, string PermissionName, string? Description, string Category, DateTime CreatedAt);

public sealed record CreatePermissionRequest(string? PermissionCode, string? PermissionName, string? Description, string? Category);

public sealed record UpdatePermissionRequest(string? PermissionName, string? Description, string? Category);

public sealed record UserPermissionRow(string PermissionCode, string PermissionName, string Category, DateTime GrantedAt);

public sealed record GrantPermissionRequest(string? PermissionCode);

public sealed record BulkPermissionsRequest(List<int>? UserIds, List<string>? PermissionCodes);
