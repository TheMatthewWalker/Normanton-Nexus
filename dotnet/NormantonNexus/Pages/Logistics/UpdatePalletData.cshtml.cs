using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Admin tile — port of "Update Pallet Data" in private/logistics.html (GET/PUT /api/palletdata). View + edit-in-place only — no create/delete, matching Node's own fixed-master-set design (WarehouseMasterDataController's own precedent).</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class UpdatePalletDataModel : PageModel
{
    public void OnGet()
    {
    }
}
