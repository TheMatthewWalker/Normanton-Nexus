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

public enum ChangePasswordFailureReason
{
    IncorrectCurrentPassword,
    NewPasswordTooWeak,
    NewPasswordSameAsCurrent,
}

public abstract record ChangePasswordResult
{
    public sealed record Success : ChangePasswordResult;
    public sealed record Failure(ChangePasswordFailureReason Reason) : ChangePasswordResult;

    private ChangePasswordResult() { }
}

public enum OrderbookCredentialFailureReason
{
    InvalidCredentials,
    AccountUnavailable,
}

public abstract record OrderbookCredentialResult
{
    public sealed record Success(int UserId, string Username) : OrderbookCredentialResult;
    public sealed record Failure(OrderbookCredentialFailureReason Reason) : OrderbookCredentialResult;

    private OrderbookCredentialResult() { }
}

public enum ResetPasswordFailureReason { InvalidOrExpiredToken, NewPasswordTooWeak }

public abstract record ResetPasswordResult
{
    public sealed record Success : ResetPasswordResult;
    public sealed record Failure(ResetPasswordFailureReason Reason) : ResetPasswordResult;

    private ResetPasswordResult() { }
}

public interface IAuthService
{
    Task<LoginResult> LoginAsync(string username, string password, string? ipAddress, CancellationToken ct = default);

    /// <summary>Also clears PortalUsers.MustChangePassword — callers must re-issue the sign-in ticket afterward to drop the stale claim from the live session (see Pages/ChangePassword.cshtml.cs).</summary>
    Task<ChangePasswordResult> ChangePasswordAsync(int userId, string currentPassword, string newPassword, string? ipAddress, CancellationToken ct = default);

    /// <summary>
    /// Narrower credential check backing POST /api/auth/orderbook-token — deliberately
    /// separate from LoginAsync: unlike a full login, this never increments
    /// PortalUsers.FailedLogins/escalates a lockout on a bad password (matching Node's own
    /// orderbook-token route exactly, which has no counter-increment logic at all), and
    /// never resolves departments/permissions or issues a session ticket — just a yes/no
    /// over username+password plus the account being usable.
    /// </summary>
    Task<OrderbookCredentialResult> VerifyOrderbookCredentialsAsync(string username, string password, string? ipAddress, CancellationToken ct = default);

    /// <summary>
    /// Port of routes/auth.js's POST /forgot-password. Always completes the
    /// same way regardless of whether the email matched an account — the
    /// caller (AuthApiController) returns the same generic message either
    /// way, mitigating account enumeration exactly like Node's own
    /// early-return-on-zero-rows-affected still responding 200. resetLinkBaseUrl
    /// is the scheme+host to build the reset link against (e.g.
    /// "https://portal.example.com") — passed in rather than resolved here so
    /// this class doesn't need an HttpContext dependency, matching how
    /// ipAddress is already passed into every other method here.
    /// </summary>
    Task RequestPasswordResetAsync(string email, string resetLinkBaseUrl, CancellationToken ct = default);

