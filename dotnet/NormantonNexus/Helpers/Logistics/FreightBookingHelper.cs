using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Kuehne+Nagel freight booking — Logistics Sub-phase 8c.3. Port of
/// routes/freightbooking.js in full: creates a KN booking for a shipment
/// (cargoItems from either its linked PalletMain records or, for a Manual
/// Outbound Shipment, its ManualCargoItem rows) and uploads the confirmed
/// invoice/packing-list/customs documents against that booking afterward.
/// UNVERIFIED against a live KN sandbox or real credentials — see
/// KuehneNagelClient's own header comment.
/// </summary>
internal static class FreightBookingHelper
{
    private static readonly Dictionary<string, string> KnDocumentCodes = new(StringComparer.Ordinal)
    {
        ["packing-list"] = "271",
        ["invoice"] = "380",
        ["customs"] = "944",
    };

    // ── Build KN cargoItems from either source ────────────────────────

    internal static List<KnCargoItem> MapPalletsToCargoItems(IReadOnlyList<ShipmentContextPalletRow> pallets) =>
        pallets.Select(p => new KnCargoItem(
            Description: string.IsNullOrWhiteSpace(p.PalletType) ? "Pallet" : p.PalletType!,
            MarksAndNumbers: p.PalletId.ToString(),
            Stackable: false,
            PackageCount: 1,
            PackageType: "PLT",
            Weight: p.GrossWeight,
            WeightUom: "KGM",
            Volume: p.PalletVolume,
            VolumeUom: "MTQ",
            DimensionLength: (p.PalletLength ?? 0) * 10,
            DimensionWidth: (p.PalletWidth ?? 0) * 10,
            DimensionHeight: (p.PalletHeight ?? 0) * 10,
            DimensionsUom: "MMT")).ToList();

    internal static List<KnCargoItem> MapManualCargoToCargoItems(IReadOnlyList<ManualCargoItemRow> rows) =>
        rows.Select(r => new KnCargoItem(
            Description: string.IsNullOrWhiteSpace(r.Description) ? "Cargo" : r.Description!,
            MarksAndNumbers: r.CargoId.ToString(),
            Stackable: false,
            PackageCount: r.PackageCount > 0 ? r.PackageCount : 1,
            PackageType: "PKG",
            Weight: r.Weight,
            WeightUom: "KGM",
            Volume: r.Volume ?? 0,
            VolumeUom: "MTQ",
            DimensionLength: (r.Length ?? 0) * 10,
            DimensionWidth: (r.Width ?? 0) * 10,
            DimensionHeight: (r.Height ?? 0) * 10,
            DimensionsUom: "MMT")).ToList();

    // ── Build KN booking payload from DB records ──────────────────────

    internal static KnBookingPayload BuildBookingPayload(ShipmentRow shipment, List<KnCargoItem> cargoItems, KuehneNagelOptions options, DateTime? plannedCollectionOverride)
    {
        var pickupDate = (plannedCollectionOverride ?? shipment.PlannedCollection)?.ToString("yyyy-MM-dd");
        var originAddress = new KnAddress(shipment.OriginName ?? "", shipment.OriginStreet ?? "", shipment.OriginCity ?? "", shipment.OriginPostCode ?? "", shipment.OriginCountry ?? "");
        var destinationAddress = new KnAddress(shipment.DestinationName ?? "", shipment.DestinationStreet ?? "", shipment.DestinationCity ?? "", shipment.DestinationPostCode ?? "", shipment.DestinationCountry ?? "");

        return new KnBookingPayload(
            CustomerId: options.CustomerId,
            CustomerKey: options.CustomerKey,
            BookingFlags: KnBookingFlags.AllFalse,
            BookingOptions: [],
            DangerousGoodsPackageCount: 0,
            Incoterm: new KnIncoterm(shipment.IncoTerms ?? "", ""),
            ShipperParty: new KnShipperParty(originAddress, [new KnPartyReference(shipment.ShipmentId.ToString(), "ABO")]),
            ConsigneeParty: new KnConsigneeParty(destinationAddress),
            PickupLocation: new KnPickupLocation(originAddress, pickupDate),
            DeliveryLocation: new KnDeliveryLocation(destinationAddress),
            CargoItems: cargoItems);
    }

