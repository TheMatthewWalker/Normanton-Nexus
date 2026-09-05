using Dapper;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Services.Admin;

/// <summary>
/// Minimal permission-group management — enough for an admin to create a
/// group, assign tile permissions to it, and assign the group to users
/// while department phases 2-8 are being built and need somewhere to grant
/// their new per-tile codes. This is NOT the full Phase 9 admin UI (group
/// list/create/edit/delete with a proper permission-checkbox grid,
/// bulk-assign-to-users, folded into the existing bulk-apply/audit-log
/// screens) — see the migration plan's "Authorization model" section for
/// what Phase 9 adds on top of this.
/// </summary>
public interface IPermissionGroupAdminService
{
    Task<IReadOnlyList<PermissionGroupSummary>> ListGroupsAsync(CancellationToken ct = default);
    Task<PermissionGroupDetail?> GetGroupAsync(int groupId, CancellationToken ct = default);
    Task<int> CreateGroupAsync(string groupName, string? description, string? createdBy, CancellationToken ct = default);
    Task AddPermissionToGroupAsync(int groupId, string permissionCode, CancellationToken ct = default);
    Task RemovePermissionFromGroupAsync(int groupId, string permissionCode, CancellationToken ct = default);
    Task AssignGroupToUserAsync(int userId, int groupId, int? grantedByUserId, CancellationToken ct = default);
    Task RemoveGroupFromUserAsync(int userId, int groupId, CancellationToken ct = default);
    Task<IReadOnlyList<PermissionOption>> ListAllPermissionsAsync(CancellationToken ct = default);
    Task<IReadOnlyList<UserOption>> ListAllUsersAsync(CancellationToken ct = default);
}

internal sealed class PermissionGroupAdminService(INexusDb db) : IPermissionGroupAdminService
{
    public async Task<IReadOnlyList<PermissionGroupSummary>> ListGroupsAsync(CancellationToken ct = default)
    {
        const string sql = """
            SELECT g.GroupID AS GroupId, g.GroupName, g.Description,
                   (SELECT COUNT(*) FROM dbo.PortalPermissionGroupPermissions gp WHERE gp.GroupID = g.GroupID) AS PermissionCount,
                   (SELECT COUNT(*) FROM dbo.PortalUserPermissionGroups ug WHERE ug.GroupID = g.GroupID) AS MemberCount
            FROM dbo.PortalPermissionGroups g
            ORDER BY g.GroupName
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<PermissionGroupSummary>(new CommandDefinition(sql, cancellationToken: ct));
        return rows.ToArray();
    }

    private sealed record GroupHeaderRow(int GroupID, string GroupName, string? Description);

    public async Task<PermissionGroupDetail?> GetGroupAsync(int groupId, CancellationToken ct = default)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var header = await connection.QuerySingleOrDefaultAsync<GroupHeaderRow>(
            new CommandDefinition(
                "SELECT GroupID, GroupName, Description FROM dbo.PortalPermissionGroups WHERE GroupID = @groupId",
                new { groupId }, cancellationToken: ct));
        if (header is null) return null;

        var permissions = await connection.QueryAsync<string>(new CommandDefinition(
            "SELECT PermissionCode FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId ORDER BY PermissionCode",
            new { groupId }, cancellationToken: ct));

        var members = await connection.QueryAsync<GroupMember>(new CommandDefinition("""
            SELECT u.UserID AS UserId, u.Username
            FROM dbo.PortalUserPermissionGroups ug
            JOIN dbo.PortalUsers u ON u.UserID = ug.UserID
            WHERE ug.GroupID = @groupId
            ORDER BY u.Username
            """, new { groupId }, cancellationToken: ct));

        return new PermissionGroupDetail(header.GroupID, header.GroupName, header.Description, permissions.ToArray(), members.ToArray());
    }

    public async Task<int> CreateGroupAsync(string groupName, string? description, string? createdBy, CancellationToken ct = default)
    {
        const string sql = """
            INSERT INTO dbo.PortalPermissionGroups (GroupName, Description, CreatedBy, CreatedAt)
            OUTPUT INSERTED.GroupID
            VALUES (@groupName, @description, @createdBy, GETDATE())
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleAsync<int>(new CommandDefinition(
            sql, new { groupName, description, createdBy }, cancellationToken: ct));
    }

    public async Task AddPermissionToGroupAsync(int groupId, string permissionCode, CancellationToken ct = default)
    {
        const string sql = """
            IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode = @permissionCode)
                INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@groupId, @permissionCode)
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(sql, new { groupId, permissionCode }, cancellationToken: ct));
    }

    public async Task RemovePermissionFromGroupAsync(int groupId, string permissionCode, CancellationToken ct = default)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "DELETE FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode = @permissionCode",
            new { groupId, permissionCode }, cancellationToken: ct));
    }

    public async Task AssignGroupToUserAsync(int userId, int groupId, int? grantedByUserId, CancellationToken ct = default)
    {
        const string sql = """
            IF NOT EXISTS (SELECT 1 FROM dbo.PortalUserPermissionGroups WHERE UserID = @userId AND GroupID = @groupId)
                INSERT INTO dbo.PortalUserPermissionGroups (UserID, GroupID, GrantedByUserID, GrantedAt)
                VALUES (@userId, @groupId, @grantedByUserId, GETDATE())
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(sql, new { userId, groupId, grantedByUserId }, cancellationToken: ct));
    }

    public async Task RemoveGroupFromUserAsync(int userId, int groupId, CancellationToken ct = default)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "DELETE FROM dbo.PortalUserPermissionGroups WHERE UserID = @userId AND GroupID = @groupId",
            new { userId, groupId }, cancellationToken: ct));
    }

    public async Task<IReadOnlyList<PermissionOption>> ListAllPermissionsAsync(CancellationToken ct = default)
    {
        const string sql = """
            SELECT PermissionCode, PermissionName, Category
            FROM dbo.PortalPermissions
            ORDER BY Category, PermissionCode
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<PermissionOption>(new CommandDefinition(sql, cancellationToken: ct));
        return rows.ToArray();
    }

    public async Task<IReadOnlyList<UserOption>> ListAllUsersAsync(CancellationToken ct = default)
    {
        const string sql = "SELECT UserID AS UserId, Username FROM dbo.PortalUsers ORDER BY Username";

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<UserOption>(new CommandDefinition(sql, cancellationToken: ct));
        return rows.ToArray();
    }
}
