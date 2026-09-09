using Dapper;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Services.Admin;

/// <summary>
/// Permission-group management — full CRUD (create/edit/delete groups),
/// a checkbox-grid-style bulk permission set (SetGroupPermissionsAsync),
/// and bulk-assign-to-users. Originally built minimal in Phase 1 (create +
/// one-row-at-a-time add/remove) purely so department phases 2-8 had
/// somewhere to grant their new per-tile codes while being built; extended
/// to the full shape here as part of the shared-component-library sweep
/// once every department's own per-tile permission split had landed.
/// </summary>
public interface IPermissionGroupAdminService
{
    Task<IReadOnlyList<PermissionGroupSummary>> ListGroupsAsync(CancellationToken ct = default);
    Task<PermissionGroupDetail?> GetGroupAsync(int groupId, CancellationToken ct = default);
    Task<int> CreateGroupAsync(string groupName, string? description, string? createdBy, CancellationToken ct = default);
    Task UpdateGroupAsync(int groupId, string groupName, string? description, CancellationToken ct = default);
    Task DeleteGroupAsync(int groupId, CancellationToken ct = default);
    Task AddPermissionToGroupAsync(int groupId, string permissionCode, CancellationToken ct = default);
    Task RemovePermissionFromGroupAsync(int groupId, string permissionCode, CancellationToken ct = default);
    /// <summary>Replaces the group's full permission set in one call — the checkbox-grid save. Diffs against the current set so only the changed rows are added/removed.</summary>
    Task SetGroupPermissionsAsync(int groupId, IReadOnlyList<string> permissionCodes, CancellationToken ct = default);
    Task AssignGroupToUserAsync(int userId, int groupId, int? grantedByUserId, CancellationToken ct = default);
    /// <summary>Bulk-assign the group to several users at once — each already-a-member user is silently skipped, matching AssignGroupToUserAsync's own idempotent IF NOT EXISTS guard.</summary>
    Task<int> AssignGroupToUsersAsync(int groupId, IReadOnlyList<int> userIds, int? grantedByUserId, CancellationToken ct = default);
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

    public async Task UpdateGroupAsync(int groupId, string groupName, string? description, CancellationToken ct = default)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE dbo.PortalPermissionGroups SET GroupName = @groupName, Description = @description WHERE GroupID = @groupId",
            new { groupId, groupName, description }, cancellationToken: ct));
    }

    /// <summary>Junction rows cascade-delete (ON DELETE CASCADE on both PortalPermissionGroupPermissions and PortalUserPermissionGroups) — one DELETE is enough.</summary>
    public async Task DeleteGroupAsync(int groupId, CancellationToken ct = default)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "DELETE FROM dbo.PortalPermissionGroups WHERE GroupID = @groupId", new { groupId }, cancellationToken: ct));
    }

    public async Task SetGroupPermissionsAsync(int groupId, IReadOnlyList<string> permissionCodes, CancellationToken ct = default)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var current = (await connection.QueryAsync<string>(new CommandDefinition(
            "SELECT PermissionCode FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId",
            new { groupId }, cancellationToken: ct))).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var desired = permissionCodes.ToHashSet(StringComparer.OrdinalIgnoreCase);

        var toAdd = desired.Except(current, StringComparer.OrdinalIgnoreCase).ToArray();
        var toRemove = current.Except(desired, StringComparer.OrdinalIgnoreCase).ToArray();

        foreach (var code in toAdd)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@groupId, @code)",
                new { groupId, code }, cancellationToken: ct));
        }
        if (toRemove.Length > 0)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "DELETE FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode IN @toRemove",
                new { groupId, toRemove }, cancellationToken: ct));
        }
    }

    public async Task<int> AssignGroupToUsersAsync(int groupId, IReadOnlyList<int> userIds, int? grantedByUserId, CancellationToken ct = default)
    {
        var assigned = 0;
        using var connection = await db.CreateConnectionAsync(ct);
        foreach (var userId in userIds.Distinct())
        {
            var affected = await connection.ExecuteAsync(new CommandDefinition("""
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalUserPermissionGroups WHERE UserID = @userId AND GroupID = @groupId)
                    INSERT INTO dbo.PortalUserPermissionGroups (UserID, GroupID, GrantedByUserID, GrantedAt)
                    VALUES (@userId, @groupId, @grantedByUserId, GETDATE())
                """, new { userId, groupId, grantedByUserId }, cancellationToken: ct));
            assigned += affected;
        }
        return assigned;
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
