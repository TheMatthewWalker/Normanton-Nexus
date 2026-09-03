using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>SAP Reversals — search SAP postings by material document / batch reference / material / date range / operator, then bulk-reverse the selected backflush documents. Port of the reversal search UI in production-nexus.js (the /reversal/execute and PATCH /reversal/:id routes are ported backend-only — Node's own frontend doesn't call them either, only the bulk path).</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
[Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
public class SapReversalsModel : PageModel
{
    public void OnGet()
    {
    }
}
