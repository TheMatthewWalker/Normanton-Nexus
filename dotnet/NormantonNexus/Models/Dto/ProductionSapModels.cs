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
