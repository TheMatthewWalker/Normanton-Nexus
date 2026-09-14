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

/// <summary>The request was well-formed but SAP rejected it for a reason the caller must act on differently (e.g. reversal/execute's "must be reversed via MBST" — matches Node's res.status(422) for that exact case).</summary>
public sealed class NexusUnprocessableEntityException(string message) : NexusApiException("UNPROCESSABLE_ENTITY", message)
{
    public override int StatusCode => StatusCodes.Status422UnprocessableEntity;
}

/// <summary>An uploaded file exceeds this endpoint's size limit — matches Node's res.status(413) for the same case (e.g. the Inbound Log document upload's 20MB cap).</summary>
public sealed class NexusPayloadTooLargeException(string message) : NexusApiException("PAYLOAD_TOO_LARGE", message)
{
    public override int StatusCode => StatusCodes.Status413PayloadTooLarge;
}

/// <summary>
/// A raw SQL Console query executed but SQL Server rejected it (bad syntax,
/// a constraint violation, etc.) — 500, but unlike every other generic
/// Exception path (which ApiExceptionMiddleware masks to "An unexpected
/// error occurred") this carries the real SQL error text through, matching
/// routes/sqlqueries.js's own res.status(500).json({success:false, error:
/// err.message}) exactly. Seeing the actual SQL error is the whole point of
/// a raw SQL console — masking it here would make the tool useless.
/// </summary>
public sealed class NexusSqlExecutionException(string message) : NexusApiException("SQL_ERROR", message)
{
    public override int StatusCode => StatusCodes.Status500InternalServerError;
}
