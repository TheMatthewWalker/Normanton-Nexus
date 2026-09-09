using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace NormantonNexus.Services.Auth;

/// <summary>
/// Global Razor Pages filter (registered via AddRazorPages in Program.cs)
/// that redirects any authenticated request carrying the
/// NexusClaimTypes.MustChangePassword claim to /ChangePassword — the C#
/// analog of server.js's generic /private/:page handler, which redirected
/// every private page except landing.html back to landing.html while
/// req.session.user.mustChangePassword was true (landing.js then opened a
/// blocking modal). This app uses a real dedicated page instead of a
/// modal-on-the-hub, matching the rest of this migration's move away from
/// injected/modal UI — see the migration plan.
///
/// Deliberately a page filter, not middleware: it only ever runs for real
/// Razor Page requests (never static assets or [ApiController] JSON
/// endpoints), the same effective scope Node's own gate had for
/// /private/*.html specifically.
/// </summary>
public sealed class MustChangePasswordPageFilter : IAsyncPageFilter
{
    private static readonly string[] AllowedPagePaths = ["/ChangePassword", "/Login"];

    public Task OnPageHandlerSelectionAsync(PageHandlerSelectedContext context) => Task.CompletedTask;

    public async Task OnPageHandlerExecutionAsync(PageHandlerExecutingContext context, PageHandlerExecutionDelegate next)
    {
        var user = context.HttpContext.User;
        var pagePath = context.ActionDescriptor.ViewEnginePath;

        if (user.Identity?.IsAuthenticated == true
            && user.HasClaim(c => c.Type == NexusClaimTypes.MustChangePassword)
            && !AllowedPagePaths.Contains(pagePath))
        {
            context.Result = new RedirectResult("/ChangePassword");
            return;
        }

        await next();
    }
}
