using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Engineering;

/// <summary>
/// Mass Packaging Update tile — its own page + dedicated JS
/// (wwwroot/js/engineering/mass-update.js), replacing engineering.js's
/// renderMassUpdate() innerHTML-injection. View access is department-gated
/// only, same as Node's canView; the actual write (POST /api/packaging/mass-update)
/// additionally requires Perm:ENG_MASS_UPDATE at the API layer — see
/// EngineeringController.MassUpdate.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Engineering)]
public class MassUpdateModel : PageModel
{
    public void OnGet()
    {
    }
}
