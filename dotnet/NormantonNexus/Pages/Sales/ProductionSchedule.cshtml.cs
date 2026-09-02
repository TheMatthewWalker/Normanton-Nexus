using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Sales;

/// <summary>
/// Production Schedule tile, mounted on the Sales page — port of Node's
/// window.ProductionScheduleReport, shared between Sales and Production
/// (Node mounts the exact same private/js/production-schedule.js on both
/// production-nexus.html and sales.html). The dedicated JS
/// (wwwroot/js/production-schedule/index.js) is department-neutral and will
/// be linked from a Production-department page too once Phase 6 lands —
/// only this Razor Page (and its Sales-department gate) is Sales-specific.
/// View access is "Dept:production,sales" at the API layer
/// (ProductionScheduleController) — this page only needs Sales, since a
/// Production-only user reaches the same report via its own future page.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Sales)]
public class ProductionScheduleModel : PageModel
{
    public void OnGet()
    {
    }
}
