using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>Failed Backflush — the supervisor retry/cancel queue for every Status=6 (SAP_FAILED) production record. Backend (FailedBackflushHelper, 3 routes) was fully built ahead of this page — see that Helper's own header comment. Port of runFailedBackflush in production-nexus.js.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
[Authorize(Policy = "Perm:" + ProductionReportsHelper.FnFailedBackflush)]
public class FailedBackflushModel : PageModel
{
    public void OnGet()
    {
    }
}