    /// <summary>Masks customerKey the same way the document-upload payload's redaction does — requestPayload is echoed back to the browser (so an operator can check the booking that was actually sent) but the raw KN secret must never leave the server to do that.</summary>
    internal static string MaskCustomerKey(string? key) =>
        string.IsNullOrEmpty(key) || key.Length <= 8 ? key ?? "" : $"{key[..4]}...{key[^4..]}";

    internal static KnBookingPayload RedactBookingPayload(KnBookingPayload payload) =>
        payload with { CustomerKey = MaskCustomerKey(payload.CustomerKey) };

    private static readonly string[] TrackingNumberKeys = ["trackingNumber", "trackingNo", "consignmentNumber", "consignmentNo", "shipmentNumber", "bookingID", "transactionID"];

    /// <summary>First non-blank value across KN's several possible identifier field names, in the same priority order Node's own extractTrackingNumber checks.</summary>
    internal static string ExtractTrackingNumber(Dictionary<string, object?>? responseData)
    {
        if (responseData is null) return "";
        foreach (var key in TrackingNumberKeys)
        {
            var s = GetString(responseData, key);
            if (!string.IsNullOrEmpty(s)) return s.Trim();
        }
        return "";
    }

    // ── Orchestration: create a booking ────────────────────────────────

    internal static async Task<CreateBookingResult> CreateBookingAsync(
        INexusOperationsDb db, IKuehneNagelClient kn, KuehneNagelOptions options, long shipmentId, DateTime? plannedCollectionOverride, CancellationToken ct)
    {
        if (options.ApiUrl.Length == 0 || options.CustomerId.Length == 0 || options.CustomerKey.Length == 0)
            throw new KuehneNagelException("Freight booking is not configured. Check KuehneNagel:ApiUrl/CustomerId/CustomerKey in appsettings.");

        using var connection = await db.CreateConnectionAsync(ct);
        var context = await ShipmentHelper.GetShipmentContextAsync(connection, shipmentId, ct);

        List<KnCargoItem> cargoItems;
        if (context.Shipment.IsManual)
        {
            if (context.ManualCargo.Count == 0)
                throw new NexusUnprocessableEntityException($"No cargo lines found for manual shipment {shipmentId}.");
            cargoItems = MapManualCargoToCargoItems(context.ManualCargo);
        }
        else
        {
            if (context.Pallets.Count == 0)
                throw new NexusUnprocessableEntityException($"No pallets found linked to shipment {shipmentId}.");
            cargoItems = MapPalletsToCargoItems(context.Pallets);
        }

        var payload = BuildBookingPayload(context.Shipment, cargoItems, options, plannedCollectionOverride);
        var accessToken = await kn.GetAccessTokenAsync(ct);
        var response = await kn.CreateBookingAsync(payload, accessToken, ct);

        // KN's BookingResponse schema requires bookingIsSuccessful/errorMessage alongside
        // a 2xx status — KN can return an HTTP success with bookingIsSuccessful: false and
        // an errorMessage rather than an HTTP error status, and that has to be checked
        // explicitly or it would be recorded here as a successful booking.
        if (GetBool(response, "bookingIsSuccessful") == false)
            throw new NexusUnprocessableEntityException(GetString(response, "errorMessage") ?? "KN reported the booking as unsuccessful.");

        return new CreateBookingResult(
            "Booking created successfully", shipmentId, GetString(response, "bookingID"), GetString(response, "transactionID"),
            GetBool(response, "bookingIsSuccessful"), ExtractTrackingNumber(response), response, RedactBookingPayload(payload));
    }

