using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// French VAT / DDP Customs Report — Logistics Sub-phase 8c.2. Port of
/// routes/customsreport.js, mounted at api/customsreport (Node's exact
/// mount path — no dash, unlike api/customs-report-admin's Sub-phase 8c.1
/// sibling). Single stateless POST /generate: upload a Shipments-style
/// .xlsx extract, get back a finished CUSTOMS-format .xlsx.
/// </summary>
[Route("api/customsreport")]
[Authorize(Policy = "Perm:LOG_CUSTOMS_REPORT")]
public sealed class CustomsReportController(INexusOperationsDb nexusOperationsDb, ISapServerClient sapServerClient, IAuditLogger audit) : NexusControllerBase
{
    [HttpPost("generate")]
    public async Task<IActionResult> Generate(CancellationToken ct)
    {
        using var buffer = new MemoryStream();
        await Request.Body.CopyToAsync(buffer, ct);
        var fileBytes = buffer.ToArray();
        if (fileBytes.Length == 0)
            return StatusCode(400, new { success = false, error = new { message = "No file content received." } });

        try
        {
            var shipmentRows = CustomsReportHelper.ParseShipmentsUpload(fileBytes);
            if (shipmentRows.Count == 0)
                return StatusCode(400, new { success = false, error = new { message = "No data rows found in the uploaded file." } });

            var deliveryNumbers = shipmentRows.Select(r => r.PicksheetNumber).ToList();
            var sapData = await CustomsReportHelper.FetchSapDataAsync(sapServerClient, deliveryNumbers, GetUserId(), ct);
            var (rows, warnings) = await CustomsReportHelper.BuildReportRowsAsync(nexusOperationsDb, sapServerClient, shipmentRows, sapData, GetUserId(), ct);

            var weightByDelivery = new Dictionary<string, decimal>(StringComparer.Ordinal);
            foreach (var s in shipmentRows)
            {
                var key = CustomsReportHelper.Digits(s.PicksheetNumber);
                weightByDelivery[key] = weightByDelivery.GetValueOrDefault(key) + s.TotalWeight;
            }
            CustomsReportHelper.ApportionWeights(rows, weightByDelivery);

            var fileContent = CustomsReportHelper.BuildWorkbook(rows, warnings);
            var fileName = $"customs-report-{DateTime.UtcNow:yyyy-MM-dd}.xlsx";

            await audit.LogAsync("SAP_OK", GetUsername(),
                $"Customs report generated: {shipmentRows.Count} shipment row(s), {rows.Count} line(s), {warnings.Count} warning(s)", GetIpAddress(), ct);

            return File(fileContent, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName);
        }
        catch (Exception ex)
        {
            await audit.LogAsync("SAP_ERROR", GetUsername(), $"Customs report generation failed: {ex.Message}", GetIpAddress(), ct);
            throw;
        }
    }
}
