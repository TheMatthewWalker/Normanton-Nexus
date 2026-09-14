using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>
/// Expired Mix Batches — the supervisor queue for unstaged mix tubs past
/// the 96h expiry window: approve scrapping the tub for real (a genuine
/// SAP scrap movement) or override the expiry and stage it anyway. A real,
/// working Node tile with no prior C# port anywhere in this migration —
/// found by a later gap audit against the Node tile inventory, not a
/// deliberate deferral. See BilletStagingHelper.GetExpiredAsync/
/// ScrapExpiredTubAsync/OverrideExpiryAsync.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
[Authorize(Policy = "Perm:PROD_SUPERVISOR")]
public class ExpiredMixBatchesModel : PageModel
{
    public void OnGet()
    {
    }
}
