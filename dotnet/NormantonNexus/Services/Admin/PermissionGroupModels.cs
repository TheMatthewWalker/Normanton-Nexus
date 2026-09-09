namespace NormantonNexus.Services.Admin;

public sealed record PermissionGroupSummary(int GroupId, string GroupName, string? Description, int PermissionCount, int MemberCount);

public sealed record PermissionGroupDetail(
    int GroupId, string GroupName, string? Description,
    IReadOnlyList<string> PermissionCodes, IReadOnlyList<GroupMember> Members);

public sealed record GroupMember(int UserId, string Username);

public sealed record PermissionOption(string PermissionCode, string PermissionName, string Category);

public sealed record UserOption(int UserId, string Username);

public sealed record CreatePermissionGroupRequest(string GroupName, string? Description);

public sealed record UpdatePermissionGroupRequest(string GroupName, string? Description);

public sealed record SetGroupPermissionsRequest(List<string> PermissionCodes);

public sealed record AssignGroupToUsersRequest(List<int> UserIds);
