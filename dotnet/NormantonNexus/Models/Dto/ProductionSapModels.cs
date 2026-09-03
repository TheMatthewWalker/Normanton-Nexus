namespace NormantonNexus.Models.Dto;

// Production, Sub-phase 6b — shared SapServer wire DTOs used across the
// entry/completion/scrap/reversal clusters (Mixing entry is the first
// consumer). Mirrors SapServer's Zf40nRequest/BdcResponse
// (Models/Bapi/ProductionModels.cs) field-for-field.

public sealed record Zf40nRequest(string Material, decimal Quantity, string Header, string Packaging, string Charge, string Customer);

/// <summary>
/// SapServer's Backflush action always returns HTTP 200/success:true —
/// the real ABAP-level outcome is Type/MessageClass/MessageNumber on this
/// object, which the caller must inspect itself (see
/// ProductionSapHelpers.ParseSapBackflush) — same "always 200, caller reads
/// Type" convention Node's own parseSapBackflush() depends on.
/// </summary>
public sealed record BdcResponse(string Type, string MessageClass, string MessageNumber, string Message, string DocumentNumber, string RawMessage);

/// <summary>Mirrors SapServer's ProfitCentreRequest — GET (with a JSON body) /api/production/check-profit-centre.</summary>
public sealed record ProfitCentreRequest(string Material);

/// <summary>
/// Mirrors SapServer's BomScrapRequest (Models/Bapi/ProductionModels.cs) —
/// POST /api/production/scrap/post. Material/Quantity/Header here are the
/// *finished good* being scrapped, not a BOM component — SapServer itself
/// explodes the material's BOM server-side and posts one MB11/BDC per
/// component, returning one BdcResponse per component in the BdcWrapper
/// below. ScrapReason is only sent when non-null/4 chars, matching Node's
/// `if (reasonCode?.length === 4) sapPayload.ScrapReason = reasonCode;`.
/// </summary>
public sealed record ScrapPostRequest(string Material, decimal Quantity, string Header, string MovementType, string? ScrapReason);

/// <summary>SapServer's BdcWrapper — the array-of-BdcResponse envelope returned by /api/production/scrap/post, one entry per BOM component posted. Mirrors Node's parseBomScrapResponse's `sapRaw.data.responses` unwrap.</summary>
public sealed record BdcWrapper(List<BdcResponse> Responses);

/// <summary>Mirrors SapServer's Mf41Request (Models/Bapi/ProductionModels.cs) — the shared request shape for both POST /api/production/reverse-backflush (MF41, backflush reversal) and POST /api/production/scrap/reverse (MBST, scrap-posting reversal). Both return a BdcResponse.</summary>
public sealed record Mf41Request(string MaterialDocument);

/// <summary>Mirrors SapServer's BomQuery — GET (with a JSON body) /api/production/bom.</summary>
public sealed record SapBomQuery(string Material);

/// <summary>Mirrors SapServer's BomRow field-for-field (raw SAP shape, before profit-centre enrichment — see BomHelper.FetchBomAsync).</summary>
public sealed record SapBomRow(string Material, string Plant, string Component, string Item, decimal ComponentQty, string ComponentUnit, string StorageLocation);

/// <summary>Mirrors SapServer's ProfitCentresRequest — GET (with a JSON body) /api/production/check-profit-centres (bulk).</summary>
public sealed record SapProfitCentresRequest(List<string> Materials);

/// <summary>Mirrors SapServer's ProfitCentreRow (Models/Bapi/PerformanceModels.cs there, reused by the Production controller).</summary>
public sealed record SapProfitCentreRow(string Material, string ProfitCentre);
