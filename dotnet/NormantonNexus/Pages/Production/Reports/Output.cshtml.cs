using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production.Reports;

/// <summary>Production Output report — see ProductionReportsHelper.GetOutputAsync. Entirely PROD_SUPERVISOR-gated in Node (whole Reports section), so the page itself requires the permission too, not just the API.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
[Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
public class OutputModel : PageModel
{
    public void OnGet()
    {
    }
}
