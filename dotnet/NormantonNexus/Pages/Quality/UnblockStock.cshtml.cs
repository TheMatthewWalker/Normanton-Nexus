using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Quality;

/// <summary>Standalone Unblock Stock tile — blank form, no pre-fill. Write requires Perm:QUAL_UNBLOCK_STOCK at the API layer.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Quality)]
public class UnblockStockModel : PageModel
{
    public void OnGet()
    {
    }
}
