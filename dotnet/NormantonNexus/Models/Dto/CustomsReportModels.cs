namespace NormantonNexus.Models.Dto;

// ── Logistics Sub-phase 8c.2: French VAT / DDP Customs Report ─────────────
// Port of routes/customsreport.js. Reuses LipsRow/LikpRow/VbfaRow/MarcRow/
// Kna1Row from ClearPortModels.cs (Sub-phase 8a.5c) — same SapServer
// api/customs/* row shapes, no need to redefine them.

public sealed record VbrkRow(string InvoiceNumber, string Currency);

public sealed record ConsignmentPriceRow(string CustomerCode, string MaterialNumber, string Rate, string Currency, string PricingUnit);

/// <summary>One row of the uploaded Shipments-style extract (columns A:D — PicksheetNumber/ShipmentRef/ActualCollectionDate/TotalWeight — the only data that isn't already in SAP).</summary>
public sealed record CustomsShipmentUploadRow(string PicksheetNumber, string ShipmentRef, DateTime? ActualCollectionDate, decimal TotalWeight);

/// <summary>
/// SAP data fetched across the report's 3 enrichment rounds, plus any
/// warnings a partial/failed round already produced — mutable list so
/// BuildReportRowsAsync can keep appending to the same warnings collection
/// as it resolves the consignment-price fallback and VAT/HS lookups.
/// </summary>
public sealed record CustomsReportSapData(
    IReadOnlyList<LipsRow> LipsData, IReadOnlyList<LikpRow> LikpData, IReadOnlyList<VbfaRow> VbfaData,
    IReadOnlyList<MarcRow> MarcData, IReadOnlyList<Kna1Row> Kna1Data, IReadOnlyList<VbrkRow> VbrkData, List<string> Warnings);

/// <summary>
/// One assembled CUSTOMS-sheet line. Mutable — like PerformanceSyncModels'
/// SapPerformanceStockRow/SapAgreementRow family, this is built once per
/// LIPS line and then mutated across later passes (the consignment-price
/// fallback overwrites InvoiceNumber/InvoiceDate/Currency/SalesValue;
/// weight apportionment fills Weight last) — matches Node's own plain-
/// object-mutation pipeline exactly rather than fighting it with an
/// immutable-record redesign.
/// </summary>
public sealed class CustomsReportRow
{
    public required string DeliveryNumber { get; init; }
    public required string ItemNumber { get; init; }
    public required string Material { get; init; }
    public required decimal Quantity { get; init; }
    public string InvoiceNumber { get; set; } = "";
    public string Currency { get; set; } = "";
    public decimal? SalesValue { get; set; }
    public string CommodityCode { get; init; } = "";
    public string CountryOfOrigin { get; init; } = "";
    public string Incoterms { get; init; } = "";
    public required string ConsigneeCode { get; init; }
    public string Name { get; init; } = "";
    public string HsDescription { get; set; } = "";
    public string VatNumber { get; set; } = "";
    public string ShipmentRef { get; init; } = "";
    public DateTime? InvoiceDate { get; set; }
    public DateTime? ShipmentDate { get; init; }
    public decimal? Weight { get; set; }
}

public sealed record CustomsReportResult(IReadOnlyList<CustomsReportRow> Rows, IReadOnlyList<string> Warnings);
