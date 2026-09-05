using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Finance;

/// <summary>
/// Actual Costs tile — port of finance.js's showActualCostsForm()/
/// runActualCosts()/renderAcResults(). The client-side period-net/
/// cumulative-balance recalculation (deliberately ignoring SAP's own
/// year-to-date `balance` field) is ported verbatim — that's real business
/// logic, not visual polish.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Finance)]
public class ActualCostsModel : PageModel
{
    public void OnGet()
    {
    }
}
