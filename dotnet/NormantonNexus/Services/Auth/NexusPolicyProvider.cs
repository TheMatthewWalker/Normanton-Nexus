using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Options;

namespace NormantonNexus.Services.Auth;

/// <summary>
/// Lets controllers write [Authorize(Policy = "Role:admin")] / "Dept:warehouse" /
/// "Perm:WAREHOUSE_STOCK_ADJUST")] without pre-registering every one of the
/// (eventually hundreds of) per-tile permission codes as a named policy at
/// startup — the policy is built on first use and cached by the framework's
/// own AuthorizationPolicyCache. One code constant per tile still lives
/// alongside that tile's Controller action (see the migration plan); this
/// class just turns "Perm:&lt;code&gt;" into the matching PermissionRequirement.
/// </summary>
public sealed class NexusPolicyProvider(IOptions<AuthorizationOptions> options) : IAuthorizationPolicyProvider
{
    private readonly DefaultAuthorizationPolicyProvider _fallback = new(options);

    public const string RolePrefix = "Role:";
    public const string DepartmentPrefix = "Dept:";
    public const string PermissionPrefix = "Perm:";

    public Task<AuthorizationPolicy> GetDefaultPolicyAsync() => _fallback.GetDefaultPolicyAsync();

    public Task<AuthorizationPolicy?> GetFallbackPolicyAsync() => _fallback.GetFallbackPolicyAsync();

    public Task<AuthorizationPolicy?> GetPolicyAsync(string policyName)
    {
        AuthorizationPolicy? policy = policyName switch
        {
            _ when policyName.StartsWith(RolePrefix, StringComparison.Ordinal) =>
                new AuthorizationPolicyBuilder()
                    .AddRequirements(new MinimumRoleRequirement(policyName[RolePrefix.Length..]))
                    .Build(),

            // A comma means "any of" (Node's requireAnyDepartment/requireAnyPermission)
            // — e.g. "Dept:production,sales" for Production Schedule, shared
            // between two departments. Single-code case (the common one)
            // keeps using the plain DepartmentRequirement/PermissionRequirement.
            _ when policyName.StartsWith(DepartmentPrefix, StringComparison.Ordinal) =>
                BuildDepartmentPolicy(policyName[DepartmentPrefix.Length..]),

            _ when policyName.StartsWith(PermissionPrefix, StringComparison.Ordinal) =>
                BuildPermissionPolicy(policyName[PermissionPrefix.Length..]),

            _ => null,
        };

        return policy is not null ? Task.FromResult<AuthorizationPolicy?>(policy) : _fallback.GetPolicyAsync(policyName);
    }

    private static AuthorizationPolicy BuildDepartmentPolicy(string codes)
    {
        var parts = codes.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var requirement = parts.Length > 1
            ? (IAuthorizationRequirement)new AnyDepartmentRequirement(parts)
            : new DepartmentRequirement(codes);
        return new AuthorizationPolicyBuilder().AddRequirements(requirement).Build();
    }

    private static AuthorizationPolicy BuildPermissionPolicy(string codes)
    {
        var parts = codes.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var requirement = parts.Length > 1
            ? (IAuthorizationRequirement)new AnyPermissionRequirement(parts)
            : new PermissionRequirement(codes);
        return new AuthorizationPolicyBuilder().AddRequirements(requirement).Build();
    }
}
