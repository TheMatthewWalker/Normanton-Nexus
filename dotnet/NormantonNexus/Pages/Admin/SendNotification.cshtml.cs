using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Admin;

/// <summary>
/// Send Notification — the admin-side compose/history/expire surface backing
/// admin.html's "Send Notification" section (only the user-facing bell
/// endpoints — the tray itself — were previously ported; this is the
/// admin-broadcast half). A genuinely missing tile found by a later gap
/// audit against the Node tile inventory, not a deliberate deferral. Gated
/// Role:admin, matching NotificationsController's own per-action gate on
/// every admin route.
/// </summary>
[Authorize(Policy = "Role:" + NexusRoles.Admin)]
public class SendNotificationModel : PageModel
{
    public void OnGet()
    {
    }
}
