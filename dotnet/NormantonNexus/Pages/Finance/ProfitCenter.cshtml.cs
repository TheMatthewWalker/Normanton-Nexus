using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Finance;

/// <summary>
/// Profit Center Data tile — port of finance.js's showProfitCenterForm()/
/// runProfitCenter()/renderProfitCenterResults(). PC_SEGMENT_MAP (the
/// hardcoded profit-center-code -> PV/PTFE/Other business-rule table) is
/// ported verbatim in the JS — pure business logic with no server-side
/// equivalent, confirmed against the real Node source.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Finance)]
public class ProfitCenterModel : PageModel
{
    public void OnGet()
    {
    }
}
