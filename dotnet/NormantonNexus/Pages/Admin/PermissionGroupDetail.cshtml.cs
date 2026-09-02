using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Admin;

namespace NormantonNexus.Pages.Admin;

[Authorize(Policy = "Role:admin")]
public class PermissionGroupDetailModel(IPermissionGroupAdminService groupAdmin) : PageModel
{
    public PermissionGroupDetail? Group { get; private set; }
    public IReadOnlyList<PermissionOption> AllPermissions { get; private set; } = [];
    public IReadOnlyList<UserOption> AllUsers { get; private set; } = [];

    [BindProperty(SupportsGet = true)]
    public int GroupId { get; set; }

    [BindProperty]
    public string? PermissionCodeToAdd { get; set; }

    [BindProperty]
    public int? UserIdToAssign { get; set; }

    public async Task<IActionResult> OnGetAsync()
    {
        var ct = HttpContext.RequestAborted;
        Group = await groupAdmin.GetGroupAsync(GroupId, ct);
        if (Group is null) return NotFound();

        AllPermissions = await groupAdmin.ListAllPermissionsAsync(ct);
        AllUsers = await groupAdmin.ListAllUsersAsync(ct);
        return Page();
    }

    public async Task<IActionResult> OnPostAddPermissionAsync()
    {
        if (!string.IsNullOrWhiteSpace(PermissionCodeToAdd))
        {
            await groupAdmin.AddPermissionToGroupAsync(GroupId, PermissionCodeToAdd, HttpContext.RequestAborted);
        }
        return RedirectToPage(new { groupId = GroupId });
    }

    public async Task<IActionResult> OnPostRemovePermissionAsync(string permissionCode)
    {
        await groupAdmin.RemovePermissionFromGroupAsync(GroupId, permissionCode, HttpContext.RequestAborted);
        return RedirectToPage(new { groupId = GroupId });
    }

    public async Task<IActionResult> OnPostAssignUserAsync()
    {
        if (UserIdToAssign is { } userId)
        {
            var grantedByUserId = int.TryParse(User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value, out var id)
                ? id
                : (int?)null;
            await groupAdmin.AssignGroupToUserAsync(userId, GroupId, grantedByUserId, HttpContext.RequestAborted);
        }
        return RedirectToPage(new { groupId = GroupId });
    }

    public async Task<IActionResult> OnPostRemoveUserAsync(int userId)
    {
        await groupAdmin.RemoveGroupFromUserAsync(userId, GroupId, HttpContext.RequestAborted);
        return RedirectToPage(new { groupId = GroupId });
    }
}
