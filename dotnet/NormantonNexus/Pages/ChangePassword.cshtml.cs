using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages;

/// <summary>
/// Change-password page — the required, forced flow when
/// PortalUsers.MustChangePassword is set (see MustChangePasswordPageFilter),
/// and also usable voluntarily by any authenticated user. C# port of the
/// intent behind landing.js's blocking "change password" modal, as a real
/// page instead — see MustChangePasswordPageFilter's own comments.
/// </summary>
[Authorize]
public class ChangePasswordModel(IAuthService authService) : PageModel
{
    [BindProperty]
    public string CurrentPassword { get; set; } = "";

    [BindProperty]
    public string NewPassword { get; set; } = "";

    [BindProperty]
    public string ConfirmPassword { get; set; } = "";

    public string? ErrorMessage { get; private set; }

    public void OnGet()
    {
    }

    public async Task<IActionResult> OnPostAsync()
    {
        if (NewPassword != ConfirmPassword)
        {
            ErrorMessage = "New password and confirmation do not match.";
            return Page();
        }

        var userId = int.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var ipAddress = HttpContext.Connection.RemoteIpAddress?.ToString();

        var result = await authService.ChangePasswordAsync(userId, CurrentPassword, NewPassword, ipAddress, HttpContext.RequestAborted);

        switch (result)
        {
            case ChangePasswordResult.Success:
                // The stored MustChangePassword flag is now cleared, but the
                // LIVE session's claims still carry the old value until the
                // ticket is re-issued — re-sign-in with the claim dropped so
                // the user isn't immediately redirected right back here by
                // MustChangePasswordPageFilter.
                var claims = User.Claims.Where(c => c.Type != NexusClaimTypes.MustChangePassword);
                var identity = new ClaimsIdentity(claims, NexusAuthScheme.Name);
                await HttpContext.SignInAsync(NexusAuthScheme.Name, new ClaimsPrincipal(identity));
                return RedirectToPage("/Index");

            case ChangePasswordResult.Failure failure:
                ErrorMessage = failure.Reason switch
                {
                    ChangePasswordFailureReason.IncorrectCurrentPassword => "Current password is incorrect.",
                    ChangePasswordFailureReason.NewPasswordTooShort => "New password must be at least 8 characters.",
                    _ => "Could not change password.",
                };
                return Page();

            default:
                throw new InvalidOperationException($"Unhandled {nameof(ChangePasswordResult)} case.");
        }
    }
}
