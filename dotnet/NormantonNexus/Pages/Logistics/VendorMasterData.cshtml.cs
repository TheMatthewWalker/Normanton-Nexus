using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
[Authorize(Policy = "Perm:LOG_MRP")]
public class VendorMasterDataModel : PageModel
{
    public void OnGet()
    {
    }
}
