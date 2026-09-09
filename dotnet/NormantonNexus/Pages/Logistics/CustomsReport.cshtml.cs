using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Report generation needs Perm:LOG_CUSTOMS_REPORT, VAT-override/HS-description admin needs Perm:LOG_ADMIN — two different codes, so this page stays Dept:logistics-only and lets each API call's own 403 be the real gate, same precedent used throughout this app.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
public class CustomsReportModel : PageModel
{
    public void OnGet()
    {
    }
}
