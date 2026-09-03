using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>Scrap Reversal — missed-reversal alerts (scrap posted against a job whose backflush was later reversed) plus a flexible search/bulk-reverse action. Port of runScrapReversal in production-nexus.js.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
[Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
public class ScrapReversalModel : PageModel
{
    public void OnGet()
    {
    }
}
