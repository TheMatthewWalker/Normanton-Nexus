using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>
/// Batch History tile — port of runBatchHistory in production-nexus.js.
/// Node's HTML places this tile in the PROD_SUPERVISOR-gated Supervisor
/// section but its GET /history route never checked the permission
/// server-side — closed here (see ProductionNexusController's own comment).
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
[Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
public class BatchHistoryModel : PageModel
{
    public void OnGet()
    {
    }
}
