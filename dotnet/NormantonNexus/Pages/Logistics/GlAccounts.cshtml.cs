using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Admin tile — port of "GL Accounts" in private/logistics.html (log.CostElements CRUD), split out of the old combined Reference Data page into its own tile with a real NexusModal add/edit form.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class GlAccountsModel : PageModel
{
    public void OnGet()
    {
    }
}
