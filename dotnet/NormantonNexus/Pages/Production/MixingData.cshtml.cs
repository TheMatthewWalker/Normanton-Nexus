using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>Mixing Data — filterable historical record listing over prod.Mixing. Backend (GET mixing/data) added alongside this page — neither existed before. Port of the mixingData tile in production-nexus.js.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
public class MixingDataModel : PageModel
{
    public void OnGet()
    {
    }
}
