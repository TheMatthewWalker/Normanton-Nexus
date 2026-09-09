using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Admin;

/// <summary>The PortalPermissions code registry — list (any admin) + create/edit/delete (superadmin only, enforced server-side by UserAdminController).</summary>
[Authorize(Policy = "Role:" + NexusRoles.Admin)]
public class PermissionDefinitionsModel : PageModel
{
    public bool IsSuperadmin { get; private set; }

    public void OnGet()
    {
        IsSuperadmin = User.IsInRole(NexusRoles.Superadmin);
    }
}
