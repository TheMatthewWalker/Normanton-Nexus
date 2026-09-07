using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class ShipmentSearchModel : PageModel
{
    public void OnGet()
    {
    }
}
