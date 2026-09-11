using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>
/// Production Schedule tile, mounted on the Production page — the
/// Production-department counterpart to Pages/Sales/ProductionSchedule.cshtml,
/// which already anticipated this page ("will be linked from a
/// Production-department page too once Phase 6 lands"). Both pages link the
/// same department-neutral wwwroot/js/production-schedule/index.js; the API
/// layer (ProductionScheduleController) is already gated
/// "Dept:production,sales", so no backend change was needed here.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
public class ProductionScheduleModel : PageModel
{
    public void OnGet()
    {
    }
}
