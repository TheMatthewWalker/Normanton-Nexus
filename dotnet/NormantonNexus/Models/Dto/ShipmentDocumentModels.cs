namespace NormantonNexus.Models.Dto;

// Logistics Sub-phase 8a.3 — PDF generation (packing list, loading list,
// packaging declaration) + the document-folder routes that regenerate/
// list/serve them. Rebuilt in QuestPDF rather than porting Node's
// hand-rolled raw-PDF-object-model code literally — see
// ShipmentPackingListPdfHelper's header comment, same "deliberate
// non-pixel-perfect, QuestPDF-idiomatic re-layout" precedent
// LabelPdfHelper.cs already established for Production's labels.

public sealed record ShipmentContextDeliveryRow(
    long DeliveryId, long? CustomerId, DateTime? DispatchDate, DateTime? CompletionDate, string? DeliveryService, string? PicksheetComment,
    decimal NetWeight, decimal GrossWeight, decimal PalletCount, decimal DeliveryVolume,
    string? DestinationName, string? DestinationStreet, string? DestinationCity, string? DestinationPostCode, string? DestinationCountry, string? DestinationEmail);

public sealed record ShipmentContextPalletRow(
    long DeliveryId, long PalletId, string? PalletType, bool? PalletFinish, decimal PackagingWeight, decimal GrossWeight, decimal PalletVolume,
    int? PalletLength, int? PalletWidth, int? PalletHeight, string? PalletLocation);

/// <summary>Mirrors Node's getShipmentContext return shape exactly — the shipment row plus its linked deliveries/pallets (empty for a Manual Outbound Shipment, which uses ManualCargo instead).</summary>
public sealed record ShipmentContext(ShipmentRow Shipment, IReadOnlyList<ShipmentContextDeliveryRow> Deliveries, IReadOnlyList<ShipmentContextPalletRow> Pallets, IReadOnlyList<ManualCargoItemRow> ManualCargo);

public sealed record GeneratedDocumentFile(string FileName, long? DeliveryId, string DownloadUrl);

public sealed record GenerateDocumentResult(string ShipmentRef, string FolderPath, IReadOnlyList<GeneratedDocumentFile> Files);

public sealed record PackagingDeclarationOptions(bool WoodenPallets, bool WoodenSpools, bool CardboardBoxes, bool BubblewrapSheets);

public sealed record GeneratePackagingDeclarationRequest(
    PackagingDeclarationOptions? Packaging, string? Position, string? Ispm15, bool DunnageConfirmed, string? ContainerClean);

public sealed record ShipmentDocumentFileInfo(string FileName, long SizeBytes, DateTime ModifiedAtUtc, string? GuessedCategory, string DownloadUrl);

public sealed record ShipmentDocumentFolderResult(string ShipmentRef, bool CustomsRequired, bool CustomsComplete, IReadOnlyList<ShipmentDocumentFileInfo> Files);

public sealed record UploadedDocumentResult(string FileName, long SizeBytes, string GuessedCategory, string DownloadUrl);

/// <summary>Sub-phase 8a.4 — result of POST :shipmentId/send-collection-email, mirrors Node's `{shipmentRef, sentTo, cc, bcc, attachments}` response shape exactly.</summary>
public sealed record SendCollectionEmailResult(string ShipmentRef, string SentTo, IReadOnlyList<string> Cc, IReadOnlyList<string> Bcc, IReadOnlyList<string> Attachments);
