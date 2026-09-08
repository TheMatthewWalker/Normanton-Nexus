using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Helpers.Notifications;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Pages;

/// <summary>"View all" behind the notification bell tray — full history including dismissed. Port of the read side of private/notifications.html.</summary>
[Authorize]
public class NotificationsHistoryModel(INexusDb db) : PageModel
{
    public IReadOnlyList<NotificationRow> Notifications { get; private set; } = [];

    public async Task OnGetAsync(CancellationToken ct)
    {
        var userId = int.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
        Notifications = await NotificationsHelper.ListHistoryAsync(db, userId, ct);
    }
}
