namespace NormantonNexus.Models;

/// <summary>
/// Uniform envelope for every `/api/*` JSON response — the C# analog of
/// SapServer's ApiResponse&lt;T&gt;. ASP.NET Core's default System.Text.Json
/// serializer already camelCases property names, so (unlike SapServer's
/// Web API 2 + Newtonsoft split — see that repo's CLAUDE.md "Error
/// Handling") there's no separate success/error-path serializer mismatch
/// to guard against here.
/// </summary>
public sealed record ApiResponse<T>(bool Success, T? Data, ApiError? Error)
{
    public static ApiResponse<T> Ok(T data) => new(true, data, null);
    public static ApiResponse<T> Fail(string code, string message) => new(false, default, new ApiError(code, message));
}

public sealed record ApiError(string Code, string Message);
