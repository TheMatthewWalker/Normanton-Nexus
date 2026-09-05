using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>Approve Scrap — supervisor queue reviewing/posting operator scrap entries to SAP. Port of runApproveScrap in production-nexus.js.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
[Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
public class ApproveScrapModel : PageModel
{
    public void OnGet()
    {
    }
}
