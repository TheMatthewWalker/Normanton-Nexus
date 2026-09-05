using NormantonNexus.Services.Auth;

namespace NormantonNexus.Tests.Services.Auth;

public class NexusRolesTests
{
    [Theory]
    [InlineData(NexusRoles.Operator, NexusRoles.Operator, true)]
    [InlineData(NexusRoles.Admin, NexusRoles.Operator, true)]
    [InlineData(NexusRoles.Superadmin, NexusRoles.Operator, true)]
    [InlineData(NexusRoles.Superadmin, NexusRoles.Admin, true)]
    [InlineData(NexusRoles.Superadmin, NexusRoles.Superadmin, true)]
    [InlineData(NexusRoles.Operator, NexusRoles.Admin, false)]
    [InlineData(NexusRoles.Admin, NexusRoles.Superadmin, false)]
    public void Satisfies_reflects_the_operator_lt_admin_lt_superadmin_hierarchy(
        string actualRole, string minimumRole, bool expected)
    {
        Assert.Equal(expected, NexusRoles.Satisfies(actualRole, minimumRole));
    }

    [Fact]
    public void Satisfies_treats_an_unrecognized_role_as_below_every_minimum()
    {
        Assert.False(NexusRoles.Satisfies("not-a-real-role", NexusRoles.Operator));
    }

    [Fact]
    public void Satisfies_treats_a_null_role_as_below_every_minimum()
    {
        Assert.False(NexusRoles.Satisfies(null, NexusRoles.Operator));
    }

    [Fact]
    public void Satisfies_is_case_insensitive_matching_the_CHECK_constraint_values()
    {
        Assert.True(NexusRoles.Satisfies("SUPERADMIN", NexusRoles.Admin));
    }
}
