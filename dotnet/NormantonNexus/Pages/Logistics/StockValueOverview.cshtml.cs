using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>
/// Reports tile — port of the "Stock Value Overview" tile in private/logistics.html
/// (Node's own turnsValClassSummary function): GET /turns-valclass/aggregates'
/// full TurnsValClassAggregates shape (Totals + ByTurnoverCategory +
/// ByProfitCentre + ByMaterialType) — the latter two buckets were previously
/// fetched but never rendered anywhere in this app; this page is their first
/// real home, split out from Stock Turns &amp; Valuation to match Node's own
/// separate-tile grouping.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class StockValueOverviewModel : PageModel
{
    public void OnGet()
    {
    }
}
