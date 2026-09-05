using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Quality;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Quality department — Stock Information + Traceability Concessions. Thin
/// JSON API layer over QualityHelper. Every action requires Dept:quality;
/// Display Stock has no additional permission gate (matches Node's current
/// live behavior — see QualityHelper.DisplayStockAsync). Block/Unblock/Bulk
/// additionally require the matching Perm:QUAL_* code.
/// </summary>
[Route("api/quality")]
[Authorize(Policy = "Dept:" + NexusDepartments.Quality)]
public sealed class QualityController(
    ISapServerClient sapServerClient,
    INexusOperationsDb nexusOperationsDb,
    IAuditLogger auditLogger,
    IAuthorizationService authorizationService) : NexusControllerBase
{
    private static readonly JsonSerializerOptions SseJsonOptions = new(JsonSerializerDefaults.Web);

    [HttpGet("display")]
    public async Task<IActionResult> DisplayStock(CancellationToken ct)
    {
        var rows = await QualityHelper.DisplayStockAsync(sapServerClient, ct);
        return Ok(ApiResponse<IReadOnlyList<StockRow>>.Ok(rows));
    }

    [HttpPost("block")]
    [Authorize(Policy = "Perm:" + QualityHelper.FnBlockStock)]
    public async Task<IActionResult> Block([FromBody] BlockUnblockRequest body, CancellationToken ct)
    {
        var result = await QualityHelper.BlockOrUnblockAsync(sapServerClient, auditLogger, "block", body, GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<QualityMb1bResponse>.Ok(result));
    }

    [HttpPost("unblock")]
    [Authorize(Policy = "Perm:" + QualityHelper.FnUnblockStock)]
    public async Task<IActionResult> Unblock([FromBody] BlockUnblockRequest body, CancellationToken ct)
    {
        var result = await QualityHelper.BlockOrUnblockAsync(sapServerClient, auditLogger, "unblock", body, GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<QualityMb1bResponse>.Ok(result));
    }

    /// <summary>
    /// Server-Sent-Events stream, one event per row — port of routes/quality.js's
    /// POST /bulk. The required permission depends on body.Direction (block vs
    /// unblock), which isn't known until the body is bound, so it's checked
    /// explicitly here rather than via a static [Authorize(Policy=...)].
    /// </summary>
    [HttpPost("bulk")]
    public async Task Bulk([FromBody] BulkBlockUnblockRequest body, CancellationToken ct)
    {
        if (body.Rows.Count == 0)
        {
            throw new NexusValidationException("No rows provided.");
        }
        if (body.Direction is not ("block" or "unblock"))
        {
            throw new NexusValidationException("Invalid direction.");
        }

        var requiredPolicy = "Perm:" + (body.Direction == "block" ? QualityHelper.FnBlockStock : QualityHelper.FnUnblockStock);
        var authResult = await authorizationService.AuthorizeAsync(User, requiredPolicy);
        if (!authResult.Succeeded)
        {
            Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";

        async Task SendAsync(BulkProgressEvent evt)
        {
            await Response.WriteAsync($"data: {JsonSerializer.Serialize(evt, SseJsonOptions)}\n\n", ct);
            await Response.Body.FlushAsync(ct);
        }

        var header = string.IsNullOrWhiteSpace(body.Header) ? "Bulk operation" : body.Header;
        var username = GetUsername();

        await SendAsync(new BulkProgressEvent("start", Total: body.Rows.Count));

        var done = 0;
        foreach (var row in body.Rows)
        {
            var result = await QualityHelper.RunBulkRowAsync(sapServerClient, body.Direction, row, header, username, ct);
            done++;
            await SendAsync(result with { Done = done, Total = body.Rows.Count });
        }

        await SendAsync(new BulkProgressEvent("complete", Total: body.Rows.Count));
    }

    [HttpGet("concessions")]
    [Authorize(Policy = "Perm:" + QualityHelper.FnTraceabilityConcession)]
    public async Task<IActionResult> ListConcessions([FromQuery] string? status, CancellationToken ct)
    {
        var normalized = string.IsNullOrWhiteSpace(status) ? "PENDING" : status.ToUpperInvariant();
        var rows = await QualityHelper.ListConcessionsAsync(nexusOperationsDb, normalized, ct);
        return Ok(ApiResponse<IReadOnlyList<ConcessionRow>>.Ok(rows));
    }

    [HttpPost("concessions/{id:int}/approve")]
    [Authorize(Policy = "Perm:" + QualityHelper.FnTraceabilityConcession)]
    public async Task<IActionResult> ApproveConcession(int id, [FromBody] ConcessionReviewRequest body, CancellationToken ct)
    {
        var result = await QualityHelper.ReviewConcessionAsync(nexusOperationsDb, id, "APPROVED", body.Notes, GetUserId(), ct);
        return Ok(ApiResponse<ConcessionRow>.Ok(result));
    }

    [HttpPost("concessions/{id:int}/reject")]
    [Authorize(Policy = "Perm:" + QualityHelper.FnTraceabilityConcession)]
    public async Task<IActionResult> RejectConcession(int id, [FromBody] ConcessionReviewRequest body, CancellationToken ct)
    {
        var result = await QualityHelper.ReviewConcessionAsync(nexusOperationsDb, id, "REJECTED", body.Notes, GetUserId(), ct);
        return Ok(ApiResponse<ConcessionRow>.Ok(result));
    }
}
