using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Finance;

/// <summary>
/// Material Costing tile — port of finance.js's showCostingForm()/
/// runMaterialCosting(). Simplified from the Node original: the per-row
/// Quantity/Incoterms/Country inputs are dropped — research confirmed
/// SapServer's CostSheetRequest only ever reads Materials[]/Date, so those
/// fields were collected by the Node form but never actually consumed
/// server-side; porting unused input fields would be dead UI. Materials are
/// entered one-per-line instead of a dynamic add/remove row grid.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Finance)]
public class MaterialCostingModel : PageModel
{
    public void OnGet()
    {
    }
}