    // ── Orchestration: upload booking documents ────────────────────────
    // Final step of the KN booking flow: once a booking has been placed and
    // a bookingID received, the confirmed invoice/packing-list/customs files
    // are pushed to KN against that booking. Uploads are attempted
    // independently and reported per-file: a failure here doesn't unwind the
    // booking, which has already happened. dryRun skips the actual POST (and
    // skips logging any ShipmentEvent) but still resolves the shipment's
    // export folder, stats each file on disk, and fetches a real OAuth token
    // — a bad fileName/category/token shows up in the preview instead of as
    // an opaque KN error.

    internal static async Task<UploadDocumentsToKnResult> UploadDocumentsToKnAsync(
        INexusOperationsDb db, IKuehneNagelClient kn, IOptions<LogisticsOptions> logisticsOptions, KuehneNagelOptions knOptions,
        long shipmentId, UploadDocumentsToKnRequest body, bool dryRun, CancellationToken ct)
    {
        if (knOptions.ApiUrl.Length == 0 || knOptions.CustomerId.Length == 0 || knOptions.CustomerKey.Length == 0)
            throw new KuehneNagelException("Freight booking is not configured. Check KuehneNagel:ApiUrl/CustomerId/CustomerKey in appsettings.");

        var bookingId = (body.BookingId ?? "").Trim();
        if (bookingId.Length == 0)
            throw new NexusValidationException("bookingID is required.");
        var requestedFiles = body.Files ?? [];
        if (requestedFiles.Count == 0)
            throw new NexusValidationException("At least one file is required.");

        using var connection = await db.CreateConnectionAsync(ct);
        var shipment = await ShipmentHelper.GetShipmentByIdAsync(connection, shipmentId, ct) ?? throw new NexusNotFoundException($"Shipment {shipmentId} not found.");
        var folder = ShipmentHelper.GetShipmentFolderInfo(shipment, logisticsOptions.Value);

        string? accessToken = null;
        string? authError = null;
        try
        {
            accessToken = await kn.GetAccessTokenAsync(ct);
        }
        catch (Exception ex)
        {
            authError = ex.Message;
            if (!dryRun) throw new KuehneNagelException($"Could not authenticate with Kuehne & Nagel: {ex.Message}");
        }

        var uploaded = new List<KnUploadedDocument>();
        var failed = new List<KnFailedDocument>();
        var preview = new List<KnDocumentUploadPreview>();

        foreach (var item in requestedFiles)
        {
            var fileName = Path.GetFileName((item.FileName ?? "").Trim());
            var category = (item.Category ?? "").Trim();
            KnDocumentCodes.TryGetValue(category, out var documentCode);
            if (fileName.Length == 0 || documentCode is null)
            {
                failed.Add(new KnFailedDocument(fileName.Length > 0 ? fileName : "(unnamed)", category, $"Unknown document category '{category}'."));
                continue;
            }

            var filePath = Path.Combine(folder.ShipmentPath, fileName);
            var documentExtension = Path.GetExtension(fileName).TrimStart('.').ToLowerInvariant();
            if (documentExtension.Length == 0) documentExtension = "pdf";

            if (dryRun)
            {
                preview.Add(BuildPreview(fileName, category, documentCode, documentExtension, filePath, bookingId, knOptions, accessToken, authError));
                continue;
            }

            try
            {
                var fileBytes = await File.ReadAllBytesAsync(filePath, ct);
                var payload = new KnDocumentUploadPayload(knOptions.CustomerId, knOptions.CustomerKey, documentCode, documentExtension, bookingId, Convert.ToBase64String(fileBytes));

                var response = await kn.UploadDocumentAsync(payload, accessToken!, ct);

                // KN can return HTTP 200 with uploadIsSuccessful: false and an errorMessage
                // rather than an HTTP error status — has to be checked explicitly or a
                // KN-side rejection would be silently recorded as a success.
                if (GetBool(response, "uploadIsSuccessful") == false)
                {
                    var error = GetString(response, "errorMessage") ?? "KN reported the upload as unsuccessful.";
                    failed.Add(new KnFailedDocument(fileName, category, error));
                    await SafeWriteEventAsync(connection, shipmentId, "KN_DOCUMENT_UPLOAD_FAILED", $"Failed to upload {fileName} ({category}) to KN booking {bookingId}: {error}", ct);
                    continue;
                }

                var documentId = GetString(response, "uploadConfirmationID") ?? GetString(response, "transactionID");
                uploaded.Add(new KnUploadedDocument(fileName, category, documentCode, documentId));
                await SafeWriteEventAsync(connection, shipmentId, "KN_DOCUMENT_UPLOAD",
                    $"Uploaded {fileName} ({category}, code {documentCode}) to KN booking {bookingId}{(documentId is not null ? $" — confirmation {documentId}" : "")}.", ct);
            }
            catch (Exception ex)
            {
                failed.Add(new KnFailedDocument(fileName, category, ex.Message));
                await SafeWriteEventAsync(connection, shipmentId, "KN_DOCUMENT_UPLOAD_FAILED", $"Failed to upload {fileName} ({category}) to KN booking {bookingId}: {ex.Message}", ct);
            }
        }

        return dryRun
            ? new UploadDocumentsToKnResult(true, true, bookingId, uploaded, failed, preview)
            : new UploadDocumentsToKnResult(uploaded.Count > 0, false, bookingId, uploaded, failed, preview);
    }

