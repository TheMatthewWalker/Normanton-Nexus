using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>Drumming Data — filterable historical record listing over prod.Drumming. Backend (GET drumming/data) already existed; only the page was missing. Port of the drummingData tile in production-nexus.js.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
public class DrummingDataModel : PageModel
{
    public void OnGet()
    {
    }
}
