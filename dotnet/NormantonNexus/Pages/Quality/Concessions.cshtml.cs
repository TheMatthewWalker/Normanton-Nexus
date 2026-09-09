using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Helpers.Quality;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Quality;

/// <summary>
/// Traceability Concessions tile — unlike Display Stock, Node wraps this
/// whole tile (view included, not just the write) in a
/// data-permission="QUAL_CONCESSION" section, so this page requires the
/// permission to even load, not just the department.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Quality)]
[Authorize(Policy = "Perm:" + QualityHelper.FnTraceabilityConcession)]
public class ConcessionsModel : PageModel
{
    public void OnGet()
    {
    }
}
