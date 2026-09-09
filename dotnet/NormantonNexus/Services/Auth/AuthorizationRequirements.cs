using Microsoft.AspNetCore.Authorization;

namespace NormantonNexus.Services.Auth;

// Three independent gates, exactly matching middleware/auth.js's requireRole/
// requireDepartment/requirePermission — a route uses exactly one of these
// (or none), never combines them. Superadmin bypasses all three, same as Node.
// See the migration plan's "Authorization model" section.

public sealed class MinimumRoleRequirement(string minimumRole) : IAuthorizationRequirement
{
    public string MinimumRole { get; } = minimumRole;
}

public sealed class DepartmentRequirement(string department) : IAuthorizationRequirement
{
    public string Department { get; } = department;
}

public sealed class PermissionRequirement(string permissionCode) : IAuthorizationRequirement
{
    public string PermissionCode { get; } = permissionCode;
}

/// <summary>
/// The "requireAnyDepartment"/"requireAnyPermission" shape — matches ANY one
/// of several codes, not all. Genuinely needed (not just a legacy-code
/// artifact) where Node deliberately shares one view across departments —
/// e.g. Production Schedule, viewable by department "production" OR
/// "sales". Kept as separate types from DepartmentRequirement/
/// PermissionRequirement rather than refactoring those to always hold an
/// array, since the single-code case is by far the common one.
/// </summary>
public sealed class AnyDepartmentRequirement(IReadOnlyCollection<string> departments) : IAuthorizationRequirement
{
    public IReadOnlyCollection<string> Departments { get; } = departments;
}

public sealed class AnyPermissionRequirement(IReadOnlyCollection<string> permissionCodes) : IAuthorizationRequirement
{
    public IReadOnlyCollection<string> PermissionCodes { get; } = permissionCodes;
}

public sealed class MinimumRoleHandler : AuthorizationHandler<MinimumRoleRequirement>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context, MinimumRoleRequirement requirement)
    {
        var role = context.User.FindFirst(System.Security.Claims.ClaimTypes.Role)?.Value;
        if (NexusRoles.Satisfies(role, requirement.MinimumRole))
        {
            context.Succeed(requirement);
        }
        return Task.CompletedTask;
    }
}

public sealed class DepartmentHandler : AuthorizationHandler<DepartmentRequirement>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context, DepartmentRequirement requirement)
    {
        var role = context.User.FindFirst(System.Security.Claims.ClaimTypes.Role)?.Value;
        if (role == NexusRoles.Superadmin)
        {
            context.Succeed(requirement);
            return Task.CompletedTask;
        }

        var hasDepartment = context.User.Claims.Any(c =>
            c.Type == NexusClaimTypes.Department &&
            string.Equals(c.Value, requirement.Department, StringComparison.OrdinalIgnoreCase));

        if (hasDepartment)
        {
            context.Succeed(requirement);
        }
        return Task.CompletedTask;
    }
}

public sealed class PermissionHandler : AuthorizationHandler<PermissionRequirement>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context, PermissionRequirement requirement)
    {
        var role = context.User.FindFirst(System.Security.Claims.ClaimTypes.Role)?.Value;
        if (role == NexusRoles.Superadmin)
        {
            context.Succeed(requirement);
            return Task.CompletedTask;
        }

        var hasPermission = context.User.Claims.Any(c =>
            c.Type == NexusClaimTypes.Permission &&
            string.Equals(c.Value, requirement.PermissionCode, StringComparison.OrdinalIgnoreCase));

        if (hasPermission)
        {
            context.Succeed(requirement);
        }
        return Task.CompletedTask;
    }
}

public sealed class AnyDepartmentHandler : AuthorizationHandler<AnyDepartmentRequirement>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context, AnyDepartmentRequirement requirement)
    {
        var role = context.User.FindFirst(System.Security.Claims.ClaimTypes.Role)?.Value;
        if (role == NexusRoles.Superadmin)
        {
            context.Succeed(requirement);
            return Task.CompletedTask;
        }

        var userDepartments = context.User.Claims
            .Where(c => c.Type == NexusClaimTypes.Department)
            .Select(c => c.Value);

        if (userDepartments.Any(d => requirement.Departments.Contains(d, StringComparer.OrdinalIgnoreCase)))
        {
            context.Succeed(requirement);
        }
        return Task.CompletedTask;
    }
}

public sealed class AnyPermissionHandler : AuthorizationHandler<AnyPermissionRequirement>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context, AnyPermissionRequirement requirement)
    {
        var role = context.User.FindFirst(System.Security.Claims.ClaimTypes.Role)?.Value;
        if (role == NexusRoles.Superadmin)
        {
            context.Succeed(requirement);
            return Task.CompletedTask;
        }

        var userPermissions = context.User.Claims
            .Where(c => c.Type == NexusClaimTypes.Permission)
            .Select(c => c.Value);

        if (userPermissions.Any(p => requirement.PermissionCodes.Contains(p, StringComparer.OrdinalIgnoreCase)))
        {
            context.Succeed(requirement);
        }
        return Task.CompletedTask;
    }
}
