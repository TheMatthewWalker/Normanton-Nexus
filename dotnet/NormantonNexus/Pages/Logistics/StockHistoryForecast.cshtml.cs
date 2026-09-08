using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>
/// C# port of private/js/logistics.js's runStockHistoryForecast/shfLoadChart/
/// shfOnVendorChange family — 13-month consumption history vs. SAP demand forecast
/// vs. our own predicted usage, plus a weekly (or, single-material, optionally
/// daily) expected-stock projection, with a vendor-filter grid (one chart-pair row
/// per material a vendor supplies). Backed by PerformanceController.GetTurnsValClassHistory
/// (Sub-phase 8b.1's one genuinely deferred route, built once ForecastMathHelper/
/// order-suggestion/demand-adjustment all existed). Cross-links both ways with the
/// MRP System tile (?material= query param on each side) and with Demand Adjustments
/// ("+ Add Demand Adjustment").
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
[Authorize(Policy = "Perm:LOG_MRP")]
public class StockHistoryForecastModel : PageModel
{
    [BindProperty(SupportsGet = true)]
    public string? Material { get; set; }

    [BindProperty(SupportsGet = true)]
    public string? MaterialText { get; set; }

    public void OnGet()
    {
    }
}
