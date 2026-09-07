using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Warehouse;

/// <summary>LOG_SUPER-gated in Node (manual delivery-record entry, bypasses the normal SAP sync).</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Warehouse)]
[Authorize(Policy = "Perm:LOG_SUPER")]
public class AddPicksheetModel : PageModel
{
    public void OnGet()
    {
    }
}
