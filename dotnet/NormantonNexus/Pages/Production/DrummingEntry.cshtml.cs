using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>
/// Drumming entry — port of Node's Drumming wizard (renderDrummingWizard),
/// simplified to one form per type (Make-to-Stock / Make-to-Order) instead
/// of Node's phased Details/Traceability/Coil Lengths/Scrap/Review steps —
/// same "form can grow into the fuller wizard later" precedent already
/// documented on MetreEntry.cshtml. The wizard's third type option, Order
/// Lookup, is its own standalone tile here (OrderLookup.cshtml) rather than
/// nested inside this page, since searching/printing a ticket doesn't
/// depend on being mid-wizard.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
public class DrummingEntryModel : PageModel
{
    public void OnGet()
    {
    }
}
