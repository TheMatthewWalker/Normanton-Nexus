using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.AspNetCore.RateLimiting;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages;

/// <summary>C# port of routes/auth.js's POST /login — see AuthService for the actual login logic this page just drives.</summary>
[EnableRateLimiting(RateLimitPolicies.Login)]
public class LoginModel(IAuthService authService) : PageModel
{
    [BindProperty]
    public string Username { get; set; } = "";

    [BindProperty]
    public string Password { get; set; } = "";

    public string? ErrorCode { get; private set; }

    public void OnGet(string? error)
    {
        ErrorCode = error;
    }

    public async Task<IActionResult> OnPostAsync()
    {
        if (string.IsNullOrWhiteSpace(Username) || string.IsNullOrWhiteSpace(Password))
        {
            ErrorCode = "invalid_credentials";
            return Page();
        }

        var ipAddress = HttpContext.Connection.RemoteIpAddress?.ToString();
        var result = await authService.LoginAsync(Username, Password, ipAddress, HttpContext.RequestAborted);

        switch (result)
        {
            case LoginResult.Success success:
                await HttpContext.SignInAsync(NexusAuthScheme.Name, success.Principal, success.Properties);
                // TODO(Phase 1): redirect to the real landing page once one exists —
                // matches routes/auth.js redirecting to /private/landing.html.
                return RedirectToPage("/Index");

            case LoginResult.Failure failure:
                ErrorCode = failure.Reason switch
                {
                    LoginFailureReason.PendingApproval => "pending_approval",
                    LoginFailureReason.AccountLocked => "account_locked",
                    LoginFailureReason.InvalidCredentials or _ => "invalid_credentials",
                };
                return Page();

            default:
                throw new InvalidOperationException($"Unhandled {nameof(LoginResult)} case.");
        }
    }
}
