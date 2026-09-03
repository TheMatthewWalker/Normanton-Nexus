using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>Posted Scrap — approved/SAP-posted scrap summary by work centre and reason, plus a failed-postings retry queue. Port of runPostedScrap in production-nexus.js.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
[Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
public class PostedScrapModel : PageModel
{
    public void OnGet()
    {
    }
}
