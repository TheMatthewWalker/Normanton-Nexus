using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Admin;

/// <summary>SAP RFC/BAPI function metadata lookup — superadmin-only, matching BapiInspectorController's own Role:superadmin gate exactly.</summary>
[Authorize(Policy = "Role:" + NexusRoles.Superadmin)]
public class BapiInspectorModel : PageModel
{
    public void OnGet()
    {
    }
}
