using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.AspNetCore.RateLimiting;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages;

/// <summary>C# port of routes/auth.js's POST /reset-password — see AuthService.ResetPasswordAsync for the actual logic. No [Authorize] — matches Login.cshtml.cs's own precedent.</summary>
[EnableRateLimiting(RateLimitPolicies.Login)]
public class ResetPasswordModel(IAuthService authService) : PageModel
{
    [BindProperty(SupportsGet = true)]
    public string? Token { get; set; }

    [BindProperty]
    public string NewPassword { get; set; } = "";

    [BindProperty]
    public string ConfirmPassword { get; set; } = "";

    public string? ErrorMessage { get; private set; }
    public bool Submitted { get; private set; }

    public void OnGet()
    {
    }

    public async Task<IActionResult> OnPostAsync()
    {
        if (string.IsNullOrEmpty(Token))
        {
            ErrorMessage = "Missing recovery token — use the link from your reset email.";
            return Page();
        }

        if (string.IsNullOrEmpty(NewPassword))
        {
            ErrorMessage = "New password is required.";
            return Page();
        }

        if (NewPassword != ConfirmPassword)
        {
            ErrorMessage = "Passwords do not match.";
            return Page();
        }

        var ipAddress = HttpContext.Connection.RemoteIpAddress?.ToString();
        var result = await authService.ResetPasswordAsync(Token, NewPassword, ipAddress, HttpContext.RequestAborted);

        switch (result)
        {
            case ResetPasswordResult.Success:
                Submitted = true;
                return Page();

            case ResetPasswordResult.Failure failure:
                ErrorMessage = failure.Reason switch
                {
                    ResetPasswordFailureReason.NewPasswordTooWeak =>
                        "New password must be at least 10 characters and include an uppercase letter and a number.",
                    ResetPasswordFailureReason.InvalidOrExpiredToken or _ =>
                        "The provided recovery verification token is invalid or has expired.",
                };
                return Page();

            default:
                throw new InvalidOperationException($"Unhandled {nameof(ResetPasswordResult)} case.");
        }
    }
}
