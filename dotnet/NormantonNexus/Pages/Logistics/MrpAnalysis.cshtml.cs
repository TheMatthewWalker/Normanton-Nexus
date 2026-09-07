using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>MRP Analysis tile — consumption/GR trends + refresh + forecast run history. The forecast-BUILDING wizards (percentage/BOM-explosion) are not built here — view-only.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
[Authorize(Policy = "Perm:LOG_MRP")]
public class MrpAnalysisModel : PageModel
{
    public void OnGet()
    {
    }
}
