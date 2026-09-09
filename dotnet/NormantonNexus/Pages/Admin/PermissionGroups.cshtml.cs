using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Admin;

/// <summary>List + create for Permission Groups — see UserAdminController's "Permission groups" section for the real JSON API this now drives against (wwwroot/js/admin/permission-groups.js), replacing the earlier one-row-at-a-time Razor Page handlers.</summary>
[Authorize(Policy = "Role:admin")]
public class PermissionGroupsModel : PageModel
{
    public void OnGet()
    {
    }
}
