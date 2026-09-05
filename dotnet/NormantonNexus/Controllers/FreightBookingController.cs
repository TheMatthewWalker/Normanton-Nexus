using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Kuehne+Nagel freight booking — Logistics Sub-phase 8c.3. Port of
/// routes/freightbooking.js, mounted at api/freight-booking (Node's exact
/// mount). UNVERIFIED against a live KN sandbox or real credentials — see
/// FreightBookingHelper/KuehneNagelClient's own header comments.
/// </summary>
[Route("api/freight-booking")]
public sealed class FreightBookingController(INexusOperationsDb nexusOperationsDb, IKuehneNagelClient kn, Microsoft.Extensions.Options.IOptions<KuehneNagelOptions> knOptions, Microsoft.Extensions.Options.IOptions<LogisticsOptions> logisticsOptions) : NexusControllerBase
{
    /// <summary>No permission gate beyond being logged in — matches Node's own mount (requireLogin only, no requirePermission on this specific route).</summary>
    [HttpPost("shipment/{shipmentId:long}")]
    public async Task<IActionResult> CreateBooking(long shipmentId, [FromBody] CreateFreightBookingRequest? body, CancellationToken ct)
    {
        var result = await FreightBookingHelper.CreateBookingAsync(nexusOperationsDb, kn, knOptions.Value, shipmentId, body?.PlannedCollection, ct);
        return Ok(ApiResponse<CreateBookingResult>.Ok(result));
    }

    [HttpPost("{shipmentId:long}/documents/upload-to-kn")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> UploadDocumentsToKn(long shipmentId, [FromBody] UploadDocumentsToKnRequest body, [FromQuery] string? dryRun, CancellationToken ct)
    {
        var isDryRun = (dryRun ?? "").Trim().ToLowerInvariant() is "1" or "true" or "yes";
        var result = await FreightBookingHelper.UploadDocumentsToKnAsync(nexusOperationsDb, kn, logisticsOptions, knOptions.Value, shipmentId, body, isDryRun, ct);
        return Ok(ApiResponse<UploadDocumentsToKnResult>.Ok(result));
    }
}
