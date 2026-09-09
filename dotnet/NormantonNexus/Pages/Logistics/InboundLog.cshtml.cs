using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>
/// Inbound Log — port of private/js/logistics.js's renderInboundLog/openInboundShipmentDetail
/// family. Lists log.PurchaseOrderShipment records (from Tracked Orders' bulk selection, or
/// created manually via a modal with searchable Origin/mode-filtered Haulier), bucketed
/// Late/Today/Upcoming/Completed/Cancelled. Row click opens a modal detail view covering
/// header edit, per-line Qty Received (unit-converted)/Supplier Reference collection at Mark
/// Received time, Skip SAP checkboxes, a PO-item inline fix-and-save control, manual items,
/// documents, and associated costs.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
[Authorize(Policy = "Perm:LOG_MRP,WAREHOUSE_OP")]
public class InboundLogModel : PageModel
{
    public void OnGet()
    {
    }
}
