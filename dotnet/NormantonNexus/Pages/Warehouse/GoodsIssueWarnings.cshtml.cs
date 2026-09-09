using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Warehouse;

[Authorize(Policy = "Dept:" + NexusDepartments.Warehouse)]
public class GoodsIssueWarningsModel : PageModel
{
    public void OnGet()
    {
    }
}
