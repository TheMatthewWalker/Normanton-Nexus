namespace NormantonNexus.Models.Dto;

// ── Logistics Sub-phase 8c.1: Customs Report reference/fallback tables ────
// Port of routes/customsreportadmin.js. log.CustomsVatNumberOverrides /
// log.CustomsHsCodeDescriptions back the French VAT / DDP Customs Report
// tile (routes/customsreport.js) — the report tries live SAP data first
// (KNA1-STCEG for VAT number) and only consults CustomsVatNumberOverrides
// when SAP has nothing for that consignee; SAP has no live source for
// HS/commodity description text at all, so CustomsHsCodeDescriptions is the
// only source for that column.

public sealed record CustomsVatOverrideRow(int OverrideId, string ConsigneeCode, string VatNumber, string? Notes, DateTime CreatedAtUtc, DateTime? UpdatedAtUtc);

public sealed record CreateCustomsVatOverrideRequest(string? ConsigneeCode, string? VatNumber, string? Notes);

public sealed record CustomsHsDescriptionRow(int HsCodeId, string CommodityCode, string Description, DateTime CreatedAtUtc, DateTime? UpdatedAtUtc);

public sealed record CreateCustomsHsDescriptionRequest(string? CommodityCode, string? Description);
