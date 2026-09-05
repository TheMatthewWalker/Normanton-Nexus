using NormantonNexus.Helpers.Admin;

namespace NormantonNexus.Tests.Helpers.Admin;

public class UserAdminHelperTests
{
    // ── IsValidRole ────────────────────────────────────────────────────

    [Theory]
    [InlineData("operator", true)]
    [InlineData("admin", true)]
    [InlineData("superadmin", true)]
    [InlineData("Operator", false)] // case-sensitive, matching Node's exact-string VALID_ROLES.includes check
    [InlineData("root", false)]
    [InlineData(null, false)]
    [InlineData("", false)]
    public void IsValidRole_matches_only_the_three_exact_role_strings(string? role, bool expected)
    {
        Assert.Equal(expected, UserAdminHelper.IsValidRole(role));
    }

    // ── IsValidDepartment / AreValidDepartments ─────────────────────────

    [Theory]
    [InlineData("production", true)]
    [InlineData("logistics", true)]
    [InlineData("warehouse", true)]
    [InlineData("finance", true)]
    [InlineData("sales", true)]
    [InlineData("quality", true)]
    [InlineData("engineering", true)]
    [InlineData("management", true)]
    [InlineData("shipping", false)]
    [InlineData(null, false)]
    public void IsValidDepartment_matches_only_the_eight_valid_departments(string? department, bool expected)
    {
        Assert.Equal(expected, UserAdminHelper.IsValidDepartment(department));
    }

    [Fact]
    public void AreValidDepartments_returns_true_for_a_null_list_matching_no_departments_field_supplied()
    {
        Assert.True(UserAdminHelper.AreValidDepartments(null));
    }

    [Fact]
    public void AreValidDepartments_returns_true_for_an_empty_list()
    {
        Assert.True(UserAdminHelper.AreValidDepartments([]));
    }

    [Fact]
    public void AreValidDepartments_returns_false_if_any_entry_is_invalid()
    {
        Assert.False(UserAdminHelper.AreValidDepartments(["production", "not-a-department"]));
    }

    // ── IsValidUsername / IsValidEmail / IsValidPermissionCode ──────────

    [Theory]
    [InlineData("j.smith", true)]
    [InlineData("j_smith-01", true)]
    [InlineData("J.Smith", false)] // uppercase not allowed
    [InlineData("", false)]
    [InlineData(null, false)]
    [InlineData("has space", false)]
    public void IsValidUsername_matches_Nodes_lowercase_dot_hyphen_underscore_pattern(string? username, bool expected)
    {
        Assert.Equal(expected, UserAdminHelper.IsValidUsername(username));
    }

    [Theory]
    [InlineData("a@b.com", true)]
    [InlineData("first.last@example.co.uk", true)]
    [InlineData("not-an-email", false)]
    [InlineData("@b.com", false)]
    [InlineData(null, false)]
    public void IsValidEmail_matches_a_basic_email_shape(string? email, bool expected)
    {
        Assert.Equal(expected, UserAdminHelper.IsValidEmail(email));
    }

    [Theory]
    [InlineData("LOG_ADMIN", true)]
    [InlineData("A1", true)]
    [InlineData("a", false)] // lowercase not allowed
    [InlineData("X", false)] // too short (min 2)
    [InlineData(null, false)]
    public void IsValidPermissionCode_matches_2to50_uppercase_digits_underscore(string? code, bool expected)
    {
        Assert.Equal(expected, UserAdminHelper.IsValidPermissionCode(code));
    }

    // ── IsStrongEnoughPassword ───────────────────────────────────────────

    [Fact]
    public void IsStrongEnoughPassword_accepts_10_chars_with_an_uppercase_letter_and_a_digit()
    {
        Assert.True(UserAdminHelper.IsStrongEnoughPassword("Abcdefghi1"));
    }

    [Fact]
    public void IsStrongEnoughPassword_rejects_a_password_shorter_than_10_chars()
    {
        Assert.False(UserAdminHelper.IsStrongEnoughPassword("Abcdefgh1"));
    }

    [Fact]
    public void IsStrongEnoughPassword_rejects_a_password_with_no_uppercase_letter()
    {
        Assert.False(UserAdminHelper.IsStrongEnoughPassword("abcdefghij1"));
    }

    [Fact]
    public void IsStrongEnoughPassword_rejects_a_password_with_no_digit()
    {
        Assert.False(UserAdminHelper.IsStrongEnoughPassword("Abcdefghij"));
    }

    [Fact]
    public void IsStrongEnoughPassword_rejects_null()
    {
        Assert.False(UserAdminHelper.IsStrongEnoughPassword(null));
    }

    // ── ActorCanEditTargetRole / ActorCanAssignRole ─────────────────────

    [Fact]
    public void ActorCanEditTargetRole_a_superadmin_can_edit_anyone()
    {
        Assert.True(UserAdminHelper.ActorCanEditTargetRole("superadmin", "superadmin"));
    }

    [Fact]
    public void ActorCanEditTargetRole_an_admin_can_edit_an_operator()
    {
        Assert.True(UserAdminHelper.ActorCanEditTargetRole("admin", "operator"));
    }

    [Fact]
    public void ActorCanEditTargetRole_an_admin_cannot_edit_another_admin()
    {
        Assert.False(UserAdminHelper.ActorCanEditTargetRole("admin", "admin"));
    }

    [Fact]
    public void ActorCanEditTargetRole_an_admin_cannot_edit_a_superadmin()
    {
        Assert.False(UserAdminHelper.ActorCanEditTargetRole("admin", "superadmin"));
    }

    [Fact]
    public void ActorCanAssignRole_a_superadmin_can_assign_any_role()
    {
        Assert.True(UserAdminHelper.ActorCanAssignRole("superadmin", "superadmin"));
    }

    [Fact]
    public void ActorCanAssignRole_an_admin_can_assign_operator()
    {
        Assert.True(UserAdminHelper.ActorCanAssignRole("admin", "operator"));
    }

    [Fact]
    public void ActorCanAssignRole_an_admin_cannot_assign_admin_or_higher()
    {
        Assert.False(UserAdminHelper.ActorCanAssignRole("admin", "admin"));
        Assert.False(UserAdminHelper.ActorCanAssignRole("admin", "superadmin"));
    }

    // ── IsValidAuditEvent ────────────────────────────────────────────────

    [Fact]
    public void IsValidAuditEvent_returns_true_for_a_null_filter_matching_no_filter_supplied()
    {
        Assert.True(UserAdminHelper.IsValidAuditEvent(null));
    }

    [Theory]
    [InlineData("LOGIN_OK", true)]
    [InlineData("PERM_BULK_GRANT", true)]
    [InlineData("NOT_A_REAL_EVENT", false)]
    public void IsValidAuditEvent_matches_only_the_known_event_types(string evt, bool expected)
    {
        Assert.Equal(expected, UserAdminHelper.IsValidAuditEvent(evt));
    }
}
