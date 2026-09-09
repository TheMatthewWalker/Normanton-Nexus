namespace NormantonNexus.Models.Dto;

// Logistics Sub-phase 8a.5b — the real SAP purchase-order/goods-receipt
// posting/reversal endpoints deliberately excluded from 8a.5a. See
// ShipmentCostSapPostingHelper's own header comment.

public sealed record PostMigoRequest(List<long> CostIds);

/// <summary>Request body for SapServer's POST /api/purchasing/create-po-and-receipt — mirrors CreatePoAndReceiptItem exactly (PascalCase properties, matching every other SapServerClient request DTO in this codebase).</summary>
public sealed record SapCreatePoAndReceiptItem(
    string? Material, string ShortText, decimal Quantity, string Unit, decimal NetPrice, string DeliveryDate,
    string? AcctAssCat, string? MaterialGroup, string? GlAccount, string? CostCenterOrOrder,
    string Reference, string TrackingNumber, string AddressCode, string ShipmentCompletionDate, string? PostingDate);

public sealed record SapCreatePoAndReceiptRequest(string SapUsername, string SapPassword, string Vendor, string Currency, string? DocDate, List<SapCreatePoAndReceiptItem> Items);

public sealed record SapCreatePoAndReceiptLineResult(int LineNumber, bool Success, string? DocumentNumber, string? Error);

public sealed record SapCreatePoAndReceiptResponse(string PurchaseOrder, bool PoSuccess, List<SapReturnMessage> PoMessages, List<SapCreatePoAndReceiptLineResult> Lines);

/// <summary>One cost line's outcome within POST /post-migo — ShipmentId is whichever ID identifies the group to the caller (outbound shipmentID, inbound poShipmentID, or a manual line's own costID), informational only per Node's own comment.</summary>
public sealed record PostMigoLineResult(long ShipmentId, string Direction, long CostId, bool Success, string? PurchaseOrder, string? MaterialDocument, string? Error);

/// <summary>Error is set (and Results/BlockedCostIds describe why) for the two "nothing was posted" cases Node maps to 400 — no lines delivered yet, or the caller has no saved SAP credentials. Null Error means the normal path: each requested line has its own outcome in Results (which may still individually be Success:false).</summary>
public sealed record PostMigoResult(IReadOnlyList<PostMigoLineResult> Results, IReadOnlyList<long> BlockedCostIds, string? Error);

/// <summary>POST /:costId/reverse — Success mirrors Node's own `reversed` flag (SAP message type "S"), independent of the outer SapServer call itself having succeeded.</summary>
public sealed record ReverseShipmentCostResult(bool Success, string Message, BdcResponse Raw);
