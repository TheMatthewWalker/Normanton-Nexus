using Dapper;
using Microsoft.Extensions.Options;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// ClearPort customs declaration submission — Logistics Sub-phase 8a.5c.
/// Port of routes/shipmentmain.js's POST /customs/create: for each
/// requested shipment, submits a ClearPort export declaration (skipped if
/// the shipment already has a saved customsID — a previous partial run's
/// declaration is reused rather than re-submitted), downloads the
/// resulting customs PDF into the shipment's export folder, and marks
/// customsComplete. Every shipment is processed independently — one
/// shipment's failure (blocked/ClearPort-rejected/SAP-data-missing) is
/// recorded in Failed and does not stop the rest of the batch, matching
/// Node's own per-shipment try/catch exactly.
/// </summary>
internal static class ShipmentCustomsHelper
{
    internal static async Task<CustomsCreateResult> CreateAsync(
        INexusOperationsDb db, ISapServerClient sap, IClearPortClient clearPort,
        IOptions<ClearPortOptions> clearPortOptions, IOptions<LogisticsOptions> logisticsOptions, IDataChangeLogService dataChangeLog,
        IReadOnlyList<long> shipmentIds, int userId, string? username, CancellationToken ct)
    {
        if (shipmentIds.Count == 0)
            throw new NexusValidationException("Select at least one shipment before creating customs entries.");

        var completed = new List<CustomsCreateCompleted>();
        var failed = new List<CustomsCreateFailed>();

        foreach (var shipmentId in shipmentIds)
        {
            try
            {
                using var connection = await db.CreateConnectionAsync(ct);
                var context = await ShipmentHelper.SyncShipmentAggregateDataAsync(connection, shipmentId, ct);
                var shipment = context.Shipment;

                if (shipment.ShipmentCancelled) throw new InvalidOperationException("Shipment is cancelled.");
                if (!shipment.CustomsRequired) throw new InvalidOperationException("Shipment is not marked as customs required.");
                if (shipment.CustomsComplete) throw new InvalidOperationException("Customs documents are already complete for this shipment.");

                var correlationId = (shipment.CustomsId ?? "").Trim();
                if (correlationId.Length == 0)
                {
                    var deliveryIds = context.Deliveries.Select(d => d.DeliveryId).ToList();
                    var sapData = await SapCustomsDataHelper.FetchAsync(sap, deliveryIds, userId, ct);
                    var payload = ClearPortShipmentPayloadHelper.Build(context, sapData, clearPortOptions.Value, logisticsOptions.Value);
                    correlationId = await clearPort.CreateExportAsync(payload, ct);
                }

                var pdfBytes = await clearPort.DownloadPdfAsync(correlationId, ct);
                var folder = ShipmentHelper.GetShipmentFolderInfo(shipment, logisticsOptions.Value);
                Directory.CreateDirectory(folder.ShipmentPath);
                var fileName = $"{folder.ShipmentRef}-customs-{ShipmentDocumentHelper.SanitizeFileSegment(correlationId)}.pdf";
                await File.WriteAllBytesAsync(Path.Combine(folder.ShipmentPath, fileName), pdfBytes, ct);

                await connection.ExecuteAsync(new CommandDefinition("""
                    UPDATE log.ShipmentMain SET customsID = @customsId, customsComplete = 1
                    WHERE shipmentID = @shipmentId AND ISNULL(shipmentCancelled, 0) = 0 AND ISNULL(customsRequired, 0) = 1
                    """, new { shipmentId, customsId = correlationId }, cancellationToken: ct));
                await dataChangeLog.StampAsync(username, "ShipmentMain", ct);

                completed.Add(new CustomsCreateCompleted(
                    shipmentId, folder.ShipmentRef, correlationId, fileName, $"/api/shipmentmain/{shipmentId}/documents/{Uri.EscapeDataString(fileName)}"));
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                failed.Add(new CustomsCreateFailed(shipmentId, ShipmentHelper.FormatShipmentRef(shipmentId), ex.Message));
            }
        }

        return new CustomsCreateResult(completed, failed, completed.Count);
    }
}
