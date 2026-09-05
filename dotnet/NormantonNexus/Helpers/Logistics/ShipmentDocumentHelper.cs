using Dapper;
using Microsoft.Extensions.Options;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Document generation/listing/upload — Logistics Sub-phase 8a.3. Port of
/// routes/shipmentmain.js's generate-packing-list, generate-packaging-
/// declaration, documents/folder, documents/:fileName, and
/// documents/upload. All write into (or read from) the same on-disk
/// shipment export folder ShipmentManualCargoHelper.CreateFolderAsync
/// (Sub-phase 8a.2) already resolves via ShipmentHelper.GetShipmentFolderInfo.
/// </summary>
internal static class ShipmentDocumentHelper
{
    /// <summary>Loading list (multi-shipment) — port of routes/shipmentmain.js's POST /loading-list. Unlike the single-shipment packing list/packaging declaration, this is a pure download: nothing is written into any shipment's export folder, the PDF bytes go straight back to the caller.</summary>
    internal static async Task<(byte[] Pdf, string FileName)> GenerateLoadingListAsync(INexusOperationsDb db, IReadOnlyList<long> shipmentIds, CancellationToken ct)
    {
        if (shipmentIds.Count == 0)
            throw new NexusValidationException("No shipments selected.");

        using var connection = await db.CreateConnectionAsync(ct);
        var shipmentsData = await ShipmentHelper.GetShipmentsForLoadingListAsync(connection, shipmentIds, ct);
        if (shipmentsData.Count == 0)
            throw new NexusNotFoundException("No valid shipments found.");

        var pdf = ShipmentPackingListPdfHelper.BuildLoadingListPdf(shipmentsData);
        var fileName = $"loading-list-{DateTime.UtcNow:yyyy-MM-dd}.pdf";
        return (pdf, fileName);
    }

    internal static async Task<GenerateDocumentResult> GeneratePackingListAsync(INexusOperationsDb db, IOptions<LogisticsOptions> options, long shipmentId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var context = await ShipmentHelper.SyncShipmentAggregateDataAsync(connection, shipmentId, ct);
        var folder = ShipmentHelper.GetShipmentFolderInfo(context.Shipment, options.Value);

        var fileName = $"{folder.ShipmentRef}.pdf";
        var filePath = Path.Combine(folder.ShipmentPath, fileName);
        Directory.CreateDirectory(folder.ShipmentPath);
        await File.WriteAllBytesAsync(filePath, ShipmentPackingListPdfHelper.BuildPackingListPdf(context), ct);

        return new GenerateDocumentResult(folder.ShipmentRef, folder.ShipmentPath,
            [new GeneratedDocumentFile(fileName, null, DownloadUrl(shipmentId, fileName))]);
    }

