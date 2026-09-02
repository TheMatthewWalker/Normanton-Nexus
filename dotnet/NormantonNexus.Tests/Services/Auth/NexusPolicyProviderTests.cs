using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Options;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Tests.Services.Auth;

public class NexusPolicyProviderTests
{
    private static NexusPolicyProvider CreateProvider() => new(Options.Create(new AuthorizationOptions()));

    [Fact]
    public async Task GetPolicyAsync_Role_prefix_builds_a_MinimumRoleRequirement()
    {
        var provider = CreateProvider();

        var policy = await provider.GetPolicyAsync("Role:admin");

        var requirement = Assert.Single(policy!.Requirements);
        var roleRequirement = Assert.IsType<MinimumRoleRequirement>(requirement);
        Assert.Equal("admin", roleRequirement.MinimumRole);
    }

    [Fact]
    public async Task GetPolicyAsync_Dept_prefix_builds_a_DepartmentRequirement()
    {
        var provider = CreateProvider();

        var policy = await provider.GetPolicyAsync("Dept:warehouse");

        var requirement = Assert.Single(policy!.Requirements);
        var deptRequirement = Assert.IsType<DepartmentRequirement>(requirement);
        Assert.Equal("warehouse", deptRequirement.Department);
    }

    [Fact]
    public async Task GetPolicyAsync_Perm_prefix_builds_a_PermissionRequirement()
    {
        var provider = CreateProvider();

        var policy = await provider.GetPolicyAsync("Perm:WAREHOUSE_STOCK_ADJUST");

        var requirement = Assert.Single(policy!.Requirements);
        var permRequirement = Assert.IsType<PermissionRequirement>(requirement);
        Assert.Equal("WAREHOUSE_STOCK_ADJUST", permRequirement.PermissionCode);
    }

    [Fact]
    public async Task GetPolicyAsync_unrecognized_name_falls_back_to_the_default_provider()
    {
        var provider = CreateProvider();

        var policy = await provider.GetPolicyAsync("SomeOtherPolicy");

        Assert.Null(policy);
    }
}
