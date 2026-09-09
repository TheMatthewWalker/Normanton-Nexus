using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Admin tile — port of "Update Destinations" in private/logistics.html (log.Destinations CRUD), split out of the old combined Reference Data page into its own tile with a real NexusModal add/edit form, matching Node's own separate-tile grouping.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class UpdateDestinationsModel : PageModel
{
    public void OnGet()
    {
    }
}
