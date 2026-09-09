using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Warehouse;

[Authorize(Policy = "Dept:" + NexusDepartments.Warehouse)]
public class StockManagementModel : PageModel
{
    public void OnGet()
    {
    }
}
