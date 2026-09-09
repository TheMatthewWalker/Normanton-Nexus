using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Sales;

/// <summary>Sales department landing page — one tile per real page, replacing sales.js's openFunction() innerHTML-swap dispatch.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Sales)]
public class IndexModel : PageModel
{
    public void OnGet()
    {
    }
}
