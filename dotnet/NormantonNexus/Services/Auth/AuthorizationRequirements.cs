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
