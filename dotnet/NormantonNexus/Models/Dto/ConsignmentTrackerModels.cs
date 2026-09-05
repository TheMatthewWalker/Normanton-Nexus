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

// ── Sub-phase 8e.2: SAP sync + PDF ──────────────────────────────────────────

/// <summary>SapServer's ConsignmentGrRow (api/consignment/gr) — mirrored field-for-field.</summary>
public sealed record ConsignmentGrRow(
    string Material, string MaterialDocument, string MaterialDocItem, decimal Quantity, string Uom, string Vendor,
    string DocumentDate, string PostingDate, string InvoiceNumber, string ReversalOfMaterialDocument, string ReversalOfMaterialDocItem);

/// <summary>Already-parsed (SAP dd.mm.yyyy -> DateTime) GR row, ready for ConsignmentTrackerHelper.UpsertDeliveriesFromSapAsync.</summary>
public sealed record SapDeliveryRow(
    string Material, string MaterialDocument, string MaterialDocItem, decimal Quantity, string? Uom, string? InvoiceNumber,
    DateTime? DocumentDate, DateTime? PostingDate, string? ReversalOfMaterialDocument, string? ReversalOfMaterialDocItem);

public sealed record ConsignmentSyncResult(int Pulled, int Inserted, int CancellationsZeroed, IReadOnlyList<ReversalCancellationReviewRow> NeedsReview);

/// <summary>One vendor's outcome within the daily sync entry point (RunDailySyncAsync) — Skipped covers Node's "inactive or no SapVendorNumber" case; Error covers a per-vendor sync failure that must not abort the rest of the batch.</summary>
public sealed record VendorSyncOutcome(string VendorName, bool Skipped, int? Pulled, int? Inserted, int? CancellationsZeroed, int? NeedsReviewCount, string? Error);

public sealed record StockSnapshotSyncOutcome(int? MaterialCount, string? Error);

public sealed record DailySyncResult(IReadOnlyList<VendorSyncOutcome> Vendors, StockSnapshotSyncOutcome StockSnapshot);

/// <summary>Per-material Starting Stock/Deliveries/Consumption/Ending Stock for one declaration's printable header — see ConsignmentDeclarationPdfHelper.</summary>
public sealed record DeclarationMaterialSummary(string Material, decimal StartingStock, decimal Deliveries, decimal Consumption, decimal EndingStock);
