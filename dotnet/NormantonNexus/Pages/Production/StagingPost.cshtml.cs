using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>
/// Staging Post tile, mounted on the Production page — the Production-side
/// counterpart to Pages/Warehouse/StagingPost.cshtml. Node mounts Staging
/// Post on production-nexus.html itself (requests are raised BY Production
/// floor staff FOR Stores — see StagingController's own doc comment: its
/// main actions carry no department gate at all, only requireLogin, for
/// exactly this reason). Before this page existed, a Production-department
/// user had no way to reach Staging Post in this app at all, unlike Node —
/// this closes that navigation-parity gap. Links the same
/// wwwroot/js/warehouse/staging-post.js the Warehouse page uses; nothing
/// about that script is Warehouse-specific; only its folder name is a
/// leftover of which department's phase first built it.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
public class StagingPostModel : PageModel
{
    public void OnGet()
    {
    }
}
