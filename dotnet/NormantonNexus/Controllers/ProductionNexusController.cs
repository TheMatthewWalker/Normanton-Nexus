using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Production department, Sub-phase 6a — the 7 supervisor reports, Batch
/// History, and Traceability. Port of the corresponding slice of
/// routes/productionnexus.js (mounted at /api/productionnexus in Node —
/// same URL prefix kept here, distinct from routes/production.js's
/// /api/production legacy-archive reads, not yet ported — see
/// dotnet/CLAUDE.md's Phase 6 notes).
///
/// Class-level Dept:production tightens Node's complete absence of a
/// department gate on this router (requireLogin only) — same precedent
/// every earlier phase set. GetHistory/GetTraceChain additionally require
/// Perm:PROD_SUPERVISOR — Node's own HTML places both the Traceability and
/// Batch History tiles inside its PROD_SUPERVISOR-gated Supervisor section,
/// but neither route actually checks it server-side (a real gap research
/// found); closing it matches the UI's own evident intent and the "API's
/// 403 is the real gate either way" principle already established.
/// </summary>
[Route("api/productionnexus")]
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
public sealed class ProductionNexusController(INexusOperationsDb nexusOperationsDb, ISapServerClient sapServerClient, IAuditLogger auditLogger) : NexusControllerBase
{
    [HttpPost("mixing/entry")]
    public async Task<IActionResult> MixingEntry([FromBody] MixingEntryRequest body, CancellationToken ct)
    {
        var result = await MixingHelper.EnterAsync(nexusOperationsDb, sapServerClient, auditLogger, body, GetUsername(), GetIpAddress(), GetUserId(), ct);
        return StatusCode(201, ApiResponse<MixingEntryResult>.Ok(result));
    }

