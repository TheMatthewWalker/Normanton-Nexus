using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Admin;

/// <summary>One group's detail/manage view — permission-checkbox grid + bulk-assign-to-users, driven by wwwroot/js/admin/permission-group-detail.js against UserAdminController's "Permission groups" JSON API.</summary>
[Authorize(Policy = "Role:admin")]
public class PermissionGroupDetailModel : PageModel
{
    public int GroupId { get; private set; }

    public void OnGet(int groupId)
    {
        GroupId = groupId;
    }
}
