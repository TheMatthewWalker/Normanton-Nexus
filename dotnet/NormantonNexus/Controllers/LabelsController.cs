using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Production label browser preview — port of the /process/:pc/:id slice
/// of routes/labels.js. Mounted at api/labels (not api/productionnexus),
/// matching Node's own separate router mount (app.use('/api/labels',
/// requireLogin, labelsRoutes)) — deliberately NOT department-gated,
/// matching Node exactly: no route in labels.js checks department or a
/// permission code, only that the caller is logged in at all (this
/// controller's [Authorize] on NexusControllerBase already covers that,
/// with no further Dept:/Perm: policy added on top).
///
/// SCOPE NOTE: only the HTML preview (GET, for window.print() in the
/// browser) is built here. Server-side PDF generation + raw-TCP printing
/// (POST .../print, needing QuestPDF + a barcode-in-PDF embed + a
/// TcpClient port) is a separate, not-yet-built slice — see
/// dotnet/CLAUDE.md's Phase 6 notes. GET /printers and PATCH
/// /printers/default are deferred alongside it, since they only serve
/// that print workflow (picking a target printer) — nothing in this port
/// would consume them yet.
/// </summary>
[Route("api/labels")]
public sealed class LabelsController(INexusOperationsDb nexusOperationsDb) : NexusControllerBase
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
}