    private static KnDocumentUploadPreview BuildPreview(
        string fileName, string category, string documentCode, string documentExtension, string filePath, string bookingId,
        KuehneNagelOptions knOptions, string? accessToken, string? authError)
    {
        long? fileSizeBytes = null;
        string? fileError = null;
        if (File.Exists(filePath)) fileSizeBytes = new FileInfo(filePath).Length;
        else fileError = $"File not found at {filePath}.";

        return new KnDocumentUploadPreview(
            fileName, category, documentCode, documentExtension, filePath, fileSizeBytes, fileError,
            $"{knOptions.ApiUrl}/documents",
            new Dictionary<string, string>
            {
                ["Content-Type"] = "application/json",
                ["Accept"] = "application/problem+json",
                ["Authorization"] = accessToken is not null ? "Bearer <valid, fetched OK>" : $"<KN OAuth FAILED: {authError}>",
            },
            new Dictionary<string, object?>
            {
                ["customerId"] = knOptions.CustomerId,
                ["customerKey"] = MaskCustomerKey(knOptions.CustomerKey),
                ["documentCode"] = documentCode,
                ["documentExtension"] = documentExtension,
                ["bookingID"] = bookingId,
                ["base64EncodedDocument"] = fileSizeBytes is not null
                    ? $"<base64, ~{Math.Ceiling(fileSizeBytes.Value * 4 / 3.0)} chars, {fileSizeBytes} byte source file>"
                    : "<unavailable — file could not be read, see fileError>",
            });
    }

    private static async Task SafeWriteEventAsync(SqlConnection connection, long shipmentId, string category, string description, CancellationToken ct)
    {
        try { await ShipmentHelper.WriteShipmentEventAsync(connection, shipmentId, category, description, ct); }
        catch { /* matches Node's writeShipmentEvent(...).catch(() => {}) */ }
    }

    // ── Loose-JSON helpers (System.Text.Json.JsonElement unwrapping) ──

    private static bool? GetBool(Dictionary<string, object?>? data, string key)
    {
        if (data is null || !data.TryGetValue(key, out var v) || v is null) return null;
        return v switch
        {
            JsonElement { ValueKind: JsonValueKind.True } => true,
            JsonElement { ValueKind: JsonValueKind.False } => false,
            bool b => b,
            _ => null,
        };
    }

    private static string? GetString(Dictionary<string, object?>? data, string key)
    {
        if (data is null || !data.TryGetValue(key, out var v) || v is null) return null;
        var s = v switch
        {
            JsonElement { ValueKind: JsonValueKind.String } je => je.GetString() ?? "",
            JsonElement { ValueKind: JsonValueKind.Number } je => je.ToString(),
            JsonElement je => je.ToString(),
            _ => v.ToString() ?? "",
        };
        return s.Length > 0 ? s : null;
    }
}
