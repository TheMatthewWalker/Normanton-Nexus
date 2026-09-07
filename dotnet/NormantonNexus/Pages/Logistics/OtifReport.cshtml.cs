using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
[Authorize(Policy = "Perm:LOG_ADMIN,LOG_MRP,LOG_REPORTS")]
public class OtifReportModel : PageModel
{
    public void OnGet()
    {
    }
}
