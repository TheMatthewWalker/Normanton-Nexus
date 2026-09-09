using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Isopar Tied Oil — meter readings CRUD, stock risk, planning rate (all LOG_MRP), plus HMRC declaration review/submission for users who additionally hold ISOPAR_DECL (checked client-side by hiding that section on a 403 — the controller's own [Authorize(Policy = "Perm:ISOPAR_DECL")] on each declarations action is the real gate).</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
[Authorize(Policy = "Perm:LOG_MRP")]
public class IsoparTiedOilModel : PageModel
{
    public void OnGet()
    {
    }
}
