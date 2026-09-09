using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Admin tile — port of "Update Packaging Data" in private/logistics.html (GET/PUT /api/packagingdata). View + edit-in-place only — no create/delete, matching Node's own fixed-master-set design.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class UpdatePackagingDataModel : PageModel
{
    public void OnGet()
    {
    }
}
