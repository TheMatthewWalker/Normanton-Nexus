using Dapper;
using NormantonNexus.Models.Dto;
using NormantonNexus.Models;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Auth;

/// <summary>
/// "My Account" self-service — SAP credentials half. Port of
/// routes/profile.js's GET/POST/DELETE /sap-credentials (lib/sapCredentials.js's
/// getSapCredentialStatus/setSapCredentials/clearSapCredentials). Self-service
/// only, exactly like Node — every method acts on the caller's own UserID,
/// never a body/param-supplied one; there is deliberately no admin-facing
/// "set this for someone else" route. Password-change reuses the existing
/// IAuthService.ChangePasswordAsync directly rather than duplicating it here.
/// </summary>
internal static class ProfileHelper
{
    internal static async Task<SapCredentialStatus> GetSapCredentialStatusAsync(INexusDb db, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var row = await connection.QuerySingleOrDefaultAsync<(string? SapUsername, string? SapPasswordEncrypted, DateTime? SapCredentialUpdatedAt)?>(new CommandDefinition(
            "SELECT SapUsername, SapPasswordEncrypted, SapCredentialUpdatedAt FROM dbo.PortalUsers WHERE UserID = @userId",
            new { userId }, cancellationToken: ct));

        return new SapCredentialStatus(
            row?.SapUsername,
            !string.IsNullOrEmpty(row?.SapUsername) && !string.IsNullOrEmpty(row?.SapPasswordEncrypted),
            row?.SapCredentialUpdatedAt);
    }

    internal static async Task SetSapCredentialsAsync(INexusDb db, ISapCredentialCipher cipher, IAuditLogger audit, int userId, string username, string sapUsername, string sapPassword, string? ipAddress, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(sapUsername) || string.IsNullOrWhiteSpace(sapPassword))
            throw new NexusValidationException("SAP username and password are both required.");

        var encrypted = cipher.Encrypt(sapPassword);

        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE dbo.PortalUsers
            SET SapUsername = @sapUsername, SapPasswordEncrypted = @encrypted, SapCredentialUpdatedAt = GETUTCDATE()
            WHERE UserID = @userId
            """, new { userId, sapUsername = sapUsername.Trim(), encrypted }, cancellationToken: ct));

        await audit.LogAsync("SAP_CRED_SET", username, $"Set SAP username '{sapUsername.Trim()}'", ipAddress, ct);
    }

    internal static async Task ClearSapCredentialsAsync(INexusDb db, IAuditLogger audit, int userId, string username, string? ipAddress, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE dbo.PortalUsers
            SET SapUsername = NULL, SapPasswordEncrypted = NULL, SapCredentialUpdatedAt = NULL
            WHERE UserID = @userId
            """, new { userId }, cancellationToken: ct));

        await audit.LogAsync("SAP_CRED_CLEAR", username, "Cleared SAP credentials", ipAddress, ct);
    }
}
