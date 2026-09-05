using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>
/// Production department landing page — Sub-phase 6a only (Reports, Batch
/// History, Traceability). Every other tile in Node's production-nexus.html
/// (Entry/Data/Staging Post/most of Supervisor) is real, researched, and
/// deliberately deferred to Sub-phases 6b/6c — see dotnet/CLAUDE.md's Phase
/// 6 notes — not listed here at all until its own slice lands, rather than
/// shown as a "Coming soon" placeholder (unlike Finance's 3 tiles, these
/// genuinely exist and work in Node today).
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
public class IndexModel : PageModel
{
    public void OnGet()
    {
    }
}
