namespace NormantonNexus.Models.Dto;

// Vendor Consignment Tracker — Logistics Sub-phase 8e.1 (DB/algorithm
// core). Port of routes/consignmentsql.js's DTOs. See
// ConsignmentTrackerHelper's own header comment for the real, deployed
// schema (log.* in NexusOperations) vs. sql/migrate_consignment_tracker.sql's
// stale dbo./"kongsberg database" draft.

public sealed record ConsignmentVendorRow(
    long VendorId, string VendorName, string? SapVendorNumber, string? Currency,
    bool TrackExpiry, int? ExpiryWarningDays, int? ExpiryDays, string DefaultAllocationMethod,
    bool Active, string? Notes, DateTime? UpdatedAtUtc, string? UpdatedByUsername);

public sealed record VendorMaterialRow(long VendorMaterialId, string Material, string? ScheduleAgreement);

public sealed record ConsignmentVendorDetail(ConsignmentVendorRow Vendor, IReadOnlyList<VendorMaterialRow> Materials);

/// <summary>PUT /vendors/:vendorId/config — null fields fall back to the same defaults upsertConsignmentVendorConfig itself applies (TrackExpiry false, DefaultAllocationMethod "FIFO", Active true).</summary>
public sealed record UpsertConsignmentVendorConfigRequest(
    bool? TrackExpiry, int? ExpiryWarningDays, int? ExpiryDays, string? DefaultAllocationMethod, bool? Active, string? Notes);

public sealed record ConsignmentDeliveryRow(
    long DeliveryId, long VendorId, string Material, string MaterialDocument, string MaterialDocItem,
    decimal Quantity, string? Uom, string? Container, string? BillOfLading, string? InvoiceNumber,
    DateTime? DocumentDate, DateTime? PostingDate, decimal RemainingQty, string Source,
    DateTime CreatedAtUtc, string? CreatedByUsername, DateTime? ExpiryDate,
    string? ReversalOfMaterialDocument, string? ReversalOfMaterialDocItem);

public sealed record AddManualConsignmentDeliveryRequest(
    string Material, string? MaterialDocument, string? MaterialDocItem, decimal Quantity, string? Uom,
    string? Container, string? BillOfLading, string? InvoiceNumber, DateTime? DocumentDate, DateTime? PostingDate,
    DateTime? ExpiryDate, string? Source);

public sealed record UpdateConsignmentDeliveryRequest(string? InvoiceNumber, string? Container, string? BillOfLading, DateTime? ExpiryDate);

public sealed record CsvImportDeliveriesRequest(List<AddManualConsignmentDeliveryRequest> Rows);

public sealed record CsvImportResult(int Imported, int Skipped);

// ── Reversal-chain cancellation (pure, no DB — see ComputeReversalCancellations) ──

public sealed record ReversalCancellationZeroedRow(long DeliveryId, string Material, string MaterialDocument, string MaterialDocItem, decimal Quantity);

public sealed record ReversalCancellationReviewRow(long DeliveryId, string Material, string MaterialDocument, string MaterialDocItem, decimal Quantity, decimal RemainingQty, string Reason);

public sealed record ReversalCancellationResult(IReadOnlyList<ReversalCancellationZeroedRow> Zeroed, IReadOnlyList<ReversalCancellationReviewRow> NeedsReview);

// ── Balance dashboard ──────────────────────────────────────────────────────

public sealed record VendorBalanceMaterialRow(string Material, decimal Delivered, decimal CurrentStock, decimal Declared, decimal Undeclared);

public sealed record ConsignmentStockSnapshotMeta(int MaterialCount, DateTime? LastSnapshotAtUtc);

public sealed record VendorBalanceResult(
    ConsignmentVendorRow Vendor, IReadOnlyList<VendorBalanceMaterialRow> Materials,
    IReadOnlyList<ConsignmentDeliveryRow> ExpiryWarnings, ConsignmentStockSnapshotMeta StockSnapshot);

// ── FEFO/FIFO/manual allocation proposal (pure, no DB — see BuildAllocationProposal) ──

public sealed record AllocationProposalLine(
    long DeliveryId, string Material, decimal QtyAllocated, string? InvoiceNumber,
    DateTime? ExpiryDate, DateTime? DocumentDate, decimal RemainingBeforeAllocation);

public sealed record AllocationProposalResult(string Method, IReadOnlyList<AllocationProposalLine> Lines, decimal UnallocatedQty, IReadOnlyList<ConsignmentDeliveryRow> OpenLines);

public sealed record ProposeDeclarationRequest(string Material, decimal QtyToDeclare, string? Method);

// ── Declarations ───────────────────────────────────────────────────────────

public sealed record CreateDeclarationLineRequest(long DeliveryId, string Material, decimal QtyAllocated);

public sealed record CreateDeclarationRequest(string? AllocationMethod, List<CreateDeclarationLineRequest> Lines);

public sealed record SetDeclarationLinesRequest(List<CreateDeclarationLineRequest> Lines);

public sealed record ConsignmentDeclarationLineRow(
    long DeclarationLineId, long DeliveryId, string Material, decimal QtyAllocated,
    string? InvoiceNumber, string? MaterialDocument, DateTime? DocumentDate, string? Uom, DateTime? ExpiryDate);

public sealed record ConsignmentDeclarationSummaryRow(
    long DeclarationId, long VendorId, string VendorName, string Status, string AllocationMethod, decimal TotalQty,
    DateTime CreatedAtUtc, string? CreatedByUsername, DateTime? ConfirmedAtUtc, string? ConfirmedByUsername,
    string? SettlementDocumentNumber, decimal? SettlementReconciledQty, string? Notes);

public sealed record ConsignmentDeclarationDetail(ConsignmentDeclarationSummaryRow Header, IReadOnlyList<ConsignmentDeclarationLineRow> Lines);

public sealed record ConfirmDeclarationRequest(string? SettlementDocumentNumber, decimal? SettlementReconciledQty);

// ── Reassigning declarations off cancelled stock (pure algorithm + DB read/write — ported but not wired to any route, matching Node: real, unit-tested, but genuinely unrouted there too) ──

public sealed record CancelledDeclarationLine(long DeclarationLineId, long DeclarationId, long CancelledDeliveryId, string Material, decimal QtyAllocated);

public sealed record OpenDeliveryForReassignment(long DeliveryId, string Material, decimal RemainingQty, DateTime? ExpiryDate, DateTime? DocumentDate);

public sealed record ReassignmentSplit(long DeliveryId, decimal Qty);

public sealed record ReassignmentPlanItem(long DeclarationLineId, long DeclarationId, string Material, long CancelledDeliveryId, decimal TotalQty, IReadOnlyList<ReassignmentSplit> Splits, decimal Shortfall);

public sealed record ReassignmentApplyResult(IReadOnlyList<ReassignmentPlanItem> Applied, IReadOnlyList<ReassignmentPlanItem> Skipped);
