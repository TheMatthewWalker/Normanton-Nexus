using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Admin;

/// <summary>SSMS-lite schema browser — superadmin-only, matching DbExplorerController's own Role:superadmin gate exactly (stricter than the api/admin mount's blanket Role:admin).</summary>
[Authorize(Policy = "Role:" + NexusRoles.Superadmin)]
public class DbExplorerModel : PageModel
{
    public void OnGet()
    {
    }
}
