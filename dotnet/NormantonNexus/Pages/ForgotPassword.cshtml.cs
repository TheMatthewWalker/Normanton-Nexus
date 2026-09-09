using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.AspNetCore.RateLimiting;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages;

/// <summary>C# port of routes/auth.js's POST /forgot-password — see AuthService.RequestPasswordResetAsync for the actual logic. No [Authorize] — Razor Pages in this app are opt-in to authorization, matching Login.cshtml.cs's own precedent.</summary>
[EnableRateLimiting(RateLimitPolicies.Login)]
public class ForgotPasswordModel(IAuthService authService) : PageModel
{
    [BindProperty]
    public string Email { get; set; } = "";

    public bool Submitted { get; private set; }

    public async Task<IActionResult> OnPostAsync()
    {
        if (string.IsNullOrWhiteSpace(Email))
        {
            ModelState.AddModelError(string.Empty, "Email address is required.");
            return Page();
        }

        var baseUrl = $"{Request.Scheme}://{Request.Host}";
        await authService.RequestPasswordResetAsync(Email, baseUrl, HttpContext.RequestAborted);

        // Always shows the same success message regardless of whether the email
        // matched an account — mitigates enumeration, matching Node's own
        // early-return-on-zero-rows-affected still responding 200.
        Submitted = true;
        return Page();
    }
}
