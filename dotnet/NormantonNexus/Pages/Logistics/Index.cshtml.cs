using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>
/// Logistics landing page — port of private/logistics.html's real tile grid,
/// grouped into the same 4 named sections Node uses (Transport Management /
/// Material Planning / Reports / Admin — see .tile-section-group). No
/// client-side permission-based section/tile hiding (matches this app's own
/// "the API's 403 is the real gate either way" precedent, already used on
/// every other department's landing page). "Customer Specifics" is a
/// "coming soon" placeholder in Node itself (confirmed by reading
/// private/js/logistics.js directly) — rendered here as a real, visible,
/// disabled tile in its correct grid position (matching Finance's Index.cshtml
/// "Coming soon" tile convention), not omitted, since Node's own tile grid
/// genuinely shows it in this exact spot.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class IndexModel : PageModel
{
    public void OnGet()
    {
    }
}
