using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Inbound Log — lists log.PurchaseOrderShipment records (from Tracked Orders' bulk selection, or created manually), with a detail view covering edit, mark received/undo, cancel, manual items, documents, and associated costs.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
[Authorize(Policy = "Perm:LOG_MRP,WAREHOUSE_OP")]
public class InboundLogModel : PageModel
{
    public void OnGet()
    {
    }
}
