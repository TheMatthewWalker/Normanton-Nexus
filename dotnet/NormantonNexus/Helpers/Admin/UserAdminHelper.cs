using System.Text.RegularExpressions;
using Dapper;
using Microsoft.Data.SqlClient;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Admin;

/// <summary>
/// User &amp; permission administration — Phase 9. Port of
/// routes/useradmin.js in full (mounted at api/admin per server.js, not
/// this Node file's own stale header comment claiming api/useradmin).
/// Role-hierarchy comparisons that Node does inline in each handler
/// (ROLE_LEVEL, "can't edit a user with an equal or higher role") are
/// reused here via NexusRoles.LevelOf rather than redefining the
/// hierarchy a second time.
/// </summary>
internal static class UserAdminHelper
{
    private static readonly Regex UsernameRegex = new(@"^[a-z0-9._-]{1,80}$", RegexOptions.Compiled);
    private static readonly Regex EmailRegex = new(@"^[^\s@]+@[^\s@]+\.[^\s@]+$", RegexOptions.Compiled);
    private static readonly Regex PermissionCodeRegex = new(@"^[A-Z0-9_]{2,50}$", RegexOptions.Compiled);

    private static readonly HashSet<string> ValidRoles = new(StringComparer.Ordinal) { NexusRoles.Operator, NexusRoles.Admin, NexusRoles.Superadmin };

    private static readonly HashSet<string> ValidDepartments = new(StringComparer.Ordinal)
    {
        NexusDepartments.Production, NexusDepartments.Logistics, NexusDepartments.Warehouse, NexusDepartments.Finance,
        NexusDepartments.Sales, NexusDepartments.Quality, NexusDepartments.Engineering, NexusDepartments.Management,
    };

    private static readonly string[] ValidAuditEvents =
    [
        "LOGIN_OK", "LOGIN_FAIL", "LOGOUT", "REGISTER",
        "APPROVED", "REJECTED", "ROLE_CHANGE", "DEPT_CHANGE", "LOCKED", "UNLOCKED",
        "USERNAME_CHANGE", "PROFILE_CHANGE", "IDLE_TIMEOUT_CHANGE",
        "RAW_SQL", "RAW_SQL_BLOCKED", "RAW_SQL_ERROR",
        "SAP_OK", "SAP_ERROR",
        "PERM_GRANT", "PERM_REVOKE", "PERM_CREATE", "PERM_UPDATE", "PERM_DELETE", "PERM_BULK_GRANT",
        "BULK_CREATE", "PASSWORD_CHANGE", "DEPT_BULK_GRANT", "STATUS_BULK_UPDATE",
    ];

    // ── Pure validators (no DB) ────────────────────────────────────────

    internal static bool IsValidRole(string? role) => role is not null && ValidRoles.Contains(role);
    internal static bool IsValidDepartment(string? department) => department is not null && ValidDepartments.Contains(department);
    internal static bool AreValidDepartments(IEnumerable<string>? departments) => departments is null || departments.All(IsValidDepartment);
    internal static bool IsValidUsername(string? username) => username is not null && UsernameRegex.IsMatch(username);
    internal static bool IsValidEmail(string? email) => email is not null && EmailRegex.IsMatch(email);
    internal static bool IsValidPermissionCode(string? code) => code is not null && PermissionCodeRegex.IsMatch(code);
    internal static bool IsValidAuditEvent(string? evt) => evt is null || ValidAuditEvents.Contains(evt);

    /// <summary>Node's own bulk-create row check: at least 10 chars, one uppercase letter, one digit.</summary>
    internal static bool IsStrongEnoughPassword(string? password) =>
        password is not null && password.Length >= 10 && password.Any(char.IsUpper) && password.Any(char.IsDigit);

    /// <summary>True unless a non-superadmin actor is trying to touch a user whose CURRENT role is equal to or higher than their own.</summary>
    internal static bool ActorCanEditTargetRole(string? actorRole, string? targetRole) =>
        actorRole == NexusRoles.Superadmin || NexusRoles.LevelOf(targetRole) < NexusRoles.LevelOf(actorRole);

    /// <summary>True unless a non-superadmin actor is trying to ASSIGN a role equal to or higher than their own.</summary>
    internal static bool ActorCanAssignRole(string? actorRole, string? role) =>
        actorRole == NexusRoles.Superadmin || NexusRoles.LevelOf(role) < NexusRoles.LevelOf(actorRole);

    private static bool IsUniqueViolation(Exception ex) =>
        ex is SqlException { Number: 2627 or 2601 } || ex.Message.Contains("UNIQUE", StringComparison.OrdinalIgnoreCase) || ex.Message.Contains("duplicate", StringComparison.OrdinalIgnoreCase);

    // ── GET /pending ────────────────────────────────────────────────────

    internal static async Task<IReadOnlyList<PendingUserRow>> ListPendingAsync(INexusDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<PendingUserRow>(new CommandDefinition("""
            SELECT UserID AS UserId, Username, FirstName, LastName, Email, CreatedAt
            FROM dbo.PortalUsers WHERE IsActive = 0 ORDER BY CreatedAt ASC
            """, cancellationToken: ct));
        return rows.AsList();
    }

