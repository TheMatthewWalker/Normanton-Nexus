namespace NormantonNexus.Models.Dto;

// Logistics Sub-phase 8a.5c — ClearPort customs declaration submission
// (routes/shipmentmain.js's POST /customs/create). See
// ClearPortShipmentPayloadHelper/ShipmentCustomsHelper's own header
// comments for the full port notes and the unverified-against-a-live-
// ClearPort-sandbox caveat.

// ── SapServer's api/customs/* row shapes (SapServer/Helpers/CustomsHelpers.cs) — mirrored field-for-field so ISapServerClient can deserialize directly into them. ──
public sealed record LipsRow(string DeliveryNumber, string ItemNumber, string MaterialNumber, string Quantity);
public sealed record LikpRow(string DeliveryNumber, string Incoterms, string ConsigneeCode, string GoodsIssueDate);
public sealed record VbfaRow(string DeliveryNumber, string ItemNumber, string InvoiceNumber, string InvoiceItem, string StatisticalValue, string InvoiceDate);
public sealed record MarcRow(string MaterialNumber, string CommodityCode, string CountryOfOrigin);
public sealed record Kna1Row(string CustomerCode, string Name, string Street, string City, string PostCode, string DestinationCountry, string TransportZone, string VatNumber, string Incoterms);

public sealed record NameAndAddress(string? Name, string? StreetAndNumber, string? CityName, string? Postcode, string CountryCode);

public sealed record HolderOfAuthorisation(string AuthorisationTypeCode, string Identifier);

public sealed record PreviousDocument(string Category, string Type, string DocumentReference);

public sealed record ClearPortPackage(string Type, int Number, string ShippingMarks);

public sealed record ClearPortExportItem(
    string CorrelationId, string ReferenceNumber, string CommodityCode, string Procedure, string AdditionalProcedures,
    string CountryOfDestination, string CountryOfOrigin, decimal NetMass, decimal GrossMass, string DescriptionOfGoods,
    List<ClearPortPackage> Packages, string NatureOfTransaction, decimal StatisticalValue, string StatisticalValueCurrencyCode,
    List<PreviousDocument> PreviousDocuments, List<object> AdditionalInformation);

/// <summary>POST /v1/cds/exports request body — mirrors buildClearPortShipmentPayload's return shape field-for-field.</summary>
public sealed record ClearPortExportRequest(
    bool Sandbox, string CorrelationId, string ExternalSystemLink, string Category, string DeclarationType,
    string ReferenceNumber, string Lrn, string Ducr, NameAndAddress Exporter, string ExporterIdentificationNumber,
    NameAndAddress Consignee, NameAndAddress Declarant, string DeclarantIdentificationNumber, int RepresentativeStatusCode,
    string TransportChargesMethodOfPayment, decimal TotalInvoice, string TotalInvoiceCurrencyCode,
    string CountryOfDestination, string CountryOfDispatch, string LocationOfGoods, string CustomsOfficeOfExit,
    decimal TotalGrossMass, decimal TotalNetMass, int TotalPackages, bool Containerised, string NatureOfTransaction,
    bool Rrs01, string Rrs01Description, int ModeOfTransportAtBorder, int InlandModeOfTransport, int TypeOfTransportAtDeparture,
    string IdentityOfTransportAtDeparture, int TypeOfActiveMeansOfTransportAtBorder, string IdentityOfActiveMeansOfTransportAtBorder,
    string NationalityOfActiveMeansOfTransportAtBorder, List<HolderOfAuthorisation> HoldersOfAuthorisation, List<ClearPortExportItem> Items);

public sealed record ClearPortExportResponse(bool Success, string? CorrelationId, List<string>? ErrorMessages);

/// <summary>SAP data fetched via SapServer's api/customs/* endpoints, needed to enrich each LIPS line before building the ClearPort payload.</summary>
public sealed record SapCustomsData(
    IReadOnlyList<LipsRow> LipsData, IReadOnlyList<LikpRow> LikpData, IReadOnlyList<VbfaRow> VbfaData, IReadOnlyList<MarcRow> MarcData, IReadOnlyList<Kna1Row> Kna1Data);

public sealed record CustomsCreateBulkRequest(List<long> ShipmentIds);

public sealed record CustomsCreateCompleted(long ShipmentId, string ShipmentRef, string CustomsId, string FileName, string DownloadUrl);

public sealed record CustomsCreateFailed(long ShipmentId, string ShipmentRef, string Error);

public sealed record CustomsCreateResult(IReadOnlyList<CustomsCreateCompleted> Completed, IReadOnlyList<CustomsCreateFailed> Failed, int Updated);
