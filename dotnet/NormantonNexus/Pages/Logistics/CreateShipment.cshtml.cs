using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Create-from-deliveries only — CreateManual (no source deliveries) is the same LOG_PLANNING-gated API but a rarer edge case, not built into this UI.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
[Authorize(Policy = "Perm:LOG_PLANNING")]
public class CreateShipmentModel : PageModel
{
    public void OnGet()
    {
    }
}
