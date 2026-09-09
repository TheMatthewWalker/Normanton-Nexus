using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Transport Management tile — port of the Awaiting Booking view in private/js/logistics.js (GET /api/shipmentmain/queue/awaiting-booking), split out of the old combined ShipmentQueue page into its own tile with the real Book modal (wwwroot/js/logistics/shipment-booking.js).</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class AwaitingBookingModel : PageModel
{
    public void OnGet()
    {
    }
}
