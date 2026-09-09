namespace NormantonNexus.Services.Auth;

/// <summary>Custom claim types written into the auth ticket at login (Services/Auth/AuthService.cs).</summary>
public static class NexusClaimTypes
{
    /// <summary>One claim per department the user belongs to (PortalUserDepartments).</summary>
    public const string Department = "nnx:dept";

    /// <summary>
    /// One claim per EFFECTIVE tile permission code — the union of PortalUserPermissions
    /// (direct grants) and every PortalPermissionGroupPermissions row for a group the user
    /// is in (PortalUserPermissionGroups), computed once at login by PermissionResolver.
    /// See the migration plan's "Authorization model" section.
    /// </summary>
    public const string Permission = "nnx:perm";

    /// <summary>Present (value "1") when PortalUsers.ShortIdleTimeout is set — see IdleTimeoutPolicy.</summary>
    public const string ShortIdleTimeout = "nnx:short_idle";

    /// <summary>Present (value "1") when PortalUsers.MustChangePassword is set.</summary>
    public const string MustChangePassword = "nnx:must_change_password";
}

/// <summary>
/// The three fixed role values (PortalUsers.Role, CHECK-constrained) and their hierarchy —
/// operator &lt; admin &lt; superadmin, superadmin always bypasses department/permission gates.
/// Mirrors middleware/auth.js's ROLE_LEVEL exactly.
/// </summary>
public static class NexusRoles
{
    public const string Operator = "operator";
    public const string Admin = "admin";
    public const string Superadmin = "superadmin";

    private static readonly Dictionary<string, int> Level = new(StringComparer.OrdinalIgnoreCase)
    {
        [Operator] = 1,
        [Admin] = 2,
        [Superadmin] = 3,
    };

    public static int LevelOf(string? role) => role is not null && Level.TryGetValue(role, out var lvl) ? lvl : 0;

    public static bool Satisfies(string? actualRole, string minimumRole) =>
        LevelOf(actualRole) >= LevelOf(minimumRole);
}

/// <summary>
/// The 8 fixed department values (PortalUserDepartments.Department, CHECK-constrained).
/// </summary>
public static class NexusDepartments
{
    public const string Management = "management";
    public const string Engineering = "engineering";
    public const string Quality = "quality";
    public const string Sales = "sales";
    public const string Finance = "finance";
    public const string Warehouse = "warehouse";
    public const string Logistics = "logistics";
    public const string Production = "production";
}