    internal static async Task<GenerateDocumentResult> GeneratePackagingDeclarationAsync(
        INexusOperationsDb db, INexusDb nexusDb, IOptions<LogisticsOptions> options, long shipmentId, GeneratePackagingDeclarationRequest body, int userId, string? username, CancellationToken ct)
    {
        var packaging = body.Packaging ?? new PackagingDeclarationOptions(false, false, false, false);
        if (!(packaging.WoodenPallets || packaging.WoodenSpools || packaging.CardboardBoxes || packaging.BubblewrapSheets))
            throw new NexusValidationException("Select at least one packaging type used for this delivery.");

        var position = (body.Position ?? "").Trim();
        if (position.Length == 0)
            throw new NexusValidationException("Position / job title is required to sign the declaration.");

        using var connection = await db.CreateConnectionAsync(ct);
        var context = await ShipmentHelper.GetShipmentContextAsync(connection, shipmentId, ct);
        var folder = ShipmentHelper.GetShipmentFolderInfo(context.Shipment, options.Value);
        Directory.CreateDirectory(folder.ShipmentPath);

        var signedByName = await GetUserDisplayNameAsync(nexusDb, userId, ct) ?? username ?? "unknown";
        var deliveryRef = context.Deliveries.Count > 0
            ? string.Join(", ", context.Deliveries.Select(d => d.DeliveryId))
            : (context.ManualCargo.Count > 0 ? folder.ShipmentRef : "—");

        var pdfBuffer = ShipmentPackagingDeclarationPdfHelper.Build(new ShipmentPackagingDeclarationPdfHelper.Input(
            ShipmentRef: folder.ShipmentRef, DeliveryRef: deliveryRef, CustomerName: context.Shipment.DestinationName, DispatchDate: context.Shipment.PlannedCollection,
            Packaging: packaging, Ispm15: body.Ispm15 == "yes" ? "yes" : "na", DunnageConfirmed: body.DunnageConfirmed, ContainerClean: body.ContainerClean == "yes" ? "yes" : "na",
            SignedByName: signedByName, SignedByPosition: position, SignedAt: DateTime.Now));

        var fileName = $"{folder.ShipmentRef}-packaging-declaration-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.pdf";
        var filePath = Path.Combine(folder.ShipmentPath, fileName);
        await File.WriteAllBytesAsync(filePath, pdfBuffer, ct);

        return new GenerateDocumentResult(folder.ShipmentRef, folder.ShipmentPath,
            [new GeneratedDocumentFile(fileName, null, DownloadUrl(shipmentId, fileName))]);
    }

    /// <summary>Looks up the acting user's own display name (First+Last, falling back to Username) for the packaging declaration's e-signature block. PortalUsers lives in the Nexus (portal/auth) database, not NexusOperations, so this takes a separate connection. Best-effort: a lookup failure must not block PDF generation.</summary>
    private static async Task<string?> GetUserDisplayNameAsync(INexusDb nexusDb, int userId, CancellationToken ct)
    {
        if (userId <= 0) return null;
        try
        {
            using var connection = await nexusDb.CreateConnectionAsync(ct);
            return await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition("""
                SELECT COALESCE(NULLIF(RTRIM(ISNULL(FirstName,'')+' '+ISNULL(LastName,'')), ''), Username) AS DisplayName
                FROM dbo.PortalUsers WHERE UserID = @userId
                """, new { userId }, cancellationToken: ct));
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Regenerates the packing list first so the listing is always current
    /// (the one real reason documents/folder is coupled to PDF generation,
    /// per this slice's own re-scoping note in ShipmentManualCargoModels.cs),
    /// then lists every PDF actually sitting in the folder — an operator-
    /// uploaded invoice or a customs PDF (written elsewhere) shows up here
    /// too.
    /// </summary>
    internal static async Task<ShipmentDocumentFolderResult> GetDocumentFolderAsync(INexusOperationsDb db, IOptions<LogisticsOptions> options, long shipmentId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var context = await ShipmentHelper.SyncShipmentAggregateDataAsync(connection, shipmentId, ct);
        var folder = ShipmentHelper.GetShipmentFolderInfo(context.Shipment, options.Value);

        var files = new List<ShipmentDocumentFileInfo>();
        if (Directory.Exists(folder.ShipmentPath))
        {
            foreach (var path in Directory.EnumerateFiles(folder.ShipmentPath, "*.pdf"))
            {
                var info = new FileInfo(path);
                files.Add(new ShipmentDocumentFileInfo(info.Name, info.Length, info.LastWriteTimeUtc,
                    GuessDocumentCategory(info.Name, folder.ShipmentRef), DownloadUrl(shipmentId, info.Name)));
            }
        }
        files.Sort((a, b) => string.CompareOrdinal(a.FileName, b.FileName));

        return new ShipmentDocumentFolderResult(folder.ShipmentRef, context.Shipment.CustomsRequired, context.Shipment.CustomsComplete, files);
    }

    /// <summary>Resolves a shipment document's absolute path for the controller to stream back — the caller is responsible for actually returning the file (this Helper does no HTTP/filesystem-response work itself). Throws if the requested name isn't a real .pdf in this shipment's own folder — path traversal via `fileName` is neutralised by Path.GetFileName before it's ever combined with the folder path.</summary>
    internal static async Task<string> ResolveDocumentPathAsync(INexusOperationsDb db, IOptions<LogisticsOptions> options, long shipmentId, string fileName, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var shipment = await ShipmentHelper.GetShipmentByIdAsync(connection, shipmentId, ct) ?? throw new NexusNotFoundException($"Shipment {shipmentId} not found.");
        var folder = ShipmentHelper.GetShipmentFolderInfo(shipment, options.Value);

        var safeName = Path.GetFileName(fileName ?? "");
        if (!safeName.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase))
            throw new NexusValidationException("Only PDF documents are available.");

        var target = Path.Combine(folder.ShipmentPath, safeName);
        if (!File.Exists(target))
            throw new NexusNotFoundException("Document not found.");

        return target;
    }

