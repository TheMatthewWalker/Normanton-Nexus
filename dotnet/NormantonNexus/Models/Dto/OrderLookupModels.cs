namespace NormantonNexus.Models.Dto;

// Order Lookup + Drumming Ticket — port of the "Drumming Ticket / Order
// Lookup" section of routes/productionnexus.js. Searches log.AgreementSnapshot
// (same NexusOperations database the rest of Production uses, just a
// different schema) — unlike the Production Schedule report, this is
// PTFE-only-free and unwindowed: every open value stream, every due date,
// since an operator drumming up an order needs to find it regardless of
// which report bucket it'd otherwise fall into.

/// <summary>
/// ReferenceDocument/Item here are OriginalDoc/OriginalDocItem, not the raw
/// AgreementSnapshot columns — without this, an operator searching by order
/// number (or reprinting a ticket) for a line that's just been picked would
/// get "no open items found", because SAP has already flipped that line's
/// raw ReferenceDocument to the delivery number.
/// </summary>
public sealed record AgreementLookupRow(
    string Customer, string? CustomerName, string ReferenceDocument, string Item, string Material, string? MaterialText,
    string? CustomerMaterial, string? ValueStream, DateTime? RequestDate, decimal OrderQty, string? Uom,
    decimal? StockQty, decimal? RequiredQty);

/// <summary>The three pieces buildDrummingTicketHTML combines: the AgreementSnapshot line itself, the customer's standing instructions, and a live (deliberately uncached — "process critical") SAP special-instructions text lookup.</summary>
public sealed record DrummingTicketData(AgreementLookupRow Line, string CustomerStandardInstructions, string SapInstructions);
