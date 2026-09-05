using System.Data;
using Dapper;
using Microsoft.Extensions.Options;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Inbound shipment tracking — Logistics Sub-phase 8b.4. Port of
/// routes/performance.js's /order-suggestions/shipments/* routes (list/
/// create/manual-create/detail/update/manual-items/documents folder-upload-
/// download/assign-shipment/cancel) + their performancesql.js backing
/// queries. Filesystem-only document handling here — the real-SAP goods-
/// receipt write (Mark Received/Undo Received, postGoodsReceiptToSap/
/// reverseGoodsReceiptToSap) is deferred to 8b.7.
///
/// insertInboundCostLine's `information` parameter is accepted by Node but
/// never actually written anywhere (the INSERT's column list never includes
/// it) — a genuine dead parameter in the original, not ported here rather
/// than perpetuated as a placebo (same "don't replicate an accidental no-op"
/// precedent as the deliberately-not-replicated env-var footguns in
/// ClearPortShipmentPayloadHelper's own header comment).
/// </summary>
internal static class InboundShipmentHelper
{
    private static readonly string[] MonthNames =
        ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

    private static readonly string[] AllowedDocumentExtensions =
        [".pdf", ".jpg", ".jpeg", ".png", ".docx", ".doc", ".xlsx", ".xls", ".msg", ".eml", ".txt", ".csv"];

    private sealed record ShipmentDetailHeaderRow(
        long ShipmentId, string ShipmentReference, DateTime? DispatchDate, DateTime? ExpectedEta,
        string? Haulier, long? ForwarderId, string? ModeOfTransport, string? TrackingNumber, string? BillOfLading, string? ContainerNumber,
        string? Notes, DateTime? ReceivedAtUtc, string? ReceivedBy, DateTime? CancelledAtUtc, string? CancelledBy,
        DateTime CreatedAtUtc, DateTime UpdatedAtUtc, bool IsManual, long? OriginDestinationId, string? OriginName);

    private sealed record ShipmentCancelledStatusRow(DateTime? CancelledAtUtc);

    // ── List / create / detail / update ──────────────────────────────────

