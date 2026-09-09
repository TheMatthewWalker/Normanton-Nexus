using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Admin tile — port of "Unprocessed Costs" in private/logistics.html (GET /api/shipmentcost/unprocessed, bulk POST /post-migo, PATCH/DELETE per line, POST manual), split out of the old combined Freight Costs page into its own tile with real NexusModal edit/add forms.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class UnprocessedCostsModel : PageModel
{
    public void OnGet()
    {
    }
}
