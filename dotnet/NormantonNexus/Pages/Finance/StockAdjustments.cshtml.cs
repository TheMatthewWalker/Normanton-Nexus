using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Finance;

/// <summary>
/// Stock Adjustments tile — Finance's approval console over the shared
/// Stock Count feature (see StockCountController/Helper). Node hid this
/// tile client-side unless the user held FIN_STOCK_APPROVE; this port
/// always shows the page/link (no client-side permission-based hide/show,
/// same simplification every earlier department made) — a user lacking
/// the permission gets a 403 from the API on approve/reject/report, same
/// real gate either way.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Finance)]
public class StockAdjustmentsModel : PageModel
{
    public void OnGet()
    {
    }
}