    [HttpGet("mixing/staging/queue")]
    public async Task<IActionResult> BilletStagingQueue(CancellationToken ct)
    {
        var rows = await BilletStagingHelper.GetQueueAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<BilletStagingQueueRow>>.Ok(rows));
    }

    [HttpPatch("mixing/tubs/{tubId:int}/stage")]
    public async Task<IActionResult> StageTub(int tubId, CancellationToken ct)
    {
        var result = await BilletStagingHelper.StageAsync(nexusOperationsDb, tubId, GetUserId(), ct);
        return Ok(ApiResponse<StageTubResult>.Ok(result));
    }

    [HttpPatch("mixing/tubs/stage-by-ref")]
    public async Task<IActionResult> StageTubByRef([FromBody] StageByRefRequest body, CancellationToken ct)
    {
        var result = await BilletStagingHelper.StageByRefAsync(nexusOperationsDb, body, GetUserId(), ct);
        return Ok(ApiResponse<StageTubResult>.Ok(result));
    }

    [HttpPost("mixing/tubs/{tubId:int}/return-to-conditioning")]
    public async Task<IActionResult> ReturnToConditioning(int tubId, [FromBody] ReturnToConditioningRequest body, CancellationToken ct)
    {
        var result = await BilletStagingHelper.ReturnToConditioningAsync(nexusOperationsDb, tubId, body, GetUserId(), ct);
        return Ok(ApiResponse<ReturnToConditioningResult>.Ok(result));
    }

    [HttpGet("mixing/tubs/search")]
    public async Task<IActionResult> SearchTubs([FromQuery] string? q, CancellationToken ct)
    {
        var rows = await BilletStagingHelper.SearchTubsAsync(nexusOperationsDb, q, ct);
        return Ok(ApiResponse<IReadOnlyList<TubSearchRow>>.Ok(rows));
    }

    [HttpPost("process/{processCode}/entry")]
    public async Task<IActionResult> MetreProcessEntry(string processCode, [FromBody] MetreProcessEntryRequest body, CancellationToken ct)
    {
        var result = await MetreProcessHelper.EnterAsync(processCode, nexusOperationsDb, sapServerClient, auditLogger, body, GetUsername(), GetIpAddress(), GetUserId(), ct);
        return StatusCode(201, ApiResponse<MetreProcessEntryResult>.Ok(result));
    }

    [HttpPost("process/{processCode}/draft")]
    public async Task<IActionResult> MetreProcessDraft(string processCode, [FromBody] MetreDraftRequest body, CancellationToken ct)
    {
        var result = await MetreProcessHelper.DraftAsync(processCode, nexusOperationsDb, sapServerClient, body, GetUserId(), ct);
        return StatusCode(201, ApiResponse<MetreDraftResult>.Ok(result));
    }

    [HttpPost("process/{processCode}/complete/{recordId:int}")]
    public async Task<IActionResult> MetreProcessComplete(string processCode, int recordId, [FromBody] MetreCompleteRequest body, CancellationToken ct)
    {
        var result = await MetreProcessHelper.CompleteAsync(processCode, recordId, nexusOperationsDb, sapServerClient, auditLogger, body, GetUsername(), GetIpAddress(), GetUserId(), ct);
        return Ok(ApiResponse<MetreCompleteResult>.Ok(result));
    }

    [HttpPost("drumming/stock")]
    public async Task<IActionResult> DrummingStock([FromBody] DrummingSubmitRequest body, CancellationToken ct)
    {
        var result = await DrummingHelper.SubmitAsync(nexusOperationsDb, sapServerClient, auditLogger, "stock", body, GetUsername(), GetIpAddress(), GetUserId(), ct);
        return StatusCode(result.Status == "BLOCKED" ? 409 : 201,
            result.Status == "BLOCKED"
                ? new ApiResponse<DrummingSubmitResult>(false, result, new ApiError("BLOCKED", result.Error ?? "Blocked."))
                : ApiResponse<DrummingSubmitResult>.Ok(result));
    }

    [HttpPost("drumming/customer")]
    public async Task<IActionResult> DrummingCustomer([FromBody] DrummingSubmitRequest body, CancellationToken ct)
    {
        var result = await DrummingHelper.SubmitAsync(nexusOperationsDb, sapServerClient, auditLogger, "customer", body, GetUsername(), GetIpAddress(), GetUserId(), ct);
        return StatusCode(result.Status == "BLOCKED" ? 409 : 201,
            result.Status == "BLOCKED"
                ? new ApiResponse<DrummingSubmitResult>(false, result, new ApiError("BLOCKED", result.Error ?? "Blocked."))
                : ApiResponse<DrummingSubmitResult>.Ok(result));
    }

    [HttpGet("process/{processCode}/open-entries")]
    public async Task<IActionResult> MetreProcessOpenEntries(string processCode, CancellationToken ct)
    {
        var rows = await MetreProcessHelper.GetOpenEntriesAsync(processCode, nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<OpenEntryRow>>.Ok(rows));
    }

    [HttpGet("process/{processCode}/data")]
    public async Task<IActionResult> MetreProcessData(string processCode, [FromQuery] MetreProcessDataQuery query, CancellationToken ct)
    {
        var rows = await MetreProcessHelper.GetDataAsync(processCode, nexusOperationsDb, query, ct);
        return Ok(ApiResponse<IReadOnlyList<MetreProcessDataRow>>.Ok(rows));
    }

    [HttpGet("open-runs")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> OpenRuns(CancellationToken ct)
    {
        var rows = await MetreProcessHelper.GetOpenRunsAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<OpenRunRow>>.Ok(rows));
    }

    [HttpPatch("open-runs/{processCode}/{recordId:int}/cancel")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> CancelOpenRun(string processCode, int recordId, [FromBody] CancelOpenRunRequest body, CancellationToken ct)
    {
        await MetreProcessHelper.CancelOpenRunAsync(processCode, recordId, nexusOperationsDb, body, GetUserId(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("reports/output")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReportOutput([FromQuery] ReportFilterQuery query, CancellationToken ct)
    {
        var result = await ProductionReportsHelper.GetOutputAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<ReportOutputResult>.Ok(result));
    }

    [HttpGet("reports/scrap")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReportScrap([FromQuery] ReportFilterQuery query, CancellationToken ct)
    {
        var result = await ProductionReportsHelper.GetScrapAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<ReportScrapResult>.Ok(result));
    }

    [HttpGet("reports/sap-performance")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReportSapPerformance([FromQuery] ReportFilterQuery query, CancellationToken ct)
    {
        var result = await ProductionReportsHelper.GetSapPerformanceAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<ReportSapPerfResult>.Ok(result));
    }

    [HttpGet("reports/batches")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReportBatches([FromQuery] ReportFilterQuery query, CancellationToken ct)
    {
        var rows = await ProductionReportsHelper.GetBatchesAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<IReadOnlyList<ReportBatchStatusRow>>.Ok(rows));
    }

    [HttpGet("reports/shift-comparison")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReportShiftComparison([FromQuery] ReportFilterQuery query, CancellationToken ct)
    {
        var result = await ProductionReportsHelper.GetShiftComparisonAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<ReportShiftResult>.Ok(result));
    }

    [HttpGet("reports/operator-output")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReportOperatorOutput([FromQuery] ReportFilterQuery query, CancellationToken ct)
    {
        var rows = await ProductionReportsHelper.GetOperatorOutputAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<IReadOnlyList<ReportOperatorOutputRow>>.Ok(rows));
    }

    [HttpGet("reports/material-output")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReportMaterialOutput([FromQuery] ReportFilterQuery query, CancellationToken ct)
    {
        var rows = await ProductionReportsHelper.GetMaterialOutputAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<IReadOnlyList<ReportMaterialOutputRow>>.Ok(rows));
    }

    [HttpGet("history")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> GetHistory([FromQuery] BatchHistoryQuery query, CancellationToken ct)
    {
        var rows = await ProductionHelper.GetHistoryAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<IReadOnlyList<BatchHistoryRow>>.Ok(rows));
    }

    [HttpPost("trace")]
    public async Task<IActionResult> AddTraceLink([FromBody] TraceLinkCreateRequest body, CancellationToken ct)
    {
        await ProductionHelper.AddTraceLinkAsync(nexusOperationsDb, body, GetUsername(), GetUserId(), ct);
        return StatusCode(201, ApiResponse<object?>.Ok(null));
    }

    [HttpGet("trace/{processCode}/{recordId:int}")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> GetTraceChain(string processCode, int recordId, CancellationToken ct)
    {
        var result = await ProductionHelper.GetTraceChainAsync(nexusOperationsDb, processCode, recordId, ct);
        return Ok(ApiResponse<TraceChainResult>.Ok(result));
    }

    [HttpGet("scrap-reasons")]
    public async Task<IActionResult> ScrapReasons([FromQuery] string? pc, CancellationToken ct)
    {
        var rows = await ScrapHelper.GetReasonsAsync(nexusOperationsDb, pc, ct);
        return Ok(ApiResponse<IReadOnlyList<ScrapReasonRow>>.Ok(rows));
    }

    [HttpGet("scrap/summary")]
    public async Task<IActionResult> ScrapSummary(CancellationToken ct)
    {
        var rows = await ScrapHelper.GetSummaryAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<ScrapSummaryRow>>.Ok(rows));
    }

    [HttpGet("scrap/failed")]
    public async Task<IActionResult> ScrapFailed(CancellationToken ct)
    {
        var rows = await ScrapHelper.GetFailedAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<ScrapFailedRow>>.Ok(rows));
    }

    [HttpGet("scrap/pending")]
    public async Task<IActionResult> ScrapPending(CancellationToken ct)
    {
        var rows = await ScrapHelper.GetPendingAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<ScrapPendingRow>>.Ok(rows));
    }

    [HttpGet("scrap/entries")]
    public async Task<IActionResult> ScrapEntries([FromQuery] string? processCode, [FromQuery] int? processRecordId, [FromQuery] string? reasonCode, CancellationToken ct)
    {
        var rows = await ScrapHelper.GetEntriesAsync(nexusOperationsDb, processCode, processRecordId, reasonCode, ct);
        return Ok(ApiResponse<IReadOnlyList<ScrapEntryRow>>.Ok(rows));
    }

    [HttpPatch("scrap/{scrapId:int}/retry")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ScrapRetry(int scrapId, [FromBody] ScrapRetryRequest body, CancellationToken ct)
    {
        var result = await ScrapHelper.RetryAsync(nexusOperationsDb, sapServerClient, auditLogger, scrapId, body, GetUsername(), GetIpAddress(), GetUserId(), ct);
        return Ok(ApiResponse<ScrapRetryResult>.Ok(result));
    }

    [HttpPost("scrap/approve")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ScrapApprove([FromBody] ScrapBulkRequest body, CancellationToken ct)
    {
        if (body.ScrapIds is not { Length: > 0 })
            throw new NexusValidationException("scrapIds array required.");
        var results = await ScrapHelper.ApproveAsync(nexusOperationsDb, sapServerClient, auditLogger, body.ScrapIds, GetUsername(), GetIpAddress(), GetUserId(), ct);
        return Ok(ApiResponse<IReadOnlyList<ScrapBulkItemResult>>.Ok(results));
    }

    [HttpPost("scrap/reject")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ScrapReject([FromBody] ScrapBulkRequest body, CancellationToken ct)
    {
        if (body.ScrapIds is not { Length: > 0 })
            throw new NexusValidationException("scrapIds array required.");
        var results = await ScrapHelper.RejectAsync(nexusOperationsDb, auditLogger, body.ScrapIds, GetUsername(), GetIpAddress(), GetUserId(), ct);
        return Ok(ApiResponse<IReadOnlyList<ScrapBulkItemResult>>.Ok(results));
    }

    [HttpGet("scrap/{scrapId:int}/documents")]
    public async Task<IActionResult> ScrapDocuments(int scrapId, CancellationToken ct)
    {
        var rows = await ScrapHelper.GetDocumentsAsync(nexusOperationsDb, scrapId, ct);
        return Ok(ApiResponse<IReadOnlyList<ScrapDocumentRow>>.Ok(rows));
    }

    [HttpGet("reversal/search")]
    public async Task<IActionResult> ReversalSearch([FromQuery] string? materialDocument, CancellationToken ct)
    {
        var rows = await ReversalHelper.SearchAsync(nexusOperationsDb, materialDocument, ct);
        return Ok(ApiResponse<IReadOnlyList<SapPostingRow>>.Ok(rows));
    }

    [HttpGet("reversal/by-batch/{processCode}/{recordId:int}")]
    public async Task<IActionResult> ReversalByBatch(string processCode, int recordId, CancellationToken ct)
    {
        var rows = await ReversalHelper.GetByBatchAsync(nexusOperationsDb, processCode, recordId, ct);
        return Ok(ApiResponse<IReadOnlyList<SapPostingByBatchRow>>.Ok(rows));
    }

    [HttpGet("reversal/find")]
    public async Task<IActionResult> ReversalFind([FromQuery] ReversalFindQuery query, CancellationToken ct)
    {
        var rows = await ReversalHelper.FindAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<IReadOnlyList<SapPostingFindRow>>.Ok(rows));
    }

    [HttpPatch("reversal/{sapPostingId:int}")]
    public async Task<IActionResult> ReversalMark(int sapPostingId, [FromBody] ReversalMarkRequest body, CancellationToken ct)
    {
        await ReversalHelper.MarkReversedAsync(nexusOperationsDb, sapServerClient, sapPostingId, body, GetUserId(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("reversal/execute")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReversalExecute([FromBody] ReversalExecuteRequest body, CancellationToken ct)
    {
        var result = await ReversalHelper.ExecuteAsync(sapServerClient, auditLogger, body.MaterialDocument, GetUsername(), GetIpAddress(), GetUserId(), ct);
        return Ok(ApiResponse<ReversalExecuteResult>.Ok(result));
    }

    [HttpPost("reversal/bulk")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReversalBulk([FromBody] ReversalBulkRequest body, CancellationToken ct)
    {
        if (body.MaterialDocuments is not { Length: > 0 })
            throw new NexusValidationException("materialDocuments array required.");
        var results = await ReversalHelper.BulkReverseAsync(nexusOperationsDb, sapServerClient, auditLogger, body.MaterialDocuments, GetUsername(), GetIpAddress(), GetUserId(), ct);
        return Ok(ApiResponse<IReadOnlyList<ReversalBulkItemResult>>.Ok(results));
    }

    [HttpGet("scrap-reversal/missed")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ScrapReversalMissed(CancellationToken ct)
    {
        var rows = await ScrapReversalHelper.GetMissedAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<ScrapDocSearchRow>>.Ok(rows));
    }

    [HttpGet("scrap-reversal/search")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ScrapReversalSearch([FromQuery] ScrapReversalSearchQuery query, CancellationToken ct)
    {
        var rows = await ScrapReversalHelper.SearchAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<IReadOnlyList<ScrapDocSearchRow>>.Ok(rows));
    }

    [HttpPost("scrap-reversal/reverse")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ScrapReversalReverse([FromBody] ScrapReversalReverseRequest body, CancellationToken ct)
    {
        var result = await ScrapReversalHelper.ReverseAsync(nexusOperationsDb, sapServerClient, auditLogger, body, GetUsername(), GetIpAddress(), GetUserId(), ct);
        return Ok(ApiResponse<ScrapReversalReverseResult>.Ok(result));
    }

    [HttpPost("scrap-reversal/reverse/bulk")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ScrapReversalReverseBulk([FromBody] ScrapReversalBulkRequest body, CancellationToken ct)
    {
        if (body.Items is not { Length: > 0 })
            throw new NexusValidationException("items array required.");
        var results = await ScrapReversalHelper.BulkReverseAsync(nexusOperationsDb, sapServerClient, auditLogger, body.Items, GetUsername(), GetIpAddress(), GetUserId(), ct);
        return Ok(ApiResponse<IReadOnlyList<ScrapReversalBulkItemResult>>.Ok(results));
    }

    [HttpGet("process/{processCode}/bom-preview")]
    public async Task<IActionResult> BomPreview(string processCode, [FromQuery] string? material, CancellationToken ct)
    {
        var rows = await BomHelper.GetBomPreviewAsync(sapServerClient, processCode.ToUpperInvariant(), material, GetUserId(), ct);
        return Ok(ApiResponse<IReadOnlyList<BomRow>>.Ok(rows));
    }

    [HttpGet("process/{processCode}/{recordId:int}/bom")]
    public async Task<IActionResult> GetBom(string processCode, int recordId, CancellationToken ct)
    {
        var rows = await BomHelper.GetLatestBomAsync(nexusOperationsDb, processCode.ToUpperInvariant(), recordId, ct);
        return Ok(ApiResponse<IReadOnlyList<BomRow>>.Ok(rows));
    }

    [HttpPost("process/{processCode}/{recordId:int}/bom/refresh")]
    public async Task<IActionResult> RefreshBom(string processCode, int recordId, CancellationToken ct)
    {
        var result = await BomHelper.RefreshBomAsync(nexusOperationsDb, sapServerClient, processCode.ToUpperInvariant(), recordId, GetUserId(), ct);
        return Ok(ApiResponse<BomRefreshResult>.Ok(result));
    }

    [HttpGet("process/{processCode}/{recordId:int}/trace")]
    public async Task<IActionResult> GetParentBatchLinks(string processCode, int recordId, CancellationToken ct)
    {
        var rows = await BomHelper.GetParentBatchLinksAsync(nexusOperationsDb, processCode.ToUpperInvariant(), recordId, ct);
        return Ok(ApiResponse<IReadOnlyList<ParentBatchLink>>.Ok(rows));
    }

    [HttpGet("process/{processCode}/{recordId:int}/raw-material-batches")]
    public async Task<IActionResult> GetRawMaterialBatches(string processCode, int recordId, CancellationToken ct)
    {
        var rows = await BomHelper.GetRawMaterialBatchesAsync(nexusOperationsDb, processCode.ToUpperInvariant(), recordId, ct);
        return Ok(ApiResponse<IReadOnlyList<RawMaterialBatchRow>>.Ok(rows));
    }

    [HttpPost("process/{processCode}/{recordId:int}/raw-material-batch")]
    public async Task<IActionResult> AddRawMaterialBatch(string processCode, int recordId, [FromBody] AddRawMaterialBatchRequest body, CancellationToken ct)
    {
        await BomHelper.AddRawMaterialBatchAsync(nexusOperationsDb, processCode.ToUpperInvariant(), recordId, body, GetUserId(), ct);
        return StatusCode(201, ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("process/{processCode}/{recordId:int}/raw-material-batch/{batchId:int}")]
    public async Task<IActionResult> DeleteRawMaterialBatch(string processCode, int recordId, int batchId, CancellationToken ct)
    {
        var affected = await BomHelper.DeleteRawMaterialBatchAsync(nexusOperationsDb, batchId, ct);
        if (affected == 0) throw new NexusNotFoundException("Batch entry not found.");
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("process/{processCode}/{recordId:int}/concession")]
    public async Task<IActionResult> RaiseConcession(string processCode, int recordId, [FromBody] RaiseConcessionRequest body, CancellationToken ct)
    {
        var result = await BomHelper.RaiseConcessionAsync(nexusOperationsDb, processCode.ToUpperInvariant(), recordId, body, GetUserId(), ct);
        return StatusCode(201, ApiResponse<RaiseConcessionResult>.Ok(result));
    }
}
