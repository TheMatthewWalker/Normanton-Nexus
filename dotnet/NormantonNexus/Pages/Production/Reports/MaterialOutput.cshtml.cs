using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production.Reports;

/// <summary>Material Throughput report — see ProductionReportsHelper.GetMaterialOutputAsync.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
[Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
public class MaterialOutputModel : PageModel
{
    public void OnGet()
    {
    }
}
