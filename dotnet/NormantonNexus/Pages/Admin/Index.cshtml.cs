using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Admin;

[Authorize(Policy = "Role:" + NexusRoles.Admin)]
public class IndexModel : PageModel
{
    public void OnGet()
    {
    }
}
