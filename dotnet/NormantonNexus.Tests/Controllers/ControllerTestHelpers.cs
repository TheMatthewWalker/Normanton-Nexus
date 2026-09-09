using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Models;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Tests.Controllers;

/// <summary>
/// Direct-instantiation + Moq controller testing helpers — C# analog of
/// SapServer.Tests's ControllerTestHelpers.SetUser. Faster to write per
/// controller than a full TestServer round-trip; real routing/[Authorize]
/// policy evaluation is exercised separately (or not yet — see
/// dotnet/CLAUDE.md's verification notes).
/// </summary>
internal static class ControllerTestHelpers
{
    /// <summary>Sets a ControllerBase's HttpContext.User to a principal carrying the given claims — mirrors the shape AuthService.LoginAsync builds at real login.</summary>
    internal static void SetUser(
        ControllerBase controller,
        int userId,
        string username = "testuser",
        string role = NexusRoles.Operator,
        IEnumerable<string>? departments = null,
        IEnumerable<string>? permissions = null,
        string? ipAddress = "127.0.0.1")
    {
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, userId.ToString()),
            new(ClaimTypes.Name, username),
            new(ClaimTypes.Role, role),
        };
        claims.AddRange((departments ?? []).Select(d => new Claim(NexusClaimTypes.Department, d)));
        claims.AddRange((permissions ?? []).Select(p => new Claim(NexusClaimTypes.Permission, p)));

        var identity = new ClaimsIdentity(claims, "TestAuth");
        var httpContext = new DefaultHttpContext { User = new ClaimsPrincipal(identity) };
        if (ipAddress is not null)
        {
            httpContext.Connection.RemoteIpAddress = System.Net.IPAddress.Parse(ipAddress);
        }

        controller.ControllerContext = new ControllerContext { HttpContext = httpContext };
    }

    /// <summary>Unwraps an OkObjectResult's ApiResponse&lt;T&gt; payload for assertion, same "assert on the shape, not the exact closed generic type" approach as SapServer.Tests.</summary>
    internal static ApiResponse<T> AssertOk<T>(IActionResult result)
    {
        var ok = Assert.IsType<OkObjectResult>(result);
        return Assert.IsType<ApiResponse<T>>(ok.Value);
    }
}
