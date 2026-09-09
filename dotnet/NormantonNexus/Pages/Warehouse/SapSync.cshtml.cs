using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Warehouse;

[Authorize(Policy = "Dept:" + NexusDepartments.Warehouse)]
[Authorize(Policy = "Perm:LOG_SUPER")]
public class SapSyncModel : PageModel
{
    public void OnGet()
    {
    }
}
