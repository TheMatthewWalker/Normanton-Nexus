using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>
/// Stock Turns &amp; Valuation tile — aggregates/value-by-price only (the
/// full per-material list has ~25 columns, not rendered here). Change
/// Valuation Class (POST /turns-valclass/change-valuation-class) and Stock
/// History &amp; Forecast (GET /turns-valclass/history) are real, unbuilt
/// gaps — both already flagged in dotnet/CLAUDE.md before this pass.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class TurnsValClassModel : PageModel
{
    public void OnGet()
    {
    }
}
