using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Auth;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// "My Account" self-service — port of routes/profile.js. Change-password
/// reuses the existing IAuthService.ChangePasswordAsync (same one
/// Pages/ChangePassword.cshtml.cs's forced flow uses) rather than
/// duplicating its validation/hashing here.
/// </summary>
[Route("api/profile")]
[Authorize]
public sealed class ProfileController(INexusDb db, ISapCredentialCipher cipher, IAuditLogger audit, IAuthService authService) : NexusControllerBase
{
    [HttpGet("sap-credentials")]
    public async Task<IActionResult> GetSapCredentials(CancellationToken ct)
    {
        var status = await ProfileHelper.GetSapCredentialStatusAsync(db, GetUserId(), ct);
        return Ok(ApiResponse<SapCredentialStatus>.Ok(status));
    }

    [HttpPost("sap-credentials")]
    public async Task<IActionResult> SetSapCredentials([FromBody] SetSapCredentialsRequest body, CancellationToken ct)
    {
        await ProfileHelper.SetSapCredentialsAsync(db, cipher, audit, GetUserId(), GetUsername() ?? "", body.SapUsername ?? "", body.SapPassword ?? "", GetIpAddress(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("sap-credentials")]
    public async Task<IActionResult> ClearSapCredentials(CancellationToken ct)
    {
        await ProfileHelper.ClearSapCredentialsAsync(db, audit, GetUserId(), GetUsername() ?? "", GetIpAddress(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    /// <summary>Voluntary password change — the AJAX counterpart to Pages/ChangePassword.cshtml's full-page forced flow. Doesn't need to re-sign-in on success: this route is only reachable once MustChangePassword is already false (the page filter would have redirected a forced user to /ChangePassword before they ever get here), so there's no stale MustChangePassword claim to drop.</summary>
    [HttpPost("change-password")]
    public async Task<IActionResult> ChangePassword([FromBody] ChangePasswordApiRequest body, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(body.CurrentPassword) || string.IsNullOrEmpty(body.NewPassword))
            throw new NexusValidationException("Current and new password are both required.");

        var result = await authService.ChangePasswordAsync(GetUserId(), body.CurrentPassword, body.NewPassword, GetIpAddress(), ct);
        return result switch
        {
            ChangePasswordResult.Success => Ok(ApiResponse<object?>.Ok(null)),
            ChangePasswordResult.Failure failure => failure.Reason switch
            {
                ChangePasswordFailureReason.IncorrectCurrentPassword => throw new NexusValidationException("Current password is incorrect."),
                ChangePasswordFailureReason.NewPasswordTooWeak => throw new NexusValidationException("New password must be at least 10 characters with one uppercase letter and one number."),
                ChangePasswordFailureReason.NewPasswordSameAsCurrent => throw new NexusValidationException("New password must be different from your current password."),
                _ => throw new NexusValidationException("Could not change password."),
            },
            _ => throw new InvalidOperationException($"Unhandled {nameof(ChangePasswordResult)} case."),
        };
    }
}
