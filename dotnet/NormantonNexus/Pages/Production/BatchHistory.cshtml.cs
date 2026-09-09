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
/// Gated by either PROD_BATCH_HISTORY or PROD_TRACEABILITY (any-of) — the
/// Traceability tile also searches history as its own first step and calls
/// this same GET /history route, so its holders need to keep reaching it too.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
[Authorize(Policy = "Perm:PROD_BATCH_HISTORY,PROD_TRACEABILITY")]
public class BatchHistoryModel : PageModel
{
    public void OnGet()
    {
    }
}