    // ── GET /users ──────────────────────────────────────────────────────

    private sealed record UserHeaderRow(int UserId, string Username, string? FirstName, string? LastName, string Email, string Role,
        bool IsActive, bool IsLocked, int FailedLogins, bool ShortIdleTimeout, DateTime CreatedAt, DateTime? LastLogin, string? Notes);

    internal static async Task<IReadOnlyList<AdminUserRow>> ListUsersAsync(INexusDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var usersTask = connection.QueryAsync<UserHeaderRow>(new CommandDefinition("""
            SELECT UserID AS UserId, Username, FirstName, LastName, Email, Role,
                   IsActive, IsLocked, FailedLogins, ShortIdleTimeout, CreatedAt, LastLogin, Notes
            FROM dbo.PortalUsers ORDER BY CreatedAt DESC
            """, cancellationToken: ct));
        var deptsTask = connection.QueryAsync<(int UserId, string Department)>(new CommandDefinition(
            "SELECT UserID AS UserId, Department FROM dbo.PortalUserDepartments", cancellationToken: ct));
        var permsTask = connection.QueryAsync<(int UserId, string PermissionCode)>(new CommandDefinition(
            "SELECT UserID AS UserId, PermissionCode FROM dbo.PortalUserPermissions", cancellationToken: ct));

        await Task.WhenAll(usersTask, deptsTask, permsTask);

        var deptMap = deptsTask.Result.GroupBy(r => r.UserId).ToDictionary(g => g.Key, g => (IReadOnlyList<string>)g.Select(r => r.Department).ToList());
        var permMap = permsTask.Result.GroupBy(r => r.UserId).ToDictionary(g => g.Key, g => (IReadOnlyList<string>)g.Select(r => r.PermissionCode).ToList());

        return usersTask.Result.Select(u => new AdminUserRow(
            u.UserId, u.Username, u.FirstName, u.LastName, u.Email, u.Role, u.IsActive, u.IsLocked, u.FailedLogins,
            u.ShortIdleTimeout, u.CreatedAt, u.LastLogin, u.Notes,
            deptMap.GetValueOrDefault(u.UserId, []), permMap.GetValueOrDefault(u.UserId, []))).ToList();
    }

    // ── PUT /users/{id} ─────────────────────────────────────────────────

    private sealed record PrevUserRow(string Username, string? FirstName, string? LastName, string Email, string Role, bool IsActive, bool IsLocked, bool ShortIdleTimeout);

