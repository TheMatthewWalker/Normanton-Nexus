using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Warehouse;

/// <summary>
/// Weekly PTFE Cycle Count tile — currently read-only (shows this week's
/// count and any lines already entered). Line entry (material/qty/location
/// with a live SAP comparison) is real, unbuilt scope — see
/// StockCountModels.cs's own header comment — deferred, same as Raw
/// Material/Production/Finished Goods Count entry.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Warehouse)]
public class PtfeCycleCountModel : PageModel
{
    public void OnGet()
    {
    }
}
