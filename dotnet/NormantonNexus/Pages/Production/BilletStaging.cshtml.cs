using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>
/// Billet Staging tile — port of the mix-tub staging routes in
/// productionnexus.js, reached in Node via the Extrusion entry wizard's
/// parent-picker "chooser," not a top-level tile. Built here as a real
/// standalone page (still useful on its own) since the Extrusion wizard
/// itself is a later slice of Sub-phase 6b. Department-gated only, no
/// additional permission check — matches Node exactly.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
public class BilletStagingModel : PageModel
{
    public void OnGet()
    {
    }
}
