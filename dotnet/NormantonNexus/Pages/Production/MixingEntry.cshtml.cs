using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>
/// Mixing tile — port of runMixingEntry in production-nexus.js. Department-
/// gated only, no additional permission check — matches Node, which gates
/// this route no further than requireLogin (Production Entry tiles are
/// open to any department member, unlike the Supervisor section).
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
public class MixingEntryModel : PageModel
{
    public void OnGet()
    {
    }
}
