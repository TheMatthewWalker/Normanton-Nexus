using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Tests.Services.Auth;

public class AuthorizationHandlersTests
{
    private static ClaimsPrincipal PrincipalWith(string role, params Claim[] extraClaims)
    {
        var claims = new List<Claim> { new(ClaimTypes.Role, role) };
        claims.AddRange(extraClaims);
        return new ClaimsPrincipal(new ClaimsIdentity(claims, "TestAuth"));
    }

    private static async Task<bool> Evaluate(IAuthorizationRequirement requirement, IAuthorizationHandler handler, ClaimsPrincipal principal)
    {
        var context = new AuthorizationHandlerContext([requirement], principal, resource: null);
        await handler.HandleAsync(context);
        return context.HasSucceeded;
    }

    [Fact]
    public async Task MinimumRoleHandler_succeeds_when_role_meets_the_minimum()
    {
        var handler = new MinimumRoleHandler();
        var principal = PrincipalWith(NexusRoles.Admin);

        Assert.True(await Evaluate(new MinimumRoleRequirement(NexusRoles.Operator), handler, principal));
    }

    [Fact]
    public async Task MinimumRoleHandler_fails_when_role_is_below_the_minimum()
    {
        var handler = new MinimumRoleHandler();
        var principal = PrincipalWith(NexusRoles.Operator);

        Assert.False(await Evaluate(new MinimumRoleRequirement(NexusRoles.Admin), handler, principal));
    }

    [Fact]
    public async Task DepartmentHandler_succeeds_when_the_user_holds_the_department_claim()
    {
        var handler = new DepartmentHandler();
        var principal = PrincipalWith(NexusRoles.Operator, new Claim(NexusClaimTypes.Department, NexusDepartments.Warehouse));

        Assert.True(await Evaluate(new DepartmentRequirement(NexusDepartments.Warehouse), handler, principal));
    }

    [Fact]
    public async Task DepartmentHandler_fails_when_the_user_lacks_the_department_claim()
    {
        var handler = new DepartmentHandler();
        var principal = PrincipalWith(NexusRoles.Operator, new Claim(NexusClaimTypes.Department, NexusDepartments.Sales));

        Assert.False(await Evaluate(new DepartmentRequirement(NexusDepartments.Warehouse), handler, principal));
    }

    [Fact]
    public async Task DepartmentHandler_superadmin_bypasses_the_department_check()
    {
        var handler = new DepartmentHandler();
        var principal = PrincipalWith(NexusRoles.Superadmin);

        Assert.True(await Evaluate(new DepartmentRequirement(NexusDepartments.Warehouse), handler, principal));
    }

    [Fact]
    public async Task PermissionHandler_succeeds_when_the_user_holds_the_permission_claim()
    {
        var handler = new PermissionHandler();
        var principal = PrincipalWith(NexusRoles.Operator, new Claim(NexusClaimTypes.Permission, "WAREHOUSE_STOCK_ADJUST"));

        Assert.True(await Evaluate(new PermissionRequirement("WAREHOUSE_STOCK_ADJUST"), handler, principal));
    }

    [Fact]
    public async Task PermissionHandler_fails_when_the_user_lacks_the_permission_claim()
    {
        var handler = new PermissionHandler();
        var principal = PrincipalWith(NexusRoles.Operator);

        Assert.False(await Evaluate(new PermissionRequirement("WAREHOUSE_STOCK_ADJUST"), handler, principal));
    }

    [Fact]
    public async Task PermissionHandler_superadmin_bypasses_the_permission_check()
    {
        var handler = new PermissionHandler();
        var principal = PrincipalWith(NexusRoles.Superadmin);

        Assert.True(await Evaluate(new PermissionRequirement("WAREHOUSE_STOCK_ADJUST"), handler, principal));
    }

    [Fact]
    public async Task AnyDepartmentHandler_succeeds_when_the_user_holds_any_one_of_the_listed_departments()
    {
        var handler = new AnyDepartmentHandler();
        var principal = PrincipalWith(NexusRoles.Operator, new Claim(NexusClaimTypes.Department, NexusDepartments.Sales));

        Assert.True(await Evaluate(new AnyDepartmentRequirement([NexusDepartments.Production, NexusDepartments.Sales]), handler, principal));
    }

    [Fact]
    public async Task AnyDepartmentHandler_fails_when_the_user_holds_none_of_the_listed_departments()
    {
        var handler = new AnyDepartmentHandler();
        var principal = PrincipalWith(NexusRoles.Operator, new Claim(NexusClaimTypes.Department, NexusDepartments.Quality));

        Assert.False(await Evaluate(new AnyDepartmentRequirement([NexusDepartments.Production, NexusDepartments.Sales]), handler, principal));
    }

    [Fact]
    public async Task AnyDepartmentHandler_superadmin_bypasses_the_check()
    {
        var handler = new AnyDepartmentHandler();
        var principal = PrincipalWith(NexusRoles.Superadmin);

        Assert.True(await Evaluate(new AnyDepartmentRequirement([NexusDepartments.Production, NexusDepartments.Sales]), handler, principal));
    }

    [Fact]
    public async Task AnyPermissionHandler_succeeds_when_the_user_holds_any_one_of_the_listed_codes()
    {
        var handler = new AnyPermissionHandler();
        var principal = PrincipalWith(NexusRoles.Operator, new Claim(NexusClaimTypes.Permission, "SALES_SUPERVISOR"));

        Assert.True(await Evaluate(new AnyPermissionRequirement(["PROD_SUPERVISOR", "SALES_SUPERVISOR"]), handler, principal));
    }

    [Fact]
    public async Task AnyPermissionHandler_fails_when_the_user_holds_none_of_the_listed_codes()
    {
        var handler = new AnyPermissionHandler();
        var principal = PrincipalWith(NexusRoles.Operator);

        Assert.False(await Evaluate(new AnyPermissionRequirement(["PROD_SUPERVISOR", "SALES_SUPERVISOR"]), handler, principal));
    }
}
