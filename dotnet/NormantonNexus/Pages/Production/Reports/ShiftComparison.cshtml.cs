using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production.Reports;

/// <summary>Shift Performance report — see ProductionReportsHelper.GetShiftComparisonAsync.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
[Authorize(Policy = "Perm:" + ProductionReportsHelper.FnReportsView)]
public class ShiftComparisonModel : PageModel
{
    public void OnGet()
    {
    }
}
