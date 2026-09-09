using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Admin tile — port of "Forwarder Mode Mapping" in private/logistics.html (log.ForwarderModeMapping CRUD), split out of the old combined Reference Data page into its own tile with a real NexusModal add/edit form.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class ForwarderModeMappingModel : PageModel
{
    public void OnGet()
    {
    }
}
