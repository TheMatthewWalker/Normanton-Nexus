using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>
/// MRP System tile — view-only (order suggestions grouped by vendor +
/// tracked orders). The accept/create-PO/assign-schedule-agreement write
/// workflow is real, unbuilt scope in this pass — genuinely complex
/// (elevated SAP-credential PO creation, batch accept, manual overrides)
/// and out of proportion with this catch-up's remaining time budget.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
[Authorize(Policy = "Perm:LOG_MRP")]
public class OrderSuggestionsModel : PageModel
{
    public void OnGet()
    {
    }
}
