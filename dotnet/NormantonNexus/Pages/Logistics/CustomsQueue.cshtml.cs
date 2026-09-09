using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Transport Management tile — port of the Customs Documents view in private/js/logistics.js (GET /api/shipmentmain/queue/customs-docs, POST .../customs/create, PATCH .../customs-required/bulk), split out of the old combined ShipmentQueue page into its own real tile.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class CustomsQueueModel : PageModel
{
    public void OnGet()
    {
    }
}