    /// <summary>Ordered most-recent first, with a count of orders currently linked so the assign-shipment picker can show "N orders already on this load".</summary>
    internal static async Task<IReadOnlyList<OrderShipmentListRow>> ListShipmentsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<OrderShipmentListRow>(new CommandDefinition("""
            SELECT
              s.ShipmentId, s.ShipmentReference, s.DispatchDate, s.ExpectedEta,
              s.Haulier, s.ForwarderID AS ForwarderId, s.ModeOfTransport, s.TrackingNumber, s.BillOfLading, s.ContainerNumber,
              s.Notes, s.ReceivedAtUtc, s.ReceivedBy, s.CancelledAtUtc, s.CancelledBy,
              s.CreatedAtUtc, s.UpdatedAtUtc, s.IsManual, s.OriginName,
              (SELECT COUNT(*) FROM log.PurchaseOrderSuggestion p WHERE p.ShipmentId = s.ShipmentId) AS OrderCount,
              STUFF((SELECT DISTINCT ', ' + v.VendorName FROM log.PurchaseOrderSuggestion p2 JOIN log.Vendor v ON v.VendorId = p2.VendorId WHERE p2.ShipmentId = s.ShipmentId FOR XML PATH('')), 1, 2, '') AS Suppliers,
              STUFF((SELECT DISTINCT ', ' + p3.Material FROM log.PurchaseOrderSuggestion p3 WHERE p3.ShipmentId = s.ShipmentId FOR XML PATH('')), 1, 2, '') AS OrderMaterials,
              STUFF((SELECT DISTINCT ', ' + m.Material FROM log.ManualInboundItem m WHERE m.ShipmentId = s.ShipmentId AND m.Removed = 0 FOR XML PATH('')), 1, 2, '') AS ManualMaterials,
              STUFF((SELECT DISTINCT ', ' + p4.PoNumber FROM log.PurchaseOrderSuggestion p4 WHERE p4.ShipmentId = s.ShipmentId AND p4.PoNumber IS NOT NULL FOR XML PATH('')), 1, 2, '') AS PoNumbers,
              STUFF((SELECT DISTINCT ', ' + p5.SupplierReference FROM log.PurchaseOrderSuggestion p5 WHERE p5.ShipmentId = s.ShipmentId AND p5.SupplierReference IS NOT NULL FOR XML PATH('')), 1, 2, '') AS SupplierReferences
            FROM log.PurchaseOrderShipment s
            ORDER BY s.CreatedAtUtc DESC
            """, cancellationToken: ct));
        return rows.AsList();
    }

    /// <summary>forwarderID is looked up against log.Forwarders and its name stored into Haulier as a display snapshot. When forwarderID isn't supplied, the caller's free-text haulier is kept as-is.</summary>
    private static async Task<string?> ResolveForwarderNameAsync(IDbConnection connection, long? forwarderId, CancellationToken ct)
    {
        if (forwarderId is null) return null;
        return await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT forwarderName FROM log.Forwarders WHERE forwarderID = @forwarderId", new { forwarderId }, cancellationToken: ct));
    }

    /// <summary>Create-shipment-from-selected-lines, mirroring Open Deliveries — creation and line-assignment happen together. The reference is generated server-side, never supplied by the caller.</summary>
    internal static async Task<CreateOrderShipmentResult> CreateShipmentAsync(INexusOperationsDb db, IOptions<LogisticsOptions> options, CreateOrderShipmentRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var resolvedName = await ResolveForwarderNameAsync(connection, body.ForwarderId, ct);

        var shipmentId = await connection.QuerySingleAsync<long>(new CommandDefinition("""
            INSERT INTO log.PurchaseOrderShipment
              (DispatchDate, ExpectedEta, Haulier, ForwarderID, ModeOfTransport, TrackingNumber, BillOfLading, ContainerNumber, Notes)
            OUTPUT INSERTED.ShipmentId
            VALUES (@DispatchDate, @ExpectedEta, @haulier, @ForwarderId, @ModeOfTransport, @TrackingNumber, @BillOfLading, @ContainerNumber, @Notes)
            """, new { body.DispatchDate, body.ExpectedEta, haulier = resolvedName ?? body.Haulier, body.ForwarderId, body.ModeOfTransport, body.TrackingNumber, body.BillOfLading, body.ContainerNumber, body.Notes }, cancellationToken: ct));

        var shipmentReference = $"INB-{shipmentId:D6}";
        await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE log.PurchaseOrderShipment SET ShipmentReference = @shipmentReference WHERE ShipmentId = @shipmentId", new { shipmentId, shipmentReference }, cancellationToken: ct));

        var ids = body.SuggestionIds?.Where(id => id > 0).Distinct().ToList() ?? [];
        if (ids.Count > 0)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "UPDATE log.PurchaseOrderSuggestion SET ShipmentId = @shipmentId, UpdatedAtUtc = GETUTCDATE() WHERE SuggestionId IN @ids",
                new { shipmentId, ids }, cancellationToken: ct));
        }

        // Best-effort, non-blocking — the shipment already exists in the DB regardless of whether
        // the filesystem side succeeds.
        try { await AutoFileShipmentPoDocumentsAsync(connection, options.Value, shipmentId, ct); }
        catch { /* swallow — a PO PDF copy failing must never fail shipment creation */ }

        return new CreateOrderShipmentResult(shipmentId, shipmentReference, ids.Count);
    }

    /// <summary>A shipment not derived from any tracked-order selection (e.g. a customer return). If a price is supplied, one Associated Costs line is auto-created alongside it via InboundCostHelper.</summary>
    internal static async Task<CreateManualOrderShipmentResult> CreateManualShipmentAsync(INexusOperationsDb db, IOptions<LogisticsOptions> options, CreateManualOrderShipmentRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var resolvedForwarder = await ResolveForwarderNameAsync(connection, body.ForwarderId, ct);

        string? originName = null;
        if (body.OriginDestinationId is not null)
        {
            originName = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
                "SELECT destinationName FROM log.Destinations WHERE destinationID = @destinationId", new { destinationId = body.OriginDestinationId }, cancellationToken: ct));
        }

        var shipmentId = await connection.QuerySingleAsync<long>(new CommandDefinition("""
            INSERT INTO log.PurchaseOrderShipment
              (DispatchDate, ExpectedEta, Haulier, ForwarderID, ModeOfTransport, TrackingNumber, Notes, IsManual, OriginDestinationID, OriginName)
            OUTPUT INSERTED.ShipmentId
            VALUES (@DispatchDate, @ExpectedEta, @haulier, @ForwarderId, @ModeOfTransport, @TrackingNumber, @Notes, 1, @OriginDestinationId, @originName)
            """, new { body.DispatchDate, body.ExpectedEta, haulier = resolvedForwarder, body.ForwarderId, body.ModeOfTransport, body.TrackingNumber, body.Notes, body.OriginDestinationId, originName }, cancellationToken: ct));

        var shipmentReference = $"INB-{shipmentId:D6}";
        await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE log.PurchaseOrderShipment SET ShipmentReference = @shipmentReference WHERE ShipmentId = @shipmentId", new { shipmentId, shipmentReference }, cancellationToken: ct));

        InsertedCostLineResult? cost = null;
        if (body.Price is > 0)
        {
            cost = await InboundCostHelper.InsertLineAsync(connection, shipmentId, body.CostCentre, null, body.Tier, body.Price.Value, null, ct);
        }

        // Manual shipments have no linked tracked orders/POs to copy in, but eagerly creating the
        // folder here (rather than waiting for a first upload) means it's ready the moment someone
        // opens this shipment.
        try { await AutoFileShipmentPoDocumentsAsync(connection, options.Value, shipmentId, ct); }
        catch { }

        return new CreateManualOrderShipmentResult(shipmentId, shipmentReference, cost);
    }

    /// <summary>Inbound Log's shipment detail view — header fields plus every linked order line. A cancelled shipment always comes back with an empty orders array (CancelShipmentAsync unlinks every order from it).</summary>
    internal static async Task<OrderShipmentDetailResult?> GetShipmentDetailAsync(INexusOperationsDb db, long shipmentId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await GetShipmentDetailAsync(connection, shipmentId, ct);
    }

    private static async Task<OrderShipmentDetailResult?> GetShipmentDetailAsync(IDbConnection connection, long shipmentId, CancellationToken ct)
    {
        var shipment = await connection.QuerySingleOrDefaultAsync<ShipmentDetailHeaderRow?>(new CommandDefinition("""
            SELECT ShipmentId, ShipmentReference, DispatchDate, ExpectedEta,
                   Haulier, ForwarderID AS ForwarderId, ModeOfTransport, TrackingNumber, BillOfLading, ContainerNumber,
                   Notes, ReceivedAtUtc, ReceivedBy, CancelledAtUtc, CancelledBy, CreatedAtUtc, UpdatedAtUtc,
                   IsManual, OriginDestinationID AS OriginDestinationId, OriginName
            FROM log.PurchaseOrderShipment WHERE ShipmentId = @shipmentId
            """, new { shipmentId }, cancellationToken: ct));
        if (shipment is null) return null;

        var orders = await connection.QueryAsync<OrderShipmentDetailOrderRow>(new CommandDefinition("""
            SELECT p.SuggestionId, p.Material, t.MaterialText, t.Uom, v.VendorName, v.OrderMoqUom, p.OrderQty, p.ReceivedQty, p.Status, p.SupplierReference, p.PoNumber, p.PoItemNumber,
                   p.Notes, p.SapMaterialDocument, p.SapGrError, p.SapGrSkipped
            FROM log.PurchaseOrderSuggestion p
            JOIN log.Vendor v ON v.VendorId = p.VendorId
            LEFT JOIN log.TurnsValClassSnapshot t ON t.Material = p.Material
            WHERE p.ShipmentId = @shipmentId
            ORDER BY p.Material
            """, new { shipmentId }, cancellationToken: ct));

        var manualItems = await ListManualItemsAsync(connection, shipmentId, ct);

        return new OrderShipmentDetailResult(shipment.ShipmentId, shipment.ShipmentReference, shipment.DispatchDate, shipment.ExpectedEta,
            shipment.Haulier, shipment.ForwarderId, shipment.ModeOfTransport, shipment.TrackingNumber, shipment.BillOfLading, shipment.ContainerNumber,
            shipment.Notes, shipment.ReceivedAtUtc, shipment.ReceivedBy, shipment.CancelledAtUtc, shipment.CancelledBy,
            shipment.CreatedAtUtc, shipment.UpdatedAtUtc, shipment.IsManual, shipment.OriginDestinationId, shipment.OriginName,
            orders.AsList(), manualItems);
    }

    /// <summary>ShipmentReference is intentionally excluded — auto-generated at creation and permanent, never user-editable.</summary>
    internal static async Task UpdateShipmentAsync(INexusOperationsDb db, long shipmentId, UpdateOrderShipmentRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var resolvedName = await ResolveForwarderNameAsync(connection, body.ForwarderId, ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.PurchaseOrderShipment SET
              DispatchDate = @DispatchDate, ExpectedEta = @ExpectedEta, Haulier = @haulier,
              ForwarderID = @ForwarderId, ModeOfTransport = @ModeOfTransport, TrackingNumber = @TrackingNumber,
              BillOfLading = @BillOfLading, ContainerNumber = @ContainerNumber, Notes = @Notes,
              UpdatedAtUtc = GETUTCDATE()
            WHERE ShipmentId = @shipmentId
            """, new { shipmentId, body.DispatchDate, body.ExpectedEta, haulier = resolvedName ?? body.Haulier, body.ForwarderId, body.ModeOfTransport, body.TrackingNumber, body.BillOfLading, body.ContainerNumber, body.Notes }, cancellationToken: ct));
    }

    // ── Manual Inbound Shipment cargo items ──────────────────────────────

    internal static async Task<IReadOnlyList<ManualInboundItemRow>> ListManualItemsAsync(INexusOperationsDb db, long shipmentId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await ListManualItemsAsync(connection, shipmentId, ct);
    }

    private static async Task<IReadOnlyList<ManualInboundItemRow>> ListManualItemsAsync(IDbConnection connection, long shipmentId, CancellationToken ct)
    {
        var rows = await connection.QueryAsync<ManualInboundItemRow>(new CommandDefinition("""
            SELECT ItemId, ShipmentId, Material, Description, Quantity, UnitOfMeasure, CreatedAtUtc, CreatedBy
            FROM log.ManualInboundItem
            WHERE ShipmentId = @shipmentId AND Removed = 0
            ORDER BY ItemId ASC
            """, new { shipmentId }, cancellationToken: ct));
        return rows.AsList();
    }

    /// <summary>Rejects a non-manual shipment itself (Cargo items only make sense alongside a Manual Inbound Shipment's own header).</summary>
    internal static async Task AddManualItemAsync(INexusOperationsDb db, long shipmentId, AddManualInboundItemRequest body, string? createdBy, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var isManual = await connection.QuerySingleOrDefaultAsync<bool?>(new CommandDefinition(
            "SELECT IsManual FROM log.PurchaseOrderShipment WHERE ShipmentId = @shipmentId", new { shipmentId }, cancellationToken: ct));
        if (isManual is null) throw new NexusNotFoundException("Shipment not found.");
        if (isManual != true) throw new NexusValidationException("Cargo items can only be added to a manual shipment.");

        if (body.Quantity is not > 0) throw new NexusValidationException("Quantity must be greater than 0.");
        var material = string.IsNullOrWhiteSpace(body.Material) ? null : body.Material.Trim();
        var description = string.IsNullOrWhiteSpace(body.Description) ? null : body.Description.Trim();
        if (material is null && description is null) throw new NexusValidationException("Enter a material or a description.");
        var unitOfMeasure = string.IsNullOrWhiteSpace(body.UnitOfMeasure) ? null : body.UnitOfMeasure.Trim();

        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO log.ManualInboundItem (ShipmentId, Material, Description, Quantity, UnitOfMeasure, CreatedBy)
            VALUES (@shipmentId, @material, @description, @Quantity, @unitOfMeasure, @createdBy)
            """, new { shipmentId, material, description, body.Quantity, unitOfMeasure, createdBy }, cancellationToken: ct));
    }

    internal static async Task RemoveManualItemAsync(INexusOperationsDb db, long itemId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var existing = await connection.QuerySingleOrDefaultAsync<long?>(new CommandDefinition(
            "SELECT ItemId FROM log.ManualInboundItem WHERE ItemId = @itemId AND Removed = 0", new { itemId }, cancellationToken: ct));
        if (existing is null) throw new NexusNotFoundException("Item not found.");
        await connection.ExecuteAsync(new CommandDefinition("UPDATE log.ManualInboundItem SET Removed = 1 WHERE ItemId = @itemId", new { itemId }, cancellationToken: ct));
    }

    // ── Assign / cancel ───────────────────────────────────────────────────

    /// <summary>Links (or unlinks, with shipmentId: null) a tracked order to a shipment. Re-checks the target shipment isn't cancelled fresh from the DB rather than trusting the caller.</summary>
    internal static async Task AssignShipmentAsync(INexusOperationsDb db, long suggestionId, long? shipmentId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await PurchaseOrderSuggestionHelper.AssertOrderEditableAsync(connection, suggestionId, ct);

        if (shipmentId is not null)
        {
            var row = await connection.QuerySingleOrDefaultAsync<ShipmentCancelledStatusRow?>(new CommandDefinition(
                "SELECT CancelledAtUtc FROM log.PurchaseOrderShipment WHERE ShipmentId = @shipmentId", new { shipmentId }, cancellationToken: ct));
            if (row is null) throw new NexusNotFoundException("Shipment not found.");
            if (row.CancelledAtUtc is not null) throw new NexusValidationException("This shipment has been cancelled and cannot accept orders.");
        }

        await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE log.PurchaseOrderSuggestion SET ShipmentId = @shipmentId, UpdatedAtUtc = GETUTCDATE() WHERE SuggestionId = @suggestionId",
            new { suggestionId, shipmentId }, cancellationToken: ct));
    }

    /// <summary>Unlinks every order currently on the shipment (their own Status is untouched, just no longer pointing at a dead shipment) and marks the shipment cancelled. Allowed even after the shipment has been marked received — the only guard is against cancelling something already cancelled.</summary>
    internal static async Task<CancelOrderShipmentResult> CancelShipmentAsync(INexusOperationsDb db, long shipmentId, string? cancelledBy, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var shipment = await connection.QuerySingleOrDefaultAsync<ShipmentCancelledStatusRow?>(new CommandDefinition(
            "SELECT CancelledAtUtc FROM log.PurchaseOrderShipment WHERE ShipmentId = @shipmentId", new { shipmentId }, cancellationToken: ct));
        if (shipment is null) throw new NexusNotFoundException("Shipment not found.");
        if (shipment.CancelledAtUtc is not null) throw new NexusValidationException("This shipment has already been cancelled.");

        await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE log.PurchaseOrderShipment SET CancelledAtUtc = GETUTCDATE(), CancelledBy = @cancelledBy, UpdatedAtUtc = GETUTCDATE() WHERE ShipmentId = @shipmentId",
            new { shipmentId, cancelledBy }, cancellationToken: ct));

        var unlinked = await connection.QueryAsync<long>(new CommandDefinition("""
            UPDATE log.PurchaseOrderSuggestion SET ShipmentId = NULL, UpdatedAtUtc = GETUTCDATE()
            OUTPUT INSERTED.SuggestionId
            WHERE ShipmentId = @shipmentId
            """, new { shipmentId }, cancellationToken: ct));

        return new CancelOrderShipmentResult(unlinked.Count());
    }

    // ── Supplier invoice documents (filesystem) ──────────────────────────

    /// <summary>Throws if the configured root doesn't look like a real Windows/UNC path — same "misconfigured LOGISTICS_IMPORT_ROOT/LOGISTICS_PO_ROOT" guard Node has, catching a stray machine environment variable shadowing the real config.</summary>
    private static string AssertValidRoot(string root, string settingName)
    {
        var value = (root ?? "").Trim();
        var looksValid = System.Text.RegularExpressions.Regex.IsMatch(value, @"^[A-Za-z]:[\\/]") || System.Text.RegularExpressions.Regex.IsMatch(value, @"^\\\\[^?\\]");
        if (!looksValid)
        {
            throw new NexusBadGatewayException(
                $"Logistics {settingName} folder path is misconfigured (Logistics:{settingName} resolved to \"{value}\"). Check appsettings.Production.json's Logistics:{settingName}.");
        }
        return value;
    }

    private static string SanitizeSupplierFolderSegment(string? value)
    {
        var clean = System.Text.RegularExpressions.Regex.Replace(value ?? "Unknown Supplier", "[<>:\"/\\\\|?*]", "_");
        clean = System.Text.RegularExpressions.Regex.Replace(clean, @"[. ]+$", "").Trim();
        return clean.Length > 0 ? clean : "Unknown Supplier";
    }

    private readonly record struct ImportFolderInfo(string MonthPath, string ShipmentPath);

    private static ImportFolderInfo GetImportFolderInfo(DateTime createdAtUtc, long shipmentId, string? shipmentReference, string? supplierName, LogisticsOptions settings)
    {
        var importRoot = AssertValidRoot(settings.ImportRoot, "ImportRoot");
        var year = createdAtUtc.Year.ToString();
        var monthFolder = $"{createdAtUtc.Month:D2}. {MonthNames[createdAtUtc.Month - 1]}";
        var orderFolder = SanitizeSupplierFolderSegment($"{shipmentReference ?? $"Shipment {shipmentId}"} - {supplierName ?? "Unknown Supplier"}");
        var monthPath = Path.Combine(importRoot, year, monthFolder);
        return new ImportFolderInfo(monthPath, Path.Combine(monthPath, orderFolder));
    }

    /// <summary>A shipment record plus the single supplier name derived from its first linked order — shared by all document operations so the folder-path derivation only lives in one place. A Manual Inbound Shipment has no linked orders to derive a vendor name from, but does capture an origin name at creation time (OriginName) — fall back to that rather than filing under "Unknown Supplier" just because the shipment is manual.</summary>
    private static async Task<(OrderShipmentDetailResult Shipment, string? SupplierName)> LoadForImportDocsAsync(IDbConnection connection, long shipmentId, CancellationToken ct)
    {
        var shipment = await GetShipmentDetailAsync(connection, shipmentId, ct) ?? throw new NexusNotFoundException("Shipment not found.");
        var supplierName = shipment.Orders.Count > 0 ? shipment.Orders[0].VendorName : shipment.OriginName;
        return (shipment, supplierName);
    }

    internal static async Task<InboundShipmentDocumentFolderResult> GetDocumentFolderAsync(INexusOperationsDb db, IOptions<LogisticsOptions> options, long shipmentId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var (shipment, supplierName) = await LoadForImportDocsAsync(connection, shipmentId, ct);
        var folder = GetImportFolderInfo(shipment.CreatedAtUtc, shipmentId, shipment.ShipmentReference, supplierName, options.Value);

        var files = new List<InboundShipmentDocumentFileInfo>();
        if (Directory.Exists(folder.ShipmentPath))
        {
            foreach (var path in Directory.EnumerateFiles(folder.ShipmentPath))
            {
                var info = new FileInfo(path);
                files.Add(new InboundShipmentDocumentFileInfo(info.Name, info.Length, info.LastWriteTimeUtc,
                    $"/api/performance/order-suggestions/shipments/{shipmentId}/documents/{Uri.EscapeDataString(info.Name)}"));
            }
        }
        files.Sort((a, b) => string.CompareOrdinal(a.FileName, b.FileName));

        return new InboundShipmentDocumentFolderResult(supplierName, files, folder.ShipmentPath);
    }

    /// <summary>Resolves a shipment document's absolute path for the controller to stream back. Path traversal via `fileName` is neutralised by Path.GetFileName before it's ever combined with the folder path.</summary>
    internal static async Task<string> ResolveDocumentPathAsync(INexusOperationsDb db, IOptions<LogisticsOptions> options, long shipmentId, string fileName, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var (shipment, supplierName) = await LoadForImportDocsAsync(connection, shipmentId, ct);
        var folder = GetImportFolderInfo(shipment.CreatedAtUtc, shipmentId, shipment.ShipmentReference, supplierName, options.Value);

        var safeName = Path.GetFileName(fileName ?? "");
        var target = Path.Combine(folder.ShipmentPath, safeName);
        if (!File.Exists(target)) throw new NexusNotFoundException("Document not found.");
        return target;
    }

    /// <summary>
    /// Extensions accepted keyed off the uploaded file's own name rather than its Content-Type —
    /// browsers report inconsistent or empty MIME types for some of these (.msg/.eml especially).
    /// Auto-creates the destination folder (year/month/shipment) if it doesn't exist yet.
    /// </summary>
    internal static async Task<UploadedInboundDocumentResult> UploadDocumentAsync(INexusOperationsDb db, IOptions<LogisticsOptions> options, long shipmentId, byte[] fileBytes, string? originalName, CancellationToken ct)
    {
        if (fileBytes.Length == 0) throw new NexusValidationException("No file content received.");
        if (fileBytes.Length > 20 * 1024 * 1024) throw new NexusPayloadTooLargeException("File is too large (20MB limit).");

        var ext = Path.GetExtension(originalName ?? "").ToLowerInvariant();
        if (!AllowedDocumentExtensions.Contains(ext, StringComparer.OrdinalIgnoreCase))
        {
            throw new NexusValidationException(
                $"Unsupported file type{(string.IsNullOrEmpty(ext) ? "" : $" ({ext})")}. Allowed types: {string.Join(", ", AllowedDocumentExtensions)}.");
        }

        using var connection = await db.CreateConnectionAsync(ct);
        var (shipment, supplierName) = await LoadForImportDocsAsync(connection, shipmentId, ct);
        var folder = GetImportFolderInfo(shipment.CreatedAtUtc, shipmentId, shipment.ShipmentReference, supplierName, options.Value);
        Directory.CreateDirectory(folder.ShipmentPath);

        var originalNameSafe = originalName ?? "";
        var baseName = ext.Length > 0 && originalNameSafe.Length > ext.Length ? originalNameSafe[..^ext.Length] : originalNameSafe;
        if (string.IsNullOrEmpty(baseName)) baseName = "document";
        var fileName = $"{ShipmentDocumentHelper.SanitizeFileSegment(baseName)}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}{ext}";
        var filePath = Path.Combine(folder.ShipmentPath, fileName);
        await File.WriteAllBytesAsync(filePath, fileBytes, ct);

        return new UploadedInboundDocumentResult(fileName, fileBytes.LongLength, $"/api/performance/order-suggestions/shipments/{shipmentId}/documents/{Uri.EscapeDataString(fileName)}");
    }

    /// <summary>
    /// Files land at {PoRoot}\{VendorName}\{PoNumber}.pdf — flat, vendor-then-PO-number, unlike the
    /// import side above. Exposed internal so Sub-phase 8b.7's Create PO in SAP (which writes the
    /// PDF here in the first place) can reuse the exact same path derivation.
    /// </summary>
    internal static string GetPoPdfPath(string? vendorName, string poNumber, LogisticsOptions settings)
    {
        var poRoot = AssertValidRoot(settings.PoRoot, "PoRoot");
        var vendorFolder = SanitizeSupplierFolderSegment(vendorName);
        var fileName = $"{ShipmentDocumentHelper.SanitizeFileSegment(poNumber)}.pdf";
        return Path.Combine(poRoot, vendorFolder, fileName);
    }

    /// <summary>
    /// Auto-files each linked order's PO PDF (generated by 8b.7's Create PO in SAP) into a shipment's
    /// own import folder the moment the shipment exists. Best-effort: a PO PDF that doesn't exist on
    /// disk (never run through Create PO in SAP yet, or moved/deleted since) is skipped rather than
    /// failing shipment creation.
    /// </summary>
    private static async Task AutoFileShipmentPoDocumentsAsync(IDbConnection connection, LogisticsOptions settings, long shipmentId, CancellationToken ct)
    {
        var (shipment, supplierName) = await LoadForImportDocsAsync(connection, shipmentId, ct);
        var folder = GetImportFolderInfo(shipment.CreatedAtUtc, shipmentId, shipment.ShipmentReference, supplierName, settings);
        Directory.CreateDirectory(folder.ShipmentPath);

        var poNumbers = shipment.Orders.Select(o => o.PoNumber).Where(p => !string.IsNullOrEmpty(p)).Distinct().ToList();
        foreach (var poNumber in poNumbers)
        {
            try
            {
                var src = GetPoPdfPath(supplierName, poNumber!, settings);
                if (!File.Exists(src)) continue;
                var destName = $"{ShipmentDocumentHelper.SanitizeFileSegment(poNumber)}.pdf";
                File.Copy(src, Path.Combine(folder.ShipmentPath, destName), overwrite: true);
            }
            catch
            {
                // Best-effort — a filesystem hiccup copying one PO must not fail the others or the shipment itself.
            }
        }
    }
}
