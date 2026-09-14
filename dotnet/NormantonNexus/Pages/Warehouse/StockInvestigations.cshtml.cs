using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Warehouse;

/// <summary>
/// Entirely a supervisor tool (Batch Discrepancies scans/moves stock across
/// many batches automatically; the Stock in Investigation card writes off
/// real SAP stock) — gated Perm:LOG_SUPER at the page level, not just per
/// write action, matching the same "the whole page is supervisor-only, not
/// just specific actions within an otherwise-open page" precedent Production's
/// Batch History/Traceability pages already established (dotnet/CLAUDE.md's
/// Phase 6a notes) — avoids a non-supervisor landing on a page that 403s
/// immediately on every load.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Warehouse)]
[Authorize(Policy = "Perm:LOG_SUPER")]
public class StockInvestigationsModel : PageModel
{
    public void OnGet()
    {
    }
}
