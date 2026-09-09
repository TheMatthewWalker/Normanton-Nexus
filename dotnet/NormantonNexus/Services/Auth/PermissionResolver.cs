using Dapper;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Services.Auth;

/// <summary>
/// Computes a user's EFFECTIVE tile permission set at login: direct grants
/// (PortalUserPermissions, kept for one-off exceptions — same table Node
/// already uses) UNION every permission in every group the user belongs to
/// (PortalUserPermissionGroups -> PortalPermissionGroupPermissions). See the
/// migration plan's "Authorization model" section — this is the new part;
/// role and department resolution stay simple single-table reads done
/// alongside this in AuthService, not through this class.
/// </summary>
public interface IPermissionResolver
{
    Task<IReadOnlyCollection<string>> GetEffectivePermissionsAsync(int userId, CancellationToken ct = default);
}

internal sealed class PermissionResolver(INexusDb db) : IPermissionResolver
{
    public async Task<IReadOnlyCollection<string>> GetEffectivePermissionsAsync(int userId, CancellationToken ct = default)
    {
        const string sql = """
            SELECT PermissionCode FROM dbo.PortalUserPermissions WHERE UserID = @userId
            UNION
            SELECT gp.PermissionCode
            FROM dbo.PortalUserPermissionGroups ug
            JOIN dbo.PortalPermissionGroupPermissions gp ON gp.GroupID = ug.GroupID
            WHERE ug.UserID = @userId
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var command = new CommandDefinition(sql, new { userId }, cancellationToken: ct);
        var codes = await connection.QueryAsync<string>(command);
        return codes.ToArray();
    }
}
