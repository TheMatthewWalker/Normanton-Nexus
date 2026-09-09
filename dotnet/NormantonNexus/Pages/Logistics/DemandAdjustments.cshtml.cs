using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
[Authorize(Policy = "Perm:LOG_MRP")]
public class DemandAdjustmentsModel : PageModel
{
    /// <summary>Optional deep-link from Stock History &amp; Forecast's "+ Add Demand Adjustment" link — pre-fills the material field on load.</summary>
    [BindProperty(SupportsGet = true)]
    public string? Material { get; set; }

    public void OnGet()
    {
    }
}
