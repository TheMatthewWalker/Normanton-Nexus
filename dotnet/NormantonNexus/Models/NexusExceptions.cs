namespace NormantonNexus.Models;

/// <summary>
/// Base for exceptions that carry their own HTTP status/error code — caught
/// by Middleware/ApiExceptionMiddleware.cs and mapped straight into an
/// ApiResponse&lt;T&gt; envelope, the same shape SapServer's SapExceptionMapper
/// gives its own exception hierarchy. Department-specific exceptions (a
/// SapServerClient connection failure, a business-rule violation) should
/// derive from this rather than throwing a bare Exception, so a controller
/// action can just `throw` and get the right status/code without a
/// try/catch of its own.
/// </summary>
public abstract class NexusApiException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
    public abstract int StatusCode { get; }
}

public sealed class NexusNotFoundException(string message) : NexusApiException("NOT_FOUND", message)
{
    public override int StatusCode => StatusCodes.Status404NotFound;
}

public sealed class NexusValidationException(string message) : NexusApiException("VALIDATION_ERROR", message)
{
    public override int StatusCode => StatusCodes.Status400BadRequest;
}

public sealed class NexusPermissionException(string message) : NexusApiException("FORBIDDEN", message)
{
    public override int StatusCode => StatusCodes.Status403Forbidden;
}

public sealed class NexusConflictException(string message) : NexusApiException("CONFLICT", message)
{
    public override int StatusCode => StatusCodes.Status409Conflict;
}

/// <summary>A dependency (typically SAP, via SapServer) genuinely could not confirm something needed to proceed safely — 502, matching routes/productionnexus.js's own Object.assign(new Error(...), {{ statusCode: 502 }}) convention for e.g. a failed profit-centre check.</summary>
public sealed class NexusBadGatewayException(string message) : NexusApiException("BAD_GATEWAY", message)
{
    public override int StatusCode => StatusCodes.Status502BadGateway;
}
