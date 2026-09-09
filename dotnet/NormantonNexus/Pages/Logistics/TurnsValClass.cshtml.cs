using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>
/// Stock Turns &amp; Valuation tile — the real, full filterable per-material
/// list (GET /turns-valclass, matching Node's own tile description exactly:
/// "stock, valuation class, turns and days-in-stock, filterable"). Stock
/// Value Overview (aggregates) and Stock Value by Price now live on their
/// own separate tiles/pages, matching Node's own tile grouping — see
/// StockValueOverview.cshtml/StockValueByPrice.cshtml.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class TurnsValClassModel : PageModel
{
    public void OnGet()
    {
    }
}
