using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Engineering;

/// <summary>Engineering department landing page — one tile per real page, replacing engineering.js's openFunction() innerHTML-swap dispatch.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Engineering)]
public class IndexModel : PageModel
{
    public void OnGet()
    {
    }
}
