using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace NormantonNexus.Controllers;

/// <summary>
/// Base for every department [ApiController] — C# analog of SapServer's
/// SapControllerBase. Authorization itself is declarative
/// ([Authorize(Policy = "Dept:x"/"Perm:x"/"Role:x")], see
/// Services/Auth/NexusPolicyProvider.cs), not something this base class
/// does in code — this just supplies the small pieces every controller
/// action needs afterward (who's calling, for audit logging/SapServerClient
/// tokens/permission-resolution).
/// </summary>
[Authorize]
[ApiController]
public abstract class NexusControllerBase : ControllerBase
{
    protected int GetUserId() =>
        int.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? throw new InvalidOperationException("Authenticated request has no NameIdentifier claim."));

    protected string? GetUsername() => User.Identity?.Name;

    protected string? GetIpAddress() => HttpContext.Connection.RemoteIpAddress?.ToString();
}
