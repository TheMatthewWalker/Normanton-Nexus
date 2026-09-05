namespace NormantonNexus.Models.Dto;

// Failed Backflush — port of routes/productionnexus.js's
// GET /failed-backflush, PATCH /failed-backflush/:pc/:id/retry, and
// PATCH /failed-backflush/:pc/:id/cancel. A five-way supervisor retry
// queue spanning every process (MX/DR/EX/CO/BR/CL/TW/EW/HA — FW is
// deliberately excluded, matching Node's own "not yet implemented"), each
// with a genuinely different retry shape: MX retries per failed tub
// individually; DR re-runs the same hard-block/concession/backflush logic
// submitDrumming itself uses; EX/CO/BR/CL/TW re-run a plain ZF40N
// backflush (EX additionally re-gates on MX-tub staging, same check the
// draft->complete wizard uses); EW/HA have no SAP call at all — "retry"
// there just means a supervisor reviewed the record and marked it
// complete. One flat request DTO covers every branch's own subset of
// fields, mirroring how Node's single route handler destructures a
// different subset of req.body per process code.

public sealed record FailedBackflushRow(
    string ProcessCode, int RecordId, string BatchRef, string Material, decimal Quantity, string Uom,
    DateTime CreatedAt, string? ErrorMessage, DateTime? FailedAt, int? SapPostingId);

public sealed record FailedBackflushRetryRequest(
    // MX
    string? MixCode, string? SupplierBatchNo, string? SupplierTubNo,
    // DR (Comments maps to Drumming.Notes — Node's own field name for this process)
    string? PackagingId, decimal? WeightKg, string? CustomerNumber, string? OrderNumber, string? Comments,
    // EX/CO/BR/CL/TW (ParentBatches is EX-only, replaces its MX trace links wholesale when present)
    List<ParentBatchRef>? ParentBatches,
    // HA
    string? SalesOrderSap,
    // Shared across DR/EX/CO/BR/CL/TW/EW/HA
    string? Material, decimal? LengthMetres, string? Notes);

public sealed record MxTubRetryResult(int TubId, bool Success, string? MaterialDocument, string? Error);

/// <summary>
/// Status is one of "COMPLETE", "SAP_FAILED" (MX only — some tubs still
/// failed after retry, HTTP 200 with a warning, not an error — matches
/// Node's own res.json for this specific case), or "BLOCKED" (DR only,
/// HTTP 409 — a genuine error response, same real behavioral difference
/// preserved in submitDrumming's own DrummingSubmitResult). Tubs is
/// populated only for the MX branch; every other branch returns null.
/// A hard SAP failure (any branch except MX, which handles its own
/// per-tub failures internally) throws instead of returning a result —
/// see FailedBackflushHelper.RetryAsync's shared catch, mapped to a real
/// HTTP 502 by the controller/ApiExceptionMiddleware, matching Node's own
/// res.status(502) for this case exactly.
/// </summary>
public sealed record FailedBackflushRetryResult(
    string Status, string? MaterialDocument, bool ConcessionApplied, string? Warning, IReadOnlyList<MxTubRetryResult>? Tubs);