    internal static async Task UpdateUserAsync(INexusDb db, IAuditLogger audit, int userId, UpdateUserRequest body, string? actorRole, string? actorUsername, string? ipAddress, CancellationToken ct)
    {
        if (body.Role is not null && !IsValidRole(body.Role))
            throw new NexusValidationException("Invalid role");
        if (!AreValidDepartments(body.Departments))
            throw new NexusValidationException("Invalid department in list");

        var hasIdentityChange = body.Username is not null || body.FirstName is not null || body.LastName is not null || body.Email is not null;
        if (hasIdentityChange && actorRole != NexusRoles.Superadmin)
            throw new NexusPermissionException("Only superadmins can edit username, name and email.");

        var newUsername = body.Username?.Trim();
        if (!string.IsNullOrEmpty(newUsername) && !IsValidUsername(newUsername))
            throw new NexusValidationException("Username must be 1–80 chars: lowercase letters, digits, dots, hyphens, underscores.");

        var newEmail = body.Email?.Trim().ToLowerInvariant();
        if (!string.IsNullOrEmpty(newEmail) && !IsValidEmail(newEmail))
            throw new NexusValidationException("Invalid email address.");

        using var connection = await db.CreateConnectionAsync(ct);

        var prev = await connection.QuerySingleOrDefaultAsync<PrevUserRow>(new CommandDefinition(
            "SELECT Username, FirstName, LastName, Email, Role, IsActive, IsLocked, ShortIdleTimeout FROM dbo.PortalUsers WHERE UserID = @userId",
            new { userId }, cancellationToken: ct)) ?? throw new NexusNotFoundException("User not found");

        if (!ActorCanEditTargetRole(actorRole, prev.Role))
            throw new NexusPermissionException("You cannot edit a user with an equal or higher role.");
        if (body.Role is not null && !ActorCanAssignRole(actorRole, body.Role))
            throw new NexusPermissionException("You cannot assign a role equal to or higher than your own.");

        if (!string.IsNullOrEmpty(newUsername) && !string.Equals(newUsername, prev.Username, StringComparison.Ordinal))
        {
            var taken = await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition(
                "SELECT 1 FROM dbo.PortalUsers WHERE Username = @newUsername AND UserID != @userId", new { newUsername, userId }, cancellationToken: ct));
            if (taken is not null) throw new NexusConflictException("That username is already taken.");
        }
        if (!string.IsNullOrEmpty(newEmail) && !string.Equals(newEmail, prev.Email, StringComparison.Ordinal))
        {
            var taken = await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition(
                "SELECT 1 FROM dbo.PortalUsers WHERE Email = @newEmail AND UserID != @userId", new { newEmail, userId }, cancellationToken: ct));
            if (taken is not null) throw new NexusConflictException("That email address is already in use.");
        }

        var role = body.Role ?? prev.Role;
        var isActive = body.IsActive ?? prev.IsActive;
        var isLocked = body.IsLocked ?? prev.IsLocked;
        var firstName = body.FirstName is not null ? NullIfBlank(body.FirstName) : prev.FirstName;
        var lastName = body.LastName is not null ? NullIfBlank(body.LastName) : prev.LastName;
        var email = newEmail ?? prev.Email;
        var username = !string.IsNullOrEmpty(newUsername) ? newUsername : prev.Username;
        var shortIdleTimeout = body.ShortIdleTimeout ?? prev.ShortIdleTimeout;

        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE dbo.PortalUsers SET
                Role = @role, IsActive = @isActive, IsLocked = @isLocked, Notes = @notes,
                Username = @username, FirstName = @firstName, LastName = @lastName, Email = @email,
                ShortIdleTimeout = @shortIdleTimeout,
                FailedLogins = CASE WHEN @isLocked = 0 THEN 0 ELSE FailedLogins END
            WHERE UserID = @userId
            """, new { userId, role, isActive, isLocked, notes = body.Notes, username, firstName, lastName, email, shortIdleTimeout }, cancellationToken: ct));

        var oldUsername = prev.Username;
        if (!string.IsNullOrEmpty(newUsername) && !string.Equals(newUsername, oldUsername, StringComparison.Ordinal))
        {
            await connection.ExecuteAsync(new CommandDefinition("UPDATE dbo.PortalAuditLog SET Username = @newUsername WHERE Username = @oldUsername", new { newUsername, oldUsername }, cancellationToken: ct));
            await connection.ExecuteAsync(new CommandDefinition("UPDATE dbo.PortalUsers SET ApprovedBy = @newUsername WHERE ApprovedBy = @oldUsername", new { newUsername, oldUsername }, cancellationToken: ct));
            await connection.ExecuteAsync(new CommandDefinition("UPDATE dbo.PortalUserDepartments SET GrantedBy = @newUsername WHERE GrantedBy = @oldUsername", new { newUsername, oldUsername }, cancellationToken: ct));
        }

        if (body.Departments is not null)
        {
            await connection.ExecuteAsync(new CommandDefinition("DELETE FROM dbo.PortalUserDepartments WHERE UserID = @userId", new { userId }, cancellationToken: ct));
            foreach (var dept in body.Departments)
            {
                await connection.ExecuteAsync(new CommandDefinition(
                    "INSERT INTO dbo.PortalUserDepartments (UserID, Department, GrantedBy) VALUES (@userId, @dept, @actorUsername)",
                    new { userId, dept, actorUsername }, cancellationToken: ct));
            }
        }

        var displayName = !string.IsNullOrEmpty(newUsername) ? newUsername : oldUsername;
        if (!string.IsNullOrEmpty(newUsername) && !string.Equals(newUsername, oldUsername, StringComparison.Ordinal))
            await audit.LogAsync("USERNAME_CHANGE", actorUsername, $"Renamed {oldUsername} → {newUsername}", ipAddress, ct);
        if ((body.FirstName is not null && (body.FirstName.Trim()) != (prev.FirstName ?? ""))
            || (body.LastName is not null && (body.LastName.Trim()) != (prev.LastName ?? ""))
            || (!string.IsNullOrEmpty(newEmail) && newEmail != prev.Email))
            await audit.LogAsync("PROFILE_CHANGE", actorUsername, $"Updated profile details for {displayName}", ipAddress, ct);
        if (body.Role is not null && body.Role != prev.Role)
            await audit.LogAsync("ROLE_CHANGE", actorUsername, $"Changed {displayName} role: {prev.Role} → {body.Role}", ipAddress, ct);
        if (body.Departments is not null)
            await audit.LogAsync("DEPT_CHANGE", actorUsername, $"Updated {displayName} departments: {(body.Departments.Count > 0 ? string.Join(", ", body.Departments) : "none")}", ipAddress, ct);
        if (body.IsLocked is not null && body.IsLocked != prev.IsLocked)
            await audit.LogAsync(body.IsLocked.Value ? "LOCKED" : "UNLOCKED", actorUsername, $"{(body.IsLocked.Value ? "Locked" : "Unlocked")} account: {displayName}", ipAddress, ct);
        if (body.ShortIdleTimeout is not null && body.ShortIdleTimeout != prev.ShortIdleTimeout)
            await audit.LogAsync("IDLE_TIMEOUT_CHANGE", actorUsername, $"{(body.ShortIdleTimeout.Value ? "Enabled" : "Disabled")} 5-minute idle timeout for {displayName}", ipAddress, ct);
    }

    private static string? NullIfBlank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    // ── POST /users/{id}/approve ────────────────────────────────────────

    internal static async Task ApproveUserAsync(INexusDb db, IAuditLogger audit, int userId, ApproveUserRequest body, string? actorRole, string? actorUsername, string? ipAddress, CancellationToken ct)
    {
        var role = body.Role ?? NexusRoles.Operator;
        if (!IsValidRole(role)) throw new NexusValidationException("Invalid role");
        if (!ActorCanAssignRole(actorRole, role)) throw new NexusPermissionException("You cannot approve a user into a role equal to or higher than your own.");
        var departments = body.Departments ?? [];
        if (!AreValidDepartments(departments)) throw new NexusValidationException("Invalid department in list");

        using var connection = await db.CreateConnectionAsync(ct);

        var approvedUsername = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition("""
            UPDATE dbo.PortalUsers SET IsActive = 1, Role = @role, ApprovedBy = @actorUsername, ApprovedAt = GETDATE()
            OUTPUT INSERTED.Username
            WHERE UserID = @userId AND IsActive = 0
            """, new { userId, role, actorUsername }, cancellationToken: ct));
        if (approvedUsername is null) throw new NexusNotFoundException("Pending user not found");

        foreach (var dept in departments)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "INSERT INTO dbo.PortalUserDepartments (UserID, Department, GrantedBy) VALUES (@userId, @dept, @actorUsername)",
                new { userId, dept, actorUsername }, cancellationToken: ct));
        }

        await audit.LogAsync("APPROVED", actorUsername, $"Approved {approvedUsername} as {role} — depts: {(departments.Count > 0 ? string.Join(", ", departments) : "none")}", ipAddress, ct);
    }

    // ── POST /users/{id}/reject ─────────────────────────────────────────

    internal static async Task RejectUserAsync(INexusDb db, IAuditLogger audit, int userId, string? actorUsername, string? ipAddress, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rejectedUsername = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "DELETE FROM dbo.PortalUsers OUTPUT DELETED.Username WHERE UserID = @userId AND IsActive = 0", new { userId }, cancellationToken: ct));
        if (rejectedUsername is null) throw new NexusNotFoundException("Pending user not found");

        await audit.LogAsync("REJECTED", actorUsername, $"Rejected registration for {rejectedUsername}", ipAddress, ct);
    }

    // ── POST /users/bulk-create (superadmin only) ────────────────────────

    internal static async Task<BulkCreateUsersResult> BulkCreateUsersAsync(INexusDb db, IAuditLogger audit, BulkCreateUsersRequest body, string? actorUsername, int actorUserId, string? ipAddress, CancellationToken ct)
    {
        var rows = body.Rows ?? [];
        if (rows.Count == 0) throw new NexusValidationException("No rows provided.");
        if (rows.Count > 500) throw new NexusValidationException("Maximum 500 rows per batch.");
        if (body.Department is not null && !IsValidDepartment(body.Department)) throw new NexusValidationException("Invalid department.");

        var results = new List<BulkCreateRowResult>();
        var hashCache = new Dictionary<string, string>(StringComparer.Ordinal);
        var seenUsernames = new HashSet<string>(StringComparer.Ordinal);
        var seenEmails = new HashSet<string>(StringComparer.Ordinal);

        using var connection = await db.CreateConnectionAsync(ct);

        for (var i = 0; i < rows.Count; i++)
        {
            var raw = rows[i];
            var rowNum = i + 1;
            var role = (raw.Role ?? "operator").Trim().ToLowerInvariant();
            var username = (raw.Username ?? "").Trim();
            var email = (raw.Email ?? "").Trim().ToLowerInvariant();
            var firstName = (raw.FirstName ?? "").Trim();
            var lastName = (raw.LastName ?? "").Trim();
            var password = raw.Password ?? "";
            var approved = raw.Approved ?? true;
            var isLocked = !(raw.Unlocked ?? true);
            var permissionCode = string.IsNullOrWhiteSpace(raw.PermissionCode) ? null : raw.PermissionCode.Trim().ToUpperInvariant();

            void Fail(string error) => results.Add(new BulkCreateRowResult(rowNum, username, false, error, null));

            if (!IsValidRole(role)) { Fail($"Invalid role \"{role}\""); continue; }
            if (!IsValidUsername(username)) { Fail("Invalid username — use lowercase letters, digits, dots, hyphens, underscores."); continue; }
            if (!IsValidEmail(email)) { Fail("Invalid email address."); continue; }
            if (firstName.Length == 0 || lastName.Length == 0) { Fail("First and last name are required."); continue; }
            if (!IsStrongEnoughPassword(password)) { Fail("Password must be at least 10 characters with one uppercase letter and one number."); continue; }
            if (permissionCode is not null && !IsValidPermissionCode(permissionCode)) { Fail($"Invalid permission code \"{permissionCode}\"."); continue; }

            var usernameKey = username.ToLowerInvariant();
            if (!seenUsernames.Add(usernameKey)) { Fail("Duplicate username within this batch."); continue; }
            if (!seenEmails.Add(email)) { Fail("Duplicate email within this batch."); continue; }

            var taken = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
                "SELECT TOP 1 Username FROM dbo.PortalUsers WHERE Username = @username OR Email = @email", new { username, email }, cancellationToken: ct));
            if (taken is not null) { Fail(taken == username ? "Username already exists." : "Email already registered."); continue; }

            if (permissionCode is not null)
            {
                var permExists = await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition(
                    "SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = @permissionCode", new { permissionCode }, cancellationToken: ct));
                if (permExists is null) { Fail($"Permission code \"{permissionCode}\" does not exist."); continue; }
            }

            if (!hashCache.TryGetValue(password, out var hash))
            {
                hash = BCrypt.Net.BCrypt.HashPassword(password, workFactor: 12);
                hashCache[password] = hash;
            }

            using var transaction = connection.BeginTransaction();
            try
            {
                var newUserId = await connection.QuerySingleAsync<int>(new CommandDefinition("""
                    INSERT INTO dbo.PortalUsers
                        (Username, FirstName, LastName, Email, PasswordHash, Role, IsActive, IsLocked, MustChangePassword, ApprovedBy, ApprovedAt)
                    OUTPUT INSERTED.UserID
                    VALUES (@username, @firstName, @lastName, @email, @hash, @role, @isActive, @isLocked, 1, @approvedBy,
                        CASE WHEN @isActive = 1 THEN GETDATE() ELSE NULL END)
                    """, new { username, firstName, lastName, email, hash, role, isActive = approved, isLocked, approvedBy = approved ? actorUsername : null },
                    transaction, cancellationToken: ct));

                if (body.Department is not null)
                {
                    await connection.ExecuteAsync(new CommandDefinition(
                        "INSERT INTO dbo.PortalUserDepartments (UserID, Department, GrantedBy) VALUES (@newUserId, @dept, @actorUsername)",
                        new { newUserId, dept = body.Department, actorUsername }, transaction, cancellationToken: ct));
                }
                if (permissionCode is not null)
                {
                    await connection.ExecuteAsync(new CommandDefinition(
                        "INSERT INTO dbo.PortalUserPermissions (UserID, PermissionCode, GrantedByUserID) VALUES (@newUserId, @permissionCode, @actorUserId)",
                        new { newUserId, permissionCode, actorUserId }, transaction, cancellationToken: ct));
                }

                transaction.Commit();
                results.Add(new BulkCreateRowResult(rowNum, username, true, null, newUserId));
            }
            catch (Exception ex)
            {
                transaction.Rollback();
                Fail(ex.Message);
            }
        }

        var succeeded = results.Count(r => r.Success);
        var failed = results.Count - succeeded;
        await audit.LogAsync("BULK_CREATE", actorUsername,
            $"Bulk-created {succeeded} user(s){(failed > 0 ? $", {failed} failed" : "")}{(body.Department is not null ? $" — department: {body.Department}" : "")}", ipAddress, ct);

        return new BulkCreateUsersResult(results, new BulkCreateSummary(rows.Count, succeeded, failed));
    }

    // ── POST /users/bulk-departments ─────────────────────────────────────

    internal static async Task<BulkGrantResult> BulkGrantDepartmentsAsync(INexusDb db, IAuditLogger audit, BulkDepartmentsRequest body, string? actorUsername, string? ipAddress, CancellationToken ct)
    {
        var ids = (body.UserIds ?? []).Distinct().ToList();
        if (ids.Count == 0) throw new NexusValidationException("Select at least one user.");
        if (ids.Count > 500) throw new NexusValidationException("Maximum 500 users per batch.");
        var depts = (body.Departments ?? []).Distinct().ToList();
        if (depts.Count == 0) throw new NexusValidationException("Select at least one department.");
        if (!AreValidDepartments(depts)) throw new NexusValidationException("Invalid department in selection.");

        using var connection = await db.CreateConnectionAsync(ct);
        var userMap = (await connection.QueryAsync<(int UserId, string Username)>(new CommandDefinition(
            "SELECT UserID AS UserId, Username FROM dbo.PortalUsers WHERE UserID IN @ids", new { ids }, cancellationToken: ct)))
            .ToDictionary(r => r.UserId, r => r.Username);

        var results = new List<BulkGrantRowResult>();
        foreach (var userId in ids)
        {
            if (!userMap.TryGetValue(userId, out var username))
            {
                results.Add(new BulkGrantRowResult(userId, null, 0, 0, "User not found"));
                continue;
            }

            int granted = 0, alreadyHad = 0;
            foreach (var dept in depts)
            {
                try
                {
                    await connection.ExecuteAsync(new CommandDefinition(
                        "INSERT INTO dbo.PortalUserDepartments (UserID, Department, GrantedBy) VALUES (@userId, @dept, @actorUsername)",
                        new { userId, dept, actorUsername }, cancellationToken: ct));
                    granted++;
                }
                catch (Exception ex) when (IsUniqueViolation(ex))
                {
                    alreadyHad++;
                }
            }
            results.Add(new BulkGrantRowResult(userId, username, granted, alreadyHad, null));
        }

        var totalGranted = results.Sum(r => r.Granted);
        var totalAlready = results.Sum(r => r.AlreadyHad);
        var totalFailed = results.Count(r => r.Error is not null);

        await audit.LogAsync("DEPT_BULK_GRANT", actorUsername,
            $"Granted [{string.Join(", ", depts)}] to {ids.Count} user(s) — {totalGranted} new grant(s), {totalAlready} already held{(totalFailed > 0 ? $", {totalFailed} user(s) not found" : "")}", ipAddress, ct);

        return new BulkGrantResult(results, new BulkGrantSummary(ids.Count, totalGranted, totalAlready, totalFailed));
    }

    // ── POST /users/bulk-status ──────────────────────────────────────────

    internal static async Task<BulkStatusResult> BulkSetStatusAsync(INexusDb db, IAuditLogger audit, BulkStatusRequest body, string? actorRole, string? actorUsername, string? ipAddress, CancellationToken ct)
    {
        var ids = (body.UserIds ?? []).Distinct().ToList();
        if (ids.Count == 0) throw new NexusValidationException("Select at least one user.");
        if (ids.Count > 500) throw new NexusValidationException("Maximum 500 users per batch.");
        if (body.IsActive is null && body.IsLocked is null && body.ShortIdleTimeout is null)
            throw new NexusValidationException("Select at least one setting to change.");

        using var connection = await db.CreateConnectionAsync(ct);
        var userMap = (await connection.QueryAsync<(int UserId, string Username, string Role)>(new CommandDefinition(
            "SELECT UserID AS UserId, Username, Role FROM dbo.PortalUsers WHERE UserID IN @ids", new { ids }, cancellationToken: ct)))
            .ToDictionary(r => r.UserId, r => r);

        var results = new List<BulkStatusRowResult>();
        foreach (var userId in ids)
        {
            if (!userMap.TryGetValue(userId, out var user))
            {
                results.Add(new BulkStatusRowResult(userId, null, false, "User not found"));
                continue;
            }
            if (!ActorCanEditTargetRole(actorRole, user.Role))
            {
                results.Add(new BulkStatusRowResult(userId, user.Username, false, "Cannot edit a user with an equal or higher role."));
                continue;
            }

            var sets = new List<string>();
            var parameters = new DynamicParameters();
            parameters.Add("userId", userId);
            if (body.IsActive is not null) { sets.Add("IsActive = @isActive"); parameters.Add("isActive", body.IsActive.Value); }
            if (body.IsLocked is not null)
            {
                sets.Add("IsLocked = @isLocked");
                parameters.Add("isLocked", body.IsLocked.Value);
                if (!body.IsLocked.Value) sets.Add("FailedLogins = 0");
            }
            if (body.ShortIdleTimeout is not null) { sets.Add("ShortIdleTimeout = @shortIdleTimeout"); parameters.Add("shortIdleTimeout", body.ShortIdleTimeout.Value); }

            await connection.ExecuteAsync(new CommandDefinition($"UPDATE dbo.PortalUsers SET {string.Join(", ", sets)} WHERE UserID = @userId", parameters, cancellationToken: ct));
            results.Add(new BulkStatusRowResult(userId, user.Username, true, null));
        }

        var succeeded = results.Count(r => r.Success);
        var failed = results.Count - succeeded;
        var changes = new List<string>();
        if (body.IsActive is not null) changes.Add($"Active={body.IsActive.Value}");
        if (body.IsLocked is not null) changes.Add($"Locked={body.IsLocked.Value}");
        if (body.ShortIdleTimeout is not null) changes.Add($"ShortIdleTimeout={body.ShortIdleTimeout.Value}");

        await audit.LogAsync("STATUS_BULK_UPDATE", actorUsername,
            $"Set [{string.Join(", ", changes)}] on {succeeded} user(s){(failed > 0 ? $", {failed} failed" : "")}", ipAddress, ct);

        return new BulkStatusResult(results, new BulkCreateSummary(ids.Count, succeeded, failed));
    }

    // ── GET /audit ────────────────────────────────────────────────────────

    internal static async Task<IReadOnlyList<AuditLogRow>> ListAuditLogAsync(INexusDb db, AuditLogQuery query, CancellationToken ct)
    {
        if (!IsValidAuditEvent(query.Event)) throw new NexusValidationException("Invalid event filter");

        var clauses = new List<string>();
        var parameters = new DynamicParameters();
        if (query.Event is not null) { clauses.Add("EventType = @event"); parameters.Add("event", query.Event); }
        if (query.Username is not null) { clauses.Add("Username LIKE @username"); parameters.Add("username", $"%{query.Username}%"); }
        if (query.Detail is not null) { clauses.Add("Detail LIKE @detail"); parameters.Add("detail", $"%{query.Detail}%"); }
        if (query.From is not null) { clauses.Add("EventTime >= @from"); parameters.Add("from", query.From.Value); }
        if (query.To is not null) { clauses.Add("EventTime < DATEADD(day, 1, @to)"); parameters.Add("to", query.To.Value); }

        var whereClause = clauses.Count > 0 ? $"WHERE {string.Join(" AND ", clauses)}" : "";

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<AuditLogRow>(new CommandDefinition($"""
            SELECT TOP 500 LogID AS LogId, EventTime, Username, EventType, Detail, IPAddress AS IpAddress
            FROM dbo.PortalAuditLog
            {whereClause}
            ORDER BY EventTime DESC
            """, parameters, cancellationToken: ct));
        return rows.AsList();
    }

    // ── Permission definitions (superadmin only) ─────────────────────────

    internal static async Task<IReadOnlyList<PermissionDefinitionRow>> ListPermissionDefinitionsAsync(INexusDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<PermissionDefinitionRow>(new CommandDefinition("""
            SELECT PermissionCode, PermissionName, Description, Category, CreatedAt
            FROM dbo.PortalPermissions ORDER BY Category, PermissionCode
            """, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<string> CreatePermissionDefinitionAsync(INexusDb db, IAuditLogger audit, CreatePermissionRequest body, string? actorUsername, string? ipAddress, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.PermissionCode) || string.IsNullOrWhiteSpace(body.PermissionName) || string.IsNullOrWhiteSpace(body.Category))
            throw new NexusValidationException("permissionCode, permissionName and category are required.");

        var code = body.PermissionCode.Trim().ToUpperInvariant();
        if (!IsValidPermissionCode(code))
            throw new NexusValidationException("Permission code must be 2-50 uppercase letters, digits or underscores.");

        using var connection = await db.CreateConnectionAsync(ct);
        var exists = await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition(
            "SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = @code", new { code }, cancellationToken: ct));
        if (exists is not null) throw new NexusConflictException("Permission code already exists.");

        var name = body.PermissionName.Trim();
        var description = string.IsNullOrWhiteSpace(body.Description) ? null : body.Description.Trim();
        var category = body.Category.Trim();
        await connection.ExecuteAsync(new CommandDefinition(
            "INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category) VALUES (@code, @name, @description, @category)",
            new { code, name, description, category }, cancellationToken: ct));

        await audit.LogAsync("PERM_CREATE", actorUsername, $"Created permission: {code} ({name})", ipAddress, ct);
        return code;
    }

    internal static async Task UpdatePermissionDefinitionAsync(INexusDb db, IAuditLogger audit, string code, UpdatePermissionRequest body, string? actorUsername, string? ipAddress, CancellationToken ct)
    {
        code = code.ToUpperInvariant();
        if (string.IsNullOrWhiteSpace(body.PermissionName) && string.IsNullOrWhiteSpace(body.Description) && string.IsNullOrWhiteSpace(body.Category))
            throw new NexusValidationException("Nothing to update.");

        using var connection = await db.CreateConnectionAsync(ct);
        var prev = await connection.QuerySingleOrDefaultAsync<(string PermissionName, string? Description, string Category)?>(new CommandDefinition(
            "SELECT PermissionName, Description, Category FROM dbo.PortalPermissions WHERE PermissionCode = @code", new { code }, cancellationToken: ct));
        if (prev is null) throw new NexusNotFoundException("Permission not found.");

        var name = !string.IsNullOrWhiteSpace(body.PermissionName) ? body.PermissionName.Trim() : prev.Value.PermissionName;
        var description = !string.IsNullOrWhiteSpace(body.Description) ? body.Description.Trim() : prev.Value.Description;
        var category = !string.IsNullOrWhiteSpace(body.Category) ? body.Category.Trim() : prev.Value.Category;

        await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE dbo.PortalPermissions SET PermissionName = @name, Description = @description, Category = @category WHERE PermissionCode = @code",
            new { code, name, description, category }, cancellationToken: ct));

        await audit.LogAsync("PERM_UPDATE", actorUsername, $"Updated permission: {code}", ipAddress, ct);
    }

    internal static async Task DeletePermissionDefinitionAsync(INexusDb db, IAuditLogger audit, string code, string? actorUsername, string? ipAddress, CancellationToken ct)
    {
        code = code.ToUpperInvariant();
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("DELETE FROM dbo.PortalUserPermissions WHERE PermissionCode = @code", new { code }, cancellationToken: ct));
        var deleted = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "DELETE FROM dbo.PortalPermissions OUTPUT DELETED.PermissionCode WHERE PermissionCode = @code", new { code }, cancellationToken: ct));
        if (deleted is null) throw new NexusNotFoundException("Permission not found.");

        await audit.LogAsync("PERM_DELETE", actorUsername, $"Deleted permission: {code}", ipAddress, ct);
    }

    // ── User ↔ permission (admin or superadmin) ──────────────────────────

    internal static async Task<IReadOnlyList<UserPermissionRow>> ListUserPermissionsAsync(INexusDb db, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<UserPermissionRow>(new CommandDefinition("""
            SELECT up.PermissionCode, p.PermissionName, p.Category, up.GrantedAt
            FROM dbo.PortalUserPermissions up
            JOIN dbo.PortalPermissions p ON p.PermissionCode = up.PermissionCode
            WHERE up.UserID = @userId ORDER BY p.Category, up.PermissionCode
            """, new { userId }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task GrantPermissionAsync(INexusDb db, IAuditLogger audit, int userId, GrantPermissionRequest body, int actorUserId, string? actorUsername, string? ipAddress, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.PermissionCode))
            throw new NexusValidationException("permissionCode is required.");
        var code = body.PermissionCode.Trim().ToUpperInvariant();

        using var connection = await db.CreateConnectionAsync(ct);
        var permExists = await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition(
            "SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = @code", new { code }, cancellationToken: ct));
        if (permExists is null) throw new NexusNotFoundException("Permission code does not exist.");

        var username = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT Username FROM dbo.PortalUsers WHERE UserID = @userId", new { userId }, cancellationToken: ct));
        if (username is null) throw new NexusNotFoundException("User not found.");

        try
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "INSERT INTO dbo.PortalUserPermissions (UserID, PermissionCode, GrantedByUserID) VALUES (@userId, @code, @actorUserId)",
                new { userId, code, actorUserId }, cancellationToken: ct));
        }
        catch (Exception ex) when (IsUniqueViolation(ex))
        {
            throw new NexusConflictException("User already has this permission.");
        }

        await audit.LogAsync("PERM_GRANT", actorUsername, $"Granted {code} to {username}", ipAddress, ct);
    }

    internal static async Task RevokePermissionAsync(INexusDb db, IAuditLogger audit, int userId, string code, string? actorUsername, string? ipAddress, CancellationToken ct)
    {
        code = code.ToUpperInvariant();
        using var connection = await db.CreateConnectionAsync(ct);
        var username = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT Username FROM dbo.PortalUsers WHERE UserID = @userId", new { userId }, cancellationToken: ct));
        if (username is null) throw new NexusNotFoundException("User not found.");

        var revoked = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "DELETE FROM dbo.PortalUserPermissions OUTPUT DELETED.PermissionCode WHERE UserID = @userId AND PermissionCode = @code",
            new { userId, code }, cancellationToken: ct));
        if (revoked is null) throw new NexusNotFoundException("Permission not assigned to this user.");

        await audit.LogAsync("PERM_REVOKE", actorUsername, $"Revoked {code} from {username}", ipAddress, ct);
    }

    internal static async Task<BulkGrantResult> BulkGrantPermissionsAsync(INexusDb db, IAuditLogger audit, BulkPermissionsRequest body, int actorUserId, string? actorUsername, string? ipAddress, CancellationToken ct)
    {
        var ids = (body.UserIds ?? []).Distinct().ToList();
        if (ids.Count == 0) throw new NexusValidationException("Select at least one user.");
        if (ids.Count > 500) throw new NexusValidationException("Maximum 500 users per batch.");
        var codes = (body.PermissionCodes ?? []).Select(c => c.Trim().ToUpperInvariant()).Distinct().ToList();
        if (codes.Count == 0) throw new NexusValidationException("Select at least one permission.");
        if (codes.Any(c => !IsValidPermissionCode(c))) throw new NexusValidationException("Invalid permission code in selection.");

        using var connection = await db.CreateConnectionAsync(ct);

        var validCodes = (await connection.QueryAsync<string>(new CommandDefinition(
            "SELECT PermissionCode FROM dbo.PortalPermissions WHERE PermissionCode IN @codes", new { codes }, cancellationToken: ct))).ToHashSet(StringComparer.Ordinal);
        var invalidCodes = codes.Where(c => !validCodes.Contains(c)).ToList();
        if (invalidCodes.Count > 0) throw new NexusValidationException($"Unknown permission code(s): {string.Join(", ", invalidCodes)}");

        var userMap = (await connection.QueryAsync<(int UserId, string Username)>(new CommandDefinition(
            "SELECT UserID AS UserId, Username FROM dbo.PortalUsers WHERE UserID IN @ids", new { ids }, cancellationToken: ct)))
            .ToDictionary(r => r.UserId, r => r.Username);

        var results = new List<BulkGrantRowResult>();
        foreach (var userId in ids)
        {
            if (!userMap.TryGetValue(userId, out var username))
            {
                results.Add(new BulkGrantRowResult(userId, null, 0, 0, "User not found"));
                continue;
            }

            int granted = 0, alreadyHad = 0;
            foreach (var code in codes)
            {
                try
                {
                    await connection.ExecuteAsync(new CommandDefinition(
                        "INSERT INTO dbo.PortalUserPermissions (UserID, PermissionCode, GrantedByUserID) VALUES (@userId, @code, @actorUserId)",
                        new { userId, code, actorUserId }, cancellationToken: ct));
                    granted++;
                }
                catch (Exception ex) when (IsUniqueViolation(ex))
                {
                    alreadyHad++;
                }
            }
            results.Add(new BulkGrantRowResult(userId, username, granted, alreadyHad, null));
        }

        var totalGranted = results.Sum(r => r.Granted);
        var totalAlready = results.Sum(r => r.AlreadyHad);
        var totalFailed = results.Count(r => r.Error is not null);

        await audit.LogAsync("PERM_BULK_GRANT", actorUsername,
            $"Granted [{string.Join(", ", codes)}] to {ids.Count} user(s) — {totalGranted} new grant(s), {totalAlready} already held{(totalFailed > 0 ? $", {totalFailed} user(s) not found" : "")}", ipAddress, ct);

        return new BulkGrantResult(results, new BulkGrantSummary(ids.Count, totalGranted, totalAlready, totalFailed));
    }
}
