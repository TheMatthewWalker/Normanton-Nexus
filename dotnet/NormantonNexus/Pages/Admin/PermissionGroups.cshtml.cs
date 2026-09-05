using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Admin;

namespace NormantonNexus.Pages.Admin;

/// <summary>
/// Minimal permission-group management (create + list) — see the migration
/// plan's "Authorization model" section. The full Phase 9 admin UI replaces
/// this with a proper CRUD screen; this exists only so department phases
/// 2-8 have somewhere to create/assign the new per-tile permission codes.
/// Gated the same way as routes/useradmin.js's general user-management
/// routes: role &gt;= admin.
/// </summary>
[Authorize(Policy = "Role:admin")]
public class PermissionGroupsModel(IPermissionGroupAdminService groupAdmin) : PageModel
{
    public IReadOnlyList<PermissionGroupSummary> Groups { get; private set; } = [];

    [BindProperty]
    public string NewGroupName { get; set; } = "";

    [BindProperty]
    public string? NewGroupDescription { get; set; }

    public async Task OnGetAsync()
    {
        Groups = await groupAdmin.ListGroupsAsync(HttpContext.RequestAborted);
    }

    public async Task<IActionResult> OnPostCreateAsync()
    {
        if (string.IsNullOrWhiteSpace(NewGroupName))
        {
            Groups = await groupAdmin.ListGroupsAsync(HttpContext.RequestAborted);
            ModelState.AddModelError(nameof(NewGroupName), "Group name is required.");
            return Page();
        }

        var groupId = await groupAdmin.CreateGroupAsync(
            NewGroupName.Trim(), NewGroupDescription, User.Identity?.Name, HttpContext.RequestAborted);

        return RedirectToPage("PermissionGroupDetail", new { groupId });
    }
}
