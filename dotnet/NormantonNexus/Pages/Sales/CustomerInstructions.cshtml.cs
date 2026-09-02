using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Sales;

/// <summary>
/// Customer Standard Instructions tile — its own page + dedicated JS
/// (wwwroot/js/sales/customer-instructions.js), replacing sales.js's
/// renderCustomerInstructions() innerHTML-injection. View access is
/// department-gated only; writes additionally require
/// Perm:SALES_CUSTOMER_INSTRUCTIONS at the API layer — see
/// SalesController. No client-side permission-based hide/show for the
/// Add/Edit/Delete/Import controls (same simplification Quality's
/// Concessions page made) — the API's 403 is the real gate either way.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Sales)]
public class CustomerInstructionsModel : PageModel
{
    public void OnGet()
    {
    }
}
