using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Quality;

/// <summary>Standalone Block Stock tile — blank form, no pre-fill (matches Node opening this tile directly). Write requires Perm:QUAL_BLOCK_STOCK at the API layer.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Quality)]
public class BlockStockModel : PageModel
{
    public void OnGet()
    {
    }
}
