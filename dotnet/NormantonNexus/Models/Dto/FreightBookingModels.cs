namespace NormantonNexus.Models.Dto;

// ── Logistics Sub-phase 8c.3: Kuehne+Nagel freight booking ─────────────────
// Port of routes/freightbooking.js. UNVERIFIED against a live KN sandbox or
// real credentials — no live KN access has been reachable in any
// environment this port has been developed in, the same caveat class as
// this migration's other external integrations (ClearPortClient,
// SmtpMailer) before real-world confirmation. Every field name below is
// copied verbatim from Node's own buildBookingPayload/KN document-upload
// payload — not independently re-verified against KN's BookingRoad OpenAPI
// spec beyond what Node's own inline comments already document.

// ── KN cargoItems (shared shape for both a normal shipment's pallets and a Manual Outbound Shipment's cargo lines) ──
public sealed record KnCargoItem(
    string Description, string MarksAndNumbers, bool Stackable, int PackageCount, string PackageType,
    decimal Weight, string WeightUom, decimal Volume, string VolumeUom,
    decimal DimensionLength, decimal DimensionWidth, decimal DimensionHeight, string DimensionsUom);

public sealed record CreateFreightBookingRequest(DateTime? PlannedCollection);

// ── POST /bookings payload (buildBookingPayload) ──
public sealed record KnBookingFlags(bool AppointmentRequired, bool TailLiftRequired, bool HighValue, bool OversizedGoods, bool PrivateConsignee, bool InsuranceFlag)
{
    internal static readonly KnBookingFlags AllFalse = new(false, false, false, false, false, false);
}

public sealed record KnIncoterm(string Code, string Location);

public sealed record KnAddress(string Name1, string Street1, string City, string PostalCode, string CountryCode);

public sealed record KnPartyReference(string Value, string Code);

public sealed record KnShipperParty(KnAddress Address, List<KnPartyReference> References);

public sealed record KnConsigneeParty(KnAddress Address);

public sealed record KnPickupLocation(KnAddress Address, string? RequestDate);

public sealed record KnDeliveryLocation(KnAddress Address);

public sealed record KnBookingPayload(
    string CustomerId, string CustomerKey, KnBookingFlags BookingFlags, List<object> BookingOptions,
    int DangerousGoodsPackageCount, KnIncoterm Incoterm, KnShipperParty ShipperParty, KnConsigneeParty ConsigneeParty,
    KnPickupLocation PickupLocation, KnDeliveryLocation DeliveryLocation, List<KnCargoItem> CargoItems);

/// <summary>Result of a successful (HTTP 2xx) booking creation — the caller still has to check BookingIsSuccessful, since KN can return a 2xx with that false and an ErrorMessage instead of an HTTP error status.</summary>
public sealed record CreateBookingResult(
    string Message, long ShipmentId, string? BookingId, string? TransactionId, bool? BookingIsSuccessful,
    string TrackingNumber, Dictionary<string, object?>? Data, KnBookingPayload RequestPayload);

// ── POST /:shipmentId/documents/upload-to-kn ──

public sealed record UploadDocumentsToKnRequest(string? BookingId, List<KnDocumentUploadFileRequest>? Files);

public sealed record KnDocumentUploadFileRequest(string? FileName, string? Category);

public sealed record KnUploadedDocument(string FileName, string Category, string DocumentCode, string? DocumentId);

public sealed record KnFailedDocument(string FileName, string? Category, string Error);

/// <summary>?dryRun=true preview row — everything that can fail before an actual KN POST (folder resolution, file stat, OAuth token fetch) has already happened by the time this is built, so a bad fileName/category/token shows up here instead of as an opaque KN error.</summary>
public sealed record KnDocumentUploadPreview(
    string FileName, string Category, string? DocumentCode, string DocumentExtension, string FilePath,
    long? FileSizeBytes, string? FileError, string Url, Dictionary<string, string> Headers, Dictionary<string, object?>? Payload);

public sealed record UploadDocumentsToKnResult(bool Success, bool DryRun, string BookingId,
    IReadOnlyList<KnUploadedDocument> Uploaded, IReadOnlyList<KnFailedDocument> Failed, IReadOnlyList<KnDocumentUploadPreview> Preview);

/// <summary>POST /documents payload — KN's BookingRoad OpenAPI spec (Document Request tag). "customerId" is deliberately lowercase-d, matching the spec and buildBookingPayload's own casing.</summary>
public sealed record KnDocumentUploadPayload(string CustomerId, string CustomerKey, string DocumentCode, string DocumentExtension, string BookingId, string Base64EncodedDocument);
