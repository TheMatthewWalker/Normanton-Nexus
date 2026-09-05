using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Engineering;

/// <summary>New Customer Packaging Creation tile — port of engineering.js's renderNewPackaging(). Write requires Perm:ENG_NEW_PACKAGING at the API layer.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Engineering)]
public class NewPackagingModel : PageModel
{
    public string[] AvailableCodes => PackagingCodes.All;

    public void OnGet()
    {
    }
}
