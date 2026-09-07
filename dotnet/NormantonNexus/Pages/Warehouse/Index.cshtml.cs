using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Warehouse;

/// <summary>
/// Warehouse landing page — port of private/warehouse.html's tile grid.
/// "SOON" tiles in Node (Bin Contents, Stock Overview, Goods Receipts,
/// Closed Picksheets) have no backend in Node either — omitted here, same
/// "Coming soon" precedent Finance's own Index page set. Batch cleanup
/// (an advanced LOG_SUPER-only admin tool layered on top of TR Cleanup
/// Candidates) and Inbound/Outbound Deliveries ops are flagged remaining
/// gaps, not built in this pass — see dotnet/CLAUDE.md's Phase 10 notes.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Warehouse)]
public class IndexModel : PageModel
{
    public void OnGet()
    {
    }
}
