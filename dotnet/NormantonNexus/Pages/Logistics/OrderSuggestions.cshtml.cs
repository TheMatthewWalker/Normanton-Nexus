using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>
/// MRP System tile — order suggestions grouped by vendor (with Accept /
/// Accept via schedule agreement) + tracked orders (inline edit/save/delete,
/// multi-select, Assign Shipment, Create Shipment, Create PO / Assign
/// Schedule Agreement). Still not built: the Build Order modal for vendors
/// with a combined order MOQ, manual order entry (single + bulk CSV), and
/// the full Inbound Shipment detail view (manual items, invoice upload,
/// Mark Received / Undo Received, PO PDF resend) — see the page's own
/// on-screen note.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
[Authorize(Policy = "Perm:LOG_MRP")]
public class OrderSuggestionsModel : PageModel
{
    /// <summary>Optional deep-link from Stock History &amp; Forecast's "View in MRP" link — pre-fills the Tracked Orders search box to this material on load.</summary>
    [BindProperty(SupportsGet = true)]
    public string? Material { get; set; }

    public void OnGet()
    {
    }
}
