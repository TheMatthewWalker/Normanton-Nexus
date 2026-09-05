using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Sales;

/// <summary>
/// Schedule Agreement Waterfall tile — its own page + dedicated JS
/// (wwwroot/js/sales/schedule-waterfall.js), replacing sales.js's
/// window.SalesWaterfallReport.mount() innerHTML-injection. View-only,
/// department-gated only (no write action on this tile) — see
/// SalesController.ScheduleWaterfall, which proxies straight to
/// SapServer's own SalesController.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Sales)]
public class ScheduleWaterfallModel : PageModel
{
    public void OnGet()
    {
    }
}
