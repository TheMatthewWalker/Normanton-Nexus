using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>
/// Logistics landing page — port of private/logistics.html's tile grid.
/// "Customer Specifics" is a "coming soon" placeholder in Node itself
/// (confirmed by reading private/js/logistics.js directly) — omitted here,
/// same as every other department's own unbuilt-in-Node placeholder tiles.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class IndexModel : PageModel
{
    public void OnGet()
    {
    }
}
