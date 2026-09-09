using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>
/// Reports tile — port of the "Stock Value by Price" tile in
/// private/logistics.html (GET /turns-valclass/value-by-price), split out of
/// the old combined Stock Turns &amp; Valuation page to match Node's own
/// separate-tile grouping.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class StockValueByPriceModel : PageModel
{
    public void OnGet()
    {
    }
}
