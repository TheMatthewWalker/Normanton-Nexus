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

/// <summary>Mirrors SapServer's BomQuery — GET (with a JSON body) /api/production/bom. Component is an optional server-side filter down to a single BOM line — used by DrummingHelper's braid-consumption backflush to look up just one component's ratio instead of the whole BOM.</summary>
public sealed record SapBomQuery(string Material, string? Component = null);

/// <summary>Mirrors SapServer's BomRow field-for-field (raw SAP shape, before profit-centre enrichment — see BomHelper.FetchBomAsync).</summary>
public sealed record SapBomRow(string Material, string Plant, string Component, string Item, decimal ComponentQty, string ComponentUnit, string StorageLocation);

/// <summary>Mirrors SapServer's ProfitCentresRequest — GET (with a JSON body) /api/production/check-profit-centres (bulk).</summary>
public sealed record SapProfitCentresRequest(List<string> Materials);

/// <summary>Mirrors SapServer's ProfitCentreRow (Models/Bapi/PerformanceModels.cs there, reused by the Production controller).</summary>
public sealed record SapProfitCentreRow(string Material, string ProfitCentre);

/// <summary>Mirrors SapServer's SapReturnMessage (Models/Bapi/SapModels.cs there).</summary>
public sealed record SapReturnMessage(string Type, string Message);

/// <summary>Mirrors SapServer's GoodsMovementComponent field-for-field.</summary>
public sealed record SapGoodsMovementComponent(string Material, decimal Quantity, string Unit, string? StorageLocation);

/// <summary>
/// Mirrors SapServer's GoodsMovementRequest (POST /api/production/
/// goods-movement-backflush, BAPI_GOODSMVT_CREATE) — Normanton-Nexus's
/// concession path: when a job's traceability was approved to proceed
/// despite not matching this material's BOM, this posts every component
/// explicitly (correct ones included, not just the substituted one)
/// instead of the normal automatic ZF40N backflush.
/// </summary>
public sealed record SapGoodsMovementRequest(string Material, string Header, List<SapGoodsMovementComponent> Components);

/// <summary>Mirrors SapServer's GoodsMovementResponse exactly.</summary>
public sealed record SapGoodsMovementResponse(string MaterialDocument, string MaterialDocumentYear, bool Success, List<SapReturnMessage> Messages);

/// <summary>
/// Mirrors SapServer's DrumBackflushRequest (POST /api/production/
/// drumming-backflush) field-for-field — Drumming's one point of difference
/// from every other production process: the finished drum also needs a row
/// in two custom SAP tables (ZPRODBATCH_TBL/ZBATCHPACK_TBL) via
/// Z_ZPRODBATCH_MAINT, chained on server-side after the plain ZF40N
/// backflush. TraceabilityMaterials are the *materials* of the operator's
/// linked traceability parents (resolved portal-side — SapServer has no
/// access to prod.ProductionTrace), checked against this material's BOM for
/// the informational bomMismatch flag below.
/// </summary>
public sealed record SapDrumBackflushRequest(string Material, decimal Quantity, string Header, string Customer, string PackCode, decimal WeightKg, List<string> TraceabilityMaterials);

/// <summary>Mirrors SapServer's DrumBackflushResponse field-for-field. Backflush carries the same Type/MessageClass/MessageNumber the plain ZF40N backflush does (validated the same way as ProductionSapHelpers.ParseSapBackflush, just nested one level deeper) — everything else is only populated once the backflush itself produced a material document.</summary>
public sealed record SapDrumBackflushResponse(BdcResponse Backflush, string MaterialDocument, string Batch, string RcBatch, string RcPack, bool BomMismatch, string[] ExpectedComponents, string[] ActualComponents);

/// <summary>Mirrors SapServer's FindBackflushDocumentRequest — POST /api/production/find-backflush-document (MSEG, movement 131). Looks up the original backflush material document for a batch — used by the re-drum reversal chain (RedrumReversalHelper) to find what to reverse via MF41 before a batch-managed product is returned into stock.</summary>
public sealed record FindBackflushDocumentRequest(string Batch);

/// <summary>Mirrors SapServer's BackflushDocumentRow field-for-field — the original 131 (backflush) movement for a batch, found via MSEG. SapServer returns HTTP 400 (not a 200 with an empty row) when no matching movement exists — see RedrumReversalHelper's catch on SapProxyException.StatusCode == 400 for the normal, non-redrum case.</summary>
public sealed record BackflushDocumentRow(string MaterialDocument, string Material, decimal Quantity, string StorageLocation);