    /// <summary>The commercial invoice is the one document in the trio that's neither generated by this app (packing list) nor pulled from ClearPort (customs, Sub-phase 8a.5) — an operator uploads it by hand once it exists.</summary>
    internal static async Task<UploadedDocumentResult> UploadDocumentAsync(INexusOperationsDb db, IOptions<LogisticsOptions> options, long shipmentId, byte[] fileBytes, string? originalName, CancellationToken ct)
    {
        if (fileBytes.Length == 0)
            throw new NexusValidationException("No file content received. Content-Type must be application/pdf.");
        if (fileBytes.Length > 20 * 1024 * 1024)
            throw new NexusValidationException("File is too large (20MB limit).");

        using var connection = await db.CreateConnectionAsync(ct);
        var shipment = await ShipmentHelper.GetShipmentByIdAsync(connection, shipmentId, ct) ?? throw new NexusNotFoundException($"Shipment {shipmentId} not found.");
        var folder = ShipmentHelper.GetShipmentFolderInfo(shipment, options.Value);
        Directory.CreateDirectory(folder.ShipmentPath);

        var baseName = System.Text.RegularExpressions.Regex.Replace(originalName ?? "invoice", @"\.pdf$", "", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var fileName = $"{folder.ShipmentRef}-invoice-{SanitizeFileSegment(baseName)}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.pdf";
        var filePath = Path.Combine(folder.ShipmentPath, fileName);
        await File.WriteAllBytesAsync(filePath, fileBytes, ct);

        return new UploadedDocumentResult(fileName, fileBytes.LongLength, "invoice", DownloadUrl(shipmentId, fileName));
    }

    private static string DownloadUrl(long shipmentId, string fileName) =>
        $"/api/shipmentmain/{shipmentId}/documents/{Uri.EscapeDataString(fileName)}";

    /// <summary>Every file this app itself writes into a shipment's export folder already follows a fixed naming convention, so most files can be pre-categorised for the operator rather than left blank — only a starting guess, the operator always confirms/overrides it before a booking can proceed.</summary>
    private static string? GuessDocumentCategory(string fileName, string shipmentRef)
    {
        var lower = fileName.ToLowerInvariant();
        if (lower == $"{shipmentRef}.pdf".ToLowerInvariant()) return "packing-list";
        if (lower.Contains("-customs-")) return "customs";
        if (lower.Contains("-invoice-")) return "invoice";
        if (lower.Contains("-packaging-declaration-")) return "packaging-declaration";
        return null;
    }

    internal static string SanitizeFileSegment(string? value)
    {
        var clean = System.Text.RegularExpressions.Regex.Replace(value ?? "", "[<>:\"/\\\\|?*]", "_");
        clean = System.Text.RegularExpressions.Regex.Replace(clean, @"\s+", "-");
        clean = System.Text.RegularExpressions.Regex.Replace(clean, @"[. ]+$", "").Trim();
        return clean.Length > 0 ? clean : "document";
    }
}
