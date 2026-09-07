using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Admin;

[Authorize(Policy = "Role:" + NexusRoles.Admin)]
public class AuditLogModel : PageModel
{
    public void OnGet()
    {
    }
}
