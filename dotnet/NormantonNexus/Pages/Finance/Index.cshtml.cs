using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Finance;

/// <summary>
/// Finance department landing page — 5 live tiles + 3 "Coming soon"
/// placeholders (Cost Centre, Vendor Invoices, Exchange Rates — no backend
/// exists for these in Node either, see dotnet/CLAUDE.md's Phase 5 notes).
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Finance)]
public class IndexModel : PageModel
{
    public void OnGet()
    {
    }
}
