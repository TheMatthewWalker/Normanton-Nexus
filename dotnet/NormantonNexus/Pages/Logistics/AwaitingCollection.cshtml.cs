using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Transport Management tile — port of the Awaiting Collection view in private/js/logistics.js (GET /api/shipmentmain/queue/awaiting-collection, POST .../mark-collected-bulk, .../unbook, .../update-planned-collection), split out of the old combined ShipmentQueue page into its own tile with the real Mark Collected modal (Operator/Driver/Vehicle Reg/Trailer, mixed-haulier warning).</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class AwaitingCollectionModel : PageModel
{
    public void OnGet()
    {
    }
}
