using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production.Reports;

/// <summary>SAP Performance report — see ProductionReportsHelper.GetSapPerformanceAsync.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
[Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
public class SapPerformanceModel : PageModel
{
    public void OnGet()
    {
    }
}
