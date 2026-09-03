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
