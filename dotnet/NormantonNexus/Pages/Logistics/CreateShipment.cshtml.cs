using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Full delivery-picker flow (bucketed by urgency, locked to one customer) + Manual Shipment + the post-create action cards — design approved via the /design canvas "Create Outbound Shipment Redesign", replacing the earlier bare comma-separated-delivery-IDs form.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
[Authorize(Policy = "Perm:LOG_PLANNING")]
public class CreateShipmentModel : PageModel
{
    public void OnGet()
    {
    }
}
