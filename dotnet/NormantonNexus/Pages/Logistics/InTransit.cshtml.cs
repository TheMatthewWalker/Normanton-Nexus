using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Transport Management tile — port of the In Transit view in private/js/logistics.js (GET /api/shipmentmain/queue/in-transit, POST .../mark-delivered and .../mark-delivered-bulk), split out of the old combined ShipmentQueue page into its own tile.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class InTransitModel : PageModel
{
    public void OnGet()
    {
    }
}
