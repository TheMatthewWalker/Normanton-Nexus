using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>Order Lookup — find an open order, check stock &amp; required, print a Drumming Ticket. Port of the "Order Lookup" branch of Node's Drumming wizard (renderOrderLookupScreen) as its own standalone tile rather than nested inside the wizard's type picker — the search/print action itself doesn't depend on being inside that flow.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
public class OrderLookupModel : PageModel
{
    public void OnGet()
    {
    }
}
