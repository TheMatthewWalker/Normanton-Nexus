using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Quality;

/// <summary>
/// Display Stock tile — port of quality.js's displayStock()/renderStockTable().
/// View is department-gated only (no permission code, matches Node's current
/// live behavior — see QualityHelper.DisplayStockAsync). Per-row/bulk
/// block/unblock actions are gated at the API layer
/// (Perm:QUAL_BLOCK_STOCK/QUAL_UNBLOCK_STOCK); this page doesn't hide the
/// buttons for a user lacking them — matches Node showing the same context
/// menu regardless of QUAL_BLOCKING and letting the server 403 (Node's own
/// showCtxMenu() DOES hide the menu client-side, a UX nicety this page
/// simplifies away rather than duplicates — the API 403 is the real gate
/// either way).
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Quality)]
public class StockModel : PageModel
{
    public void OnGet()
    {
    }
}
