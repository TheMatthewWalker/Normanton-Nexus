using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Finance;

/// <summary>
/// GL Account Groups tile — pure CRUD over acct.FinanceGlGroups/
/// FinanceGlGroupAccounts. View is department-gated only; writes
/// additionally require Perm:FIN_GL_GROUPS_MANAGE (a genuinely new gate —
/// Node has no permission check at all here, see the SeedFinancePermissions
/// migration). No client-side hide/show for the Add/Edit/Delete controls,
/// same simplification every earlier department phase made.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Finance)]
public class GlGroupsModel : PageModel
{
    public void OnGet()
    {
    }
}
