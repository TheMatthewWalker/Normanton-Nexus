using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Admin;

/// <summary>
/// SQL Console — a genuinely missing Admin tile found by a later gap audit
/// against the Node tile inventory (admin.html's own SQL Console section,
/// private/js/admin.js's runSql()/setupSqlConsole()), not a deliberate
/// deferral. Distinct from DB Explorer (schema/data browsing only). Gated
/// Role:admin, matching SqlConsoleController's own class-level gate — the
/// destructive-keyword bypass inside the route itself is superadmin-only.
/// </summary>
[Authorize(Policy = "Role:" + NexusRoles.Admin)]
public class SqlConsoleModel : PageModel
{
    public void OnGet()
    {
    }
}
