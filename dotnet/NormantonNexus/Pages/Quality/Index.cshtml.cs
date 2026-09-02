using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Quality;

[Authorize(Policy = "Dept:" + NexusDepartments.Quality)]
public class IndexModel : PageModel
{
    public void OnGet()
    {
    }
}
