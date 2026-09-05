using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>
/// Traceability tile — port of runTraceability in production-nexus.js.
/// Node's HTML places this tile in the PROD_SUPERVISOR-gated Supervisor
/// section but its GET /trace/:pc/:id route never checked the permission
/// server-side — closed here (see ProductionNexusController's own comment).
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
[Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
public class TraceabilityModel : PageModel
{
    public void OnGet()
    {
    }
}
