using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Admin tile — port of "Processed Costs" in private/logistics.html (GET /api/shipmentcost/processed, POST {costId}/reverse), split out of the old combined Freight Costs page into its own tile.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class ProcessedCostsModel : PageModel
{
    public void OnGet()
    {
    }
}
