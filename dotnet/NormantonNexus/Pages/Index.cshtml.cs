using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages;

/// <summary>The Hub — C# port of Node's private/landing.html. Tiles for every department the current user belongs to.</summary>
[Authorize]
public class IndexModel : PageModel
{
    public IReadOnlyList<DepartmentCatalog.Entry> AccessibleDepartments { get; private set; } = [];

    public void OnGet()
    {
        var isSuperadmin = User.IsInRole(NexusRoles.Superadmin);
        var departmentClaims = User.Claims
            .Where(c => c.Type == NexusClaimTypes.Department)
            .Select(c => c.Value)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        AccessibleDepartments = DepartmentCatalog.All
            .Where(d => isSuperadmin || departmentClaims.Contains(d.Code))
            .ToArray();
    }
}
