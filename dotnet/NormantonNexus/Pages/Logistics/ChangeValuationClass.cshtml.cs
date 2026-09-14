using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>
/// Change Valuation Class — search materials, pick a new valuation class per
/// row, and submit a real SAP write (POST turns-valclass/change-valuation-class:
/// moves stock to an order, runs MM02, moves stock back). A genuinely missing
/// tile found by a later gap audit against the Node tile inventory, not a
/// deliberate deferral — see PerformanceController.ChangeValuationClass's own
/// comment and ChangeValuationClassResponse's header comment in
/// PerformanceModels.cs (unverified against a live SapServer).
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
[Authorize(Policy = "Perm:LOG_MRP")]
public class ChangeValuationClassModel : PageModel
{
    public void OnGet()
    {
    }
}