    Task<ResetPasswordResult> ResetPasswordAsync(string token, string newPassword, string? ipAddress, CancellationToken ct = default);
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
    IAuditLogger auditLogger,
    NormantonNexus.Services.IResendClient resendClient) : IAuthService
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
        // record LastLogin, and resolve departments + effective permissions, all
        // concurrently. Each awaited task below must own its own connection — the
        // shared `connection` from the lookup above can only ever have one command
        // in flight at a time (confirmed for real against a live SQL Server: running
        // a second command on it concurrently throws "The connection does not
        // support MultipleActiveResultSets", since this app's connection strings
        // don't set MultipleActiveResultSets=True and nothing here actually needs
        // it — GetEffectivePermissionsAsync already opens its own connection for
        // exactly this reason, matching that same pattern here rather than turning
        // MARS on).
        var departmentsTask = QueryDepartmentsAsync(user.UserID, ct);
        var permissionsTask = permissionResolver.GetEffectivePermissionsAsync(user.UserID, ct);
        var resetTask = ResetLoginStateAsync(user.UserID, ct);

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

    private async Task<IEnumerable<string>> QueryDepartmentsAsync(int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QueryAsync<string>(new CommandDefinition(
            "SELECT Department FROM dbo.PortalUserDepartments WHERE UserID = @userId",
            new { userId }, cancellationToken: ct));
    }

    private async Task ResetLoginStateAsync(int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE dbo.PortalUsers SET FailedLogins = 0, IsLocked = 0, LastLogin = GETDATE() WHERE UserID = @userId",
            new { userId }, cancellationToken: ct));
    }

    /// <summary>
    /// Matches routes/profile.js's POST /change-password exactly: at least 10
    /// characters, one uppercase letter, one digit — the same rule
    /// UserAdminHelper.IsStrongEnoughPassword enforces for bulk-created
    /// accounts (routes/useradmin.js's POST /users/bulk-create uses the
    /// identical regex), kept as its own small copy here rather than a
    /// cross-feature reference, matching this migration's own established
    /// "each file owns its small validators" precedent (e.g.
    /// CustomsReportHelper's ReadCellText/BuildHeaderMap vs.
    /// OrderBookNotesUploadHelper's own copies).
    /// </summary>
    internal static bool IsStrongEnoughPassword(string password) =>
        password.Length >= 10 && password.Any(char.IsUpper) && password.Any(char.IsDigit);

    public async Task<ChangePasswordResult> ChangePasswordAsync(
        int userId, string currentPassword, string newPassword, string? ipAddress, CancellationToken ct = default)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var currentHash = await connection.QuerySingleAsync<string>(new CommandDefinition(
            "SELECT PasswordHash FROM dbo.PortalUsers WHERE UserID = @userId", new { userId }, cancellationToken: ct));

        if (!BCrypt.Net.BCrypt.Verify(currentPassword, currentHash))
        {
            await auditLogger.LogAsync("PASSWORD_CHANGE_FAIL", null, "Incorrect current password", ipAddress, ct);
            return new ChangePasswordResult.Failure(ChangePasswordFailureReason.IncorrectCurrentPassword);
        }

        if (!IsStrongEnoughPassword(newPassword))
        {
            return new ChangePasswordResult.Failure(ChangePasswordFailureReason.NewPasswordTooWeak);
        }

        // Matches Node's own `newPassword === currentPassword` check exactly — compared as
        // plaintext (both are the raw values off this same request), not via bcrypt, since
        // Node's own check is a plain string comparison too, not a re-verify against the hash.
        if (newPassword == currentPassword)
        {
            return new ChangePasswordResult.Failure(ChangePasswordFailureReason.NewPasswordSameAsCurrent);
        }

        var newHash = BCrypt.Net.BCrypt.HashPassword(newPassword, workFactor: 12);
        await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE dbo.PortalUsers SET PasswordHash = @newHash, MustChangePassword = 0 WHERE UserID = @userId",
            new { newHash, userId }, cancellationToken: ct));

        await auditLogger.LogAsync("PASSWORD_CHANGE_OK", null, null, ipAddress, ct);
        return new ChangePasswordResult.Success();
    }

    private sealed record OrderbookCredentialUserRow(int UserID, string Username, string PasswordHash, bool IsActive, bool IsLocked);

    public async Task<OrderbookCredentialResult> VerifyOrderbookCredentialsAsync(string username, string password, string? ipAddress, CancellationToken ct = default)
    {
        username = username.Trim();

        using var connection = await db.CreateConnectionAsync(ct);
        var user = await connection.QuerySingleOrDefaultAsync<OrderbookCredentialUserRow>(new CommandDefinition(
            "SELECT UserID, Username, PasswordHash, IsActive, IsLocked FROM dbo.PortalUsers WHERE Username = @username",
            new { username }, cancellationToken: ct));

        if (user is null)
        {
            BCrypt.Net.BCrypt.Verify(password, DummyHash);
            await auditLogger.LogAsync("ORDERBOOK_TOKEN_FAIL", username, "Unknown username", ipAddress, ct);
            return new OrderbookCredentialResult.Failure(OrderbookCredentialFailureReason.InvalidCredentials);
        }

        if (!user.IsActive || user.IsLocked)
        {
            await auditLogger.LogAsync("ORDERBOOK_TOKEN_FAIL", username, !user.IsActive ? "Account pending approval" : "Account locked", ipAddress, ct);
            return new OrderbookCredentialResult.Failure(OrderbookCredentialFailureReason.AccountUnavailable);
        }

        if (!BCrypt.Net.BCrypt.Verify(password, user.PasswordHash))
        {
            await auditLogger.LogAsync("ORDERBOOK_TOKEN_FAIL", username, "Bad password", ipAddress, ct);
            return new OrderbookCredentialResult.Failure(OrderbookCredentialFailureReason.InvalidCredentials);
        }

        await auditLogger.LogAsync("ORDERBOOK_TOKEN_OK", username, null, ipAddress, ct);
        return new OrderbookCredentialResult.Success(user.UserID, user.Username);
    }

    public async Task RequestPasswordResetAsync(string email, string resetLinkBaseUrl, CancellationToken ct = default)
    {
        var token = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var expiresAt = DateTime.UtcNow.AddDays(7); // matches Node's 604800000ms (1 week) window

        using var connection = await db.CreateConnectionAsync(ct);
        var rowsAffected = await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE dbo.PortalUsers SET reset_token = @token, reset_token_expires = @expiresAt WHERE Email = @email",
            new { token, expiresAt, email }, cancellationToken: ct));

        // No account matched — stop here without sending anything. The caller
        // (AuthApiController) returns the exact same "if the email exists..."
        // response either way, mitigating account enumeration, matching
        // Node's own early-return-on-zero-rows-affected behavior.
        if (rowsAffected == 0) return;

        var resetLink = $"{resetLinkBaseUrl.TrimEnd('/')}/ResetPassword?token={token}";

        // DEVIATION, deliberate bug fix, not a faithful port: Node's real
        // routes/auth.js hardcodes the recipient to a single developer
        // address (matthew.walker@ka-group.com) regardless of which email
        // was actually submitted — meaning nobody but that one address could
        // ever receive a real reset link, defeating the feature entirely for
        // every other user. Sent to the real requesting email here instead,
        // matching this migration's established "fix a confirmed real bug,
        // document it, don't reproduce it" precedent (see e.g. the Goods
        // Issue Items fix in Sub-phase 7c).
        await resendClient.SendEmailAsync(
            email,
            "Password Recovery Request - Normanton Nexus",
            $"<p>A password reset request was initiated for {System.Net.WebUtility.HtmlEncode(email)}. Click <a href=\"{resetLink}\">here</a> to select a new password.</p>",
            ct);
    }

    public async Task<ResetPasswordResult> ResetPasswordAsync(string token, string newPassword, string? ipAddress, CancellationToken ct = default)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var userId = await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition(
            "SELECT UserID FROM dbo.PortalUsers WHERE reset_token = @token AND reset_token_expires > GETUTCDATE()",
            new { token }, cancellationToken: ct));

        if (userId is null)
        {
            return new ResetPasswordResult.Failure(ResetPasswordFailureReason.InvalidOrExpiredToken);
        }

        // DEVIATION, deliberate: Node's reset-password route applies neither
        // the strength rule every other password-set path in this app
        // enforces, nor this app's own bcrypt cost-12 convention (it hashes
        // at cost 10) — both real, confirmed inconsistencies in Node's own
        // source against its own established rules elsewhere, closed here
        // rather than reproduced.
        if (!IsStrongEnoughPassword(newPassword))
        {
            return new ResetPasswordResult.Failure(ResetPasswordFailureReason.NewPasswordTooWeak);
        }

        var newHash = BCrypt.Net.BCrypt.HashPassword(newPassword, workFactor: 12);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE dbo.PortalUsers
            SET PasswordHash = @newHash, reset_token = NULL, reset_token_expires = NULL
            WHERE UserID = @userId
            """, new { newHash, userId }, cancellationToken: ct));

        await auditLogger.LogAsync("PASSWORD_RESET_OK", null, null, ipAddress, ct);
        return new ResetPasswordResult.Success();
    }
}
