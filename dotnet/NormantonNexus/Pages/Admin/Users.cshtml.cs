using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Admin;

/// <summary>Pending approvals, full user list with inline edit, bulk create/departments/status/permissions, and per-user permission grant/revoke. Port of routes/useradmin.js's UI half — routes/useradmin.js's requireRole('admin') at file level is this page's own gate; bulk-create is superadmin-only (enforced server-side by the controller, this page just hides the form for a plain admin).</summary>
[Authorize(Policy = "Role:" + NexusRoles.Admin)]
public class UsersModel : PageModel
{
    public bool IsSuperadmin { get; private set; }

    public void OnGet()
    {
        IsSuperadmin = User.IsInRole(NexusRoles.Superadmin);
    }
}
