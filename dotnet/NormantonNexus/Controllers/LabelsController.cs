using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Production labels — port of routes/labels.js's Production-relevant
/// routes (browser preview, printer selection, server-side print). Mounted
/// at api/labels (not api/productionnexus), matching Node's own separate
/// router mount (app.use('/api/labels', requireLogin, labelsRoutes)) —
/// deliberately NOT department-gated, matching Node exactly: no route in
/// labels.js checks department or a permission code, only that the caller
/// is logged in at all (this controller's [Authorize] on
/// NexusControllerBase already covers that, with no further Dept:/Perm:
/// policy added on top).
///
/// GET /pallet/scan/:id, GET /pallet/finish/:id and their /print siblings
/// are out of scope — Warehouse/Logistics pallet-builder concerns, not
/// Production, confirmed during the Phase 6 scope review before any of
/// labels.js was read line-by-line.
/// </summary>
[Route("api/labels")]
public sealed class LabelsController(
    INexusOperationsDb nexusOperationsDb, INexusDb nexusDb, IOptions<LabelPrinterOptions> printerOptions) : NexusControllerBase
{
    [HttpGet("process/{processCode}/{recordId:int}")]
    public async Task<IActionResult> PreviewProcess(string processCode, int recordId, [FromQuery] int? tub, CancellationToken ct)
    {
        var code = processCode.ToUpperInvariant();
        if (!LabelDataHelper.SupportedProcessCodes.Contains(code))
            throw new NexusValidationException($"Label not supported for {code}.");
        if (recordId <= 0)
            throw new NexusValidationException("Invalid record ID.");

        IReadOnlyList<LabelData> labels = code == "MX"
            ? await LabelDataHelper.FetchMixingTicketsDataAsync(nexusOperationsDb, recordId, tub, ct)
            : [await LabelDataHelper.FetchLabelDataAsync(nexusOperationsDb, code, recordId, ct)];

        var html = LabelHtmlHelper.RenderPage(labels);
        Response.Headers.CacheControl = "no-store";
        return Content(html, "text/html; charset=utf-8");
    }

    [HttpGet("printers")]
    public async Task<IActionResult> GetPrinters(CancellationToken ct)
    {
        var result = await LabelPrintHelper.GetPrintersAsync(nexusDb, printerOptions, GetUserId(), ct);
        return Ok(ApiResponse<PrintersListResult>.Ok(result));
    }

    [HttpPatch("printers/default")]
    public async Task<IActionResult> SetDefaultPrinter([FromBody] SetDefaultPrinterRequest body, CancellationToken ct)
    {
        await LabelPrintHelper.SetDefaultPrinterAsync(nexusDb, GetUserId(), body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("process/{processCode}/{recordId:int}/print")]
    public async Task<IActionResult> PrintProcess(string processCode, int recordId, [FromBody] PrintLabelRequest body, CancellationToken ct)
    {
        var result = await LabelPrintHelper.PrintAsync(nexusOperationsDb, printerOptions, processCode, recordId, body, ct);
        return Ok(ApiResponse<PrintLabelResult>.Ok(result));
    }
}
