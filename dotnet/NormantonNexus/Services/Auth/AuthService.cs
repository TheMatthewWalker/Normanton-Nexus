using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Services.Auth;

public enum LoginFailureReason
{
    InvalidCredentials,
    PendingApproval,
    AccountLocked,
}

public abstract record LoginResult
{
    public sealed record Success(ClaimsPrincipal Principal, AuthenticationProperties Properties) : LoginResult;
    public sealed record Failure(LoginFailureReason Reason) : LoginResult;

    private LoginResult() { }
}

public interface IAuthService
{
    Task<LoginResult> LoginAsync(string username, string password, string? ipAddress, CancellationToken ct = default);
}

internal sealed record PortalUserRow(
    int UserID, string Username, string Email, string PasswordHash, string Role,
    bool IsActive, bool IsLocked, int FailedLogins, bool ShortIdleTimeout, bool MustChangePassword);

/// <summary>
/// Faithful C# port of routes/auth.js's POST /login handler — see that
/// file's own comments (and the migration plan's Foundation-phase verification
/// checklist) for the behaviors this must match exactly: a hardcoded dummy
/// bcrypt compare for unknown usernames (constant-time-ish defense against
/// username enumeration via response timing), permanent lockout at 10 failed
/// attempts (admin-unlock only, no time-based auto-unlock), and a brand-new
/// session key issued on every successful login (session-fixation defense —
/// the C# equivalent of req.session.regenerate() is simply: PortalSessionStore
/// only ever mints a fresh key in StoreAsync, and SignInAsync always goes
/// through StoreAsync for a principal that wasn't already resolved from an
/// existing ticket, so a login always gets a new key here by construction).
/// </summary>
internal sealed class AuthService(
    INexusDb db,
    IPermissionResolver permissionResolver,
    IIdleTimeoutPolicy idleTimeoutPolicy,
    IOptions<AuthOptions> authOptions,
    IAuditLogger auditLogger) : IAuthService
{
    // Matches routes/auth.js's hardcoded dummy hash exactly — reused rather than
    // regenerated so an unknown-username request costs the same bcrypt work as a
    // known one, regardless of which app (Node or this one) handles it.
    private const string DummyHash = "$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    private readonly AuthOptions _authOptions = authOptions.Value;

    public async Task<LoginResult> LoginAsync(string username, string password, string? ipAddress, CancellationToken ct = default)
    {
        username = username.Trim();

        using var connection = await db.CreateConnectionAsync(ct);

        const string lookupSql = """
            SELECT UserID, Username, Email, PasswordHash, Role, IsActive, IsLocked, FailedLogins,
                   ShortIdleTimeout, MustChangePassword
            FROM dbo.PortalUsers WHERE Username = @username
            """;
        var user = await connection.QuerySingleOrDefaultAsync<PortalUserRow>(
            new CommandDefinition(lookupSql, new { username }, cancellationToken: ct));

        if (user is null)
        {
            // Dummy compare — same cost as a real bcrypt verify, so a missing
            // username doesn't respond measurably faster than a wrong password.
            BCrypt.Net.BCrypt.Verify(password, DummyHash);
            await auditLogger.LogAsync("LOGIN_FAIL", username, "Unknown username", ipAddress, ct);
            return new LoginResult.Failure(LoginFailureReason.InvalidCredentials);
        }

        if (!user.IsActive)
        {
            await auditLogger.LogAsync("LOGIN_FAIL", username, "Pending approval", ipAddress, ct);
            return new LoginResult.Failure(LoginFailureReason.PendingApproval);
        }

        if (user.IsLocked)
        {
            await auditLogger.LogAsync("LOGIN_FAIL", username, "Account locked", ipAddress, ct);
            return new LoginResult.Failure(LoginFailureReason.AccountLocked);
        }

        if (!BCrypt.Net.BCrypt.Verify(password, user.PasswordHash))
        {
            var newFailCount = user.FailedLogins + 1;
            var shouldLock = newFailCount >= _authOptions.MaxFailedLoginsBeforeLock;

            await connection.ExecuteAsync(new CommandDefinition(
                "UPDATE dbo.PortalUsers SET FailedLogins = @newFailCount, IsLocked = @shouldLock WHERE UserID = @userId",
                new { newFailCount, shouldLock, userId = user.UserID }, cancellationToken: ct));

            await auditLogger.LogAsync("LOGIN_FAIL", username,
                shouldLock ? "Account locked after repeated failures" : "Invalid password", ipAddress, ct);
            return new LoginResult.Failure(LoginFailureReason.InvalidCredentials);
        }

        // Success — reset the failure counter/lock (the only reset path, same as Node),
        // record LastLogin, and resolve departments + effective permissions.
        var departmentsTask = connection.QueryAsync<string>(new CommandDefinition(
            "SELECT Department FROM dbo.PortalUserDepartments WHERE UserID = @userId",
            new { userId = user.UserID }, cancellationToken: ct));
        var permissionsTask = permissionResolver.GetEffectivePermissionsAsync(user.UserID, ct);
        var resetTask = connection.ExecuteAsync(new CommandDefinition(
            "UPDATE dbo.PortalUsers SET FailedLogins = 0, IsLocked = 0, LastLogin = GETDATE() WHERE UserID = @userId",
            new { userId = user.UserID }, cancellationToken: ct));

        await Task.WhenAll(departmentsTask, permissionsTask, resetTask);
        var departments = await departmentsTask;
        var permissions = await permissionsTask;

        await auditLogger.LogAsync("LOGIN_OK", username, null, ipAddress, ct);

        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, user.UserID.ToString()),
            new(ClaimTypes.Name, user.Username),
            new(ClaimTypes.Email, user.Email),
            new(ClaimTypes.Role, user.Role),
        };
        claims.AddRange(departments.Select(d => new Claim(NexusClaimTypes.Department, d)));
        claims.AddRange(permissions.Select(p => new Claim(NexusClaimTypes.Permission, p)));
        if (user.ShortIdleTimeout) claims.Add(new Claim(NexusClaimTypes.ShortIdleTimeout, "1"));
        if (user.MustChangePassword) claims.Add(new Claim(NexusClaimTypes.MustChangePassword, "1"));

        var identity = new ClaimsIdentity(claims, NexusAuthScheme.Name);
        var principal = new ClaimsPrincipal(identity);

        // ShortIdleTimeout is read once here and baked into the ticket, same as
        // Node's req.session.user.shortIdleTimeout — a later admin change to the
        // DB flag only affects the NEXT login, not this session (see IdleTimeoutPolicy).
        var now = DateTimeOffset.UtcNow;
        var timeout = idleTimeoutPolicy.TimeoutFor(user.ShortIdleTimeout);
        var properties = new AuthenticationProperties
        {
            IssuedUtc = now,
            ExpiresUtc = now.Add(timeout),
            IsPersistent = true,
        };

        return new LoginResult.Success(principal, properties);
    }
}
