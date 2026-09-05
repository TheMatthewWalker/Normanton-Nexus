namespace NormantonNexus.Models.Dto;

// ── Logistics Sub-phase 8b.7: real elevated SAP PO creation + PO PDF ──────
// Port of routes/performance.js's POST /order-suggestions/create-po and
// POST /order-suggestions/regenerate-pdf. Runs under the calling user's own
// SAP credentials (My Account -> SAP Credentials), not the shared service
// account — see SapServer's PurchasingController.CreatePurchaseOrderElevated
// for why the shared account can't create POs at all.

public sealed record PriceOverride(long SuggestionId, decimal? NetPrice);

/// <summary>priceOverrides/currency/docDate are all optional — price is deliberately left out per line unless explicitly overridden, so SAP's own purchasing info record / condition determination (ME12) prices the line instead; currency defaults to the vendor's own Currency field; docDate defaults to today.</summary>
public sealed record CreatePoRequest(List<long>? SuggestionIds, List<PriceOverride>? PriceOverrides, string? Currency, DateTime? DocDate);

public sealed record CreatePoResult(string PurchaseOrder, IReadOnlyList<long> SuggestionIds, IReadOnlyList<SapReturnMessage> Messages, bool PoPdfSaved, string? PoPdfError);

public sealed record RegeneratePoPdfRequest(string? PoNumber);

public sealed record RegeneratePoPdfResult(string PurchaseOrder, bool PoPdfSaved);

// ── SapServer's PurchasingController.CreatePurchaseOrderElevated contract ──

/// <summary>Mirrors SapServer's PoCreateItem — only the 6 fields the MRP order-suggestion flow ever sends (AcctAssCat/MaterialGroup/GlAccount/CostCenterOrOrder are for expense-type lines, not applicable to a raw-material stock PO, so they're left null/absent).</summary>
public sealed record SapPoCreateElevatedItem(string? Material, string ShortText, decimal Quantity, string Unit, decimal? NetPrice, string DeliveryDate);

public sealed record SapPoCreateElevatedRequest(string SapUsername, string SapPassword, string Vendor, string Currency, string? DocDate, List<SapPoCreateElevatedItem> Items);

public sealed record SapPoCreateElevatedResponse(string PurchaseOrder, bool Success, List<SapReturnMessage> Messages);
