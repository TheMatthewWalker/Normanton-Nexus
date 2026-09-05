using NormantonNexus.Models;

namespace NormantonNexus.Middleware;

/// <summary>
/// Catches exceptions from `/api/*` requests and maps them to the standard
/// ApiResponse&lt;T&gt; JSON envelope instead of letting them fall through to
/// UseExceptionHandler("/Error") (an HTML error page, wrong for an AJAX
/// caller). Page requests (Razor Pages, everything not under /api/) are
/// untouched — they still go through the normal exception-handler page.
///
/// A NexusApiException (Models/NexusExceptions.cs) carries its own status
/// code/error code; anything else maps to 500/INTERNAL_ERROR, mirroring
/// SapServer's SapExceptionMapper's catch-all.
/// </summary>
public sealed class ApiExceptionMiddleware(RequestDelegate next, ILogger<ApiExceptionMiddleware> logger)
{
    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await next(context);
        }
        catch (Exception ex) when (context.Request.Path.StartsWithSegments("/api"))
        {
            var (statusCode, code, message) = ex switch
            {
                NexusApiException nexusEx => (nexusEx.StatusCode, nexusEx.Code, nexusEx.Message),
                OperationCanceledException => (499, "REQUEST_CANCELLED", "The request was cancelled."),
                _ => (StatusCodes.Status500InternalServerError, "INTERNAL_ERROR", "An unexpected error occurred."),
            };

            if (statusCode == StatusCodes.Status500InternalServerError)
            {
                logger.LogError(ex, "Unhandled exception for {Path}", context.Request.Path);
            }

            context.Response.StatusCode = statusCode;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsJsonAsync(ApiResponse<object>.Fail(code, message));
        }
    }
}

public static class ApiExceptionMiddlewareExtensions
{
    public static IApplicationBuilder UseApiExceptionHandling(this IApplicationBuilder app) =>
        app.UseMiddleware<ApiExceptionMiddleware>();
}
