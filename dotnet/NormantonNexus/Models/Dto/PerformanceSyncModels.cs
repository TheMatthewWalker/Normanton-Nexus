namespace NormantonNexus.Models.Dto;

// ── Logistics Sub-phase 8b.6: refresh orchestration ────────────────────────
// Raw SAP-pull row shapes (SapServer's PerformanceController/MrpAnalysisController
// response DTOs, mirrored field-for-field) plus the mutable in-flight sync rows
// that get enriched across multiple passes (allocation, value-stream mapping,
// delivery->order resolution) before being persisted — mutable classes, not
// records, matching routes/performancesync.js's own plain-object-mutation
// pipeline (allocateStock/resolveDeliveryReferenceDocuments/enrichWithValueStream
// all mutate rows in place rather than rebuilding them).

/// <summary>SAP LQUA pull (GET SapServer /api/performance/stock) — one row per batch/bin in warehouse 312.</summary>
public sealed class SapPerformanceStockRow
{
    public string Material { get; init; } = "";
    public string Batch { get; init; } = "";
    public string StorageBin { get; init; } = "";
    public string StorageType { get; init; } = "";
    public decimal TotalQty { get; init; }
    public decimal AvailableQty { get; init; }
    public string? StorageLocation { get; init; }
    public string? PackagingMaterial { get; init; }
    public string? ProfitCentre { get; init; }

    /// <summary>Stamped by ValueStreamHelper.EnrichWithValueStream after the pull — null (excluded from the snapshot) when ProfitCentre maps to no known value stream.</summary>
    public string? ValueStream { get; set; }
}

/// <summary>SAP Z_STOCK_REQ_LIST pull (GET SapServer /api/performance/agreements) — one row per open requirement, enriched in three passes before being persisted: value-stream mapping, delivery-&gt;order resolution (VBFA), then FIFO stock allocation.</summary>
public sealed class SapAgreementRow
{
    public string? ProfitCentre { get; init; }
    public string? Plant { get; init; }
    public string? Mid { get; init; }
    public string? MrpController { get; init; }
    public string Material { get; init; } = "";
    public string? MaterialText { get; init; }
    public decimal OnHandQty { get; init; }
    public string? Uom { get; init; }
    public decimal StandardPrice { get; init; }
    public string? LocalCurrency { get; init; }
    public string? Customer { get; init; }
    public string? CustomerGroup { get; init; }
    public string? CustomerName { get; init; }
    public string? OrderType { get; init; }
    public string ReferenceDocument { get; init; } = "";
    public string? Item { get; init; }
    public string? CustomerPo { get; init; }
    public string? CustomerMaterial { get; init; }
    public string? CustomerReference { get; init; }
    public string? UnloadingPoint { get; init; }
    public DateTime RequestDate { get; init; }
    public string? Week { get; init; }
    public string? Period { get; init; }
    public decimal OrderQty { get; init; }
    public decimal Amount { get; init; }
    public string? Currency { get; init; }
    public decimal LocalAmount { get; init; }

    /// <summary>Stamped by ValueStreamHelper.EnrichWithValueStream (from ProfitCentre).</summary>
    public string? ValueStream { get; set; }

    /// <summary>Pass-through default = ReferenceDocument/Item; VBFA-resolved to the real sales order when ReferenceDocument is delivery-shaped — see DeliveryOrderLinkHelper.</summary>
    public string OriginalDoc { get; set; } = "";
    public string OriginalDocItem { get; set; } = "";

    /// <summary>Stamped by StockAllocationHelper.AllocateStock.</summary>
    public decimal DockStockAllocated { get; set; }
    public decimal PickedStockAllocated { get; set; }
}

/// <summary>SAP VBFA document-flow pull (GET SapServer /api/performance/vbfa-order-link/{delivery}).</summary>
public sealed record SapVbfaOrderLinkRow(string DeliveryItem, string OrderNumber, string OrderItem);

/// <summary>SAP Z_SALE_ANAL_HIST pull (GET SapServer /api/performance/invoicing).</summary>
public sealed class SapInvoiceRow
{
    public string? Plant { get; init; }
    public string? SalesOrg { get; init; }
    public DateTime InvoiceDate { get; init; }
    public string? InvoiceType { get; init; }
    public string? InvoiceNumber { get; init; }
    public string? DeliveryNote { get; init; }
    public string? SalesAgreement { get; init; }
    public string? SalesItem { get; init; }
    public string? CustomerPo { get; init; }
    public string? CustomerGroup { get; init; }
    public string? Customer { get; init; }
    public string Material { get; init; } = "";
    public string? MaterialText { get; init; }
    public decimal Quantity { get; init; }
    public decimal DocumentAmount { get; init; }
    public decimal LocalAmount { get; init; }
    public string? Currency { get; init; }
    public string? ProfitCentre { get; init; }
    public string? Period { get; init; }

    public string? ValueStream { get; set; }
}

/// <summary>SAP Z_CUST_INDEX_ANALYSE pull (GET SapServer /api/performance/otif).</summary>
public sealed class SapOtifRow
{
    public string? Customer { get; init; }
    public string? CustomerName { get; init; }
    public string? Plant { get; init; }
    public string? ProfitCentre { get; init; }
    public string Material { get; init; } = "";
    public string? MaterialText { get; init; }
    public string? Delivery { get; init; }
    public DateTime DeliveryDate { get; init; }
    public decimal DeliveryQty { get; init; }
    public string? Uom { get; init; }
    public DateTime TargetDate { get; init; }
    public decimal TargetQty { get; init; }
    public string? QtyClass { get; init; }
    public string? DateClass { get; init; }

    /// <summary>Mirrors the workbook's OTIF_basis formula: DateClass != "D+".</summary>
    public bool OnTime => DateClass != "D+";

    public string? ValueStream { get; set; }
}

/// <summary>SAP mm_turns_valclass.xlsm pull (GET SapServer /api/performance/turns-valclass) — one row per material (or per Material+Plant+ValuationType for a split-valuated material, before TurnsValClassSyncHelper.Dedupe merges those).</summary>
public sealed class SapTurnsValClassRow
{
    public string Material { get; init; } = "";
    public string? MaterialText { get; init; }
    public DateTime? CreatedDate { get; init; }
    public string? MaterialType { get; init; }
    public string? Uom { get; init; }
    public string Plant { get; init; } = "";
    public string? ProfitCentre { get; init; }
    public bool DeletionFlag { get; init; }
    public string? AbcIndicator { get; init; }
    public string? PurchasingGroup { get; init; }
    public string? MrpController { get; init; }
    public string? ValuationClass { get; init; }
    public string? LotSizeProcedure { get; init; }
    public decimal PlanningTimeFence { get; init; }
    public decimal GrProcessingTime { get; init; }
    public decimal TotalReplenishmentTime { get; init; }
    public decimal SafetyStock { get; init; }
    public decimal MinLotSize { get; init; }
    public decimal MaxLotSize { get; init; }
    public decimal FixedLotSize { get; init; }
    public decimal RoundingValue { get; init; }
    public string? SpecialProcurementType { get; init; }
    public decimal PlannedDeliveryTime { get; init; }

    public decimal StockQty { get; set; }
    public decimal StockValue { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal BookValue { get; set; }
    public decimal ConsignmentQty { get; init; }

    /// <summary>13 rolling months, index 0 = 12 months out (oldest), index 12 = current (partial) month.</summary>
    public decimal[] DemandForecast { get; init; } = new decimal[13];
    public decimal[] ConsumptionHistory { get; init; } = new decimal[13];

    /// <summary>36 rolling months (M-35..Current) — feeds PredictedUsageHelper.ComputePredictedUsage, never persisted directly.</summary>
    public decimal[] ConsumptionHistory36 { get; init; } = new decimal[36];

    /// <summary>Attached by PredictedUsageHelper after the pull, same 13-slot shape as DemandForecast — not part of the raw SAP response.</summary>
    public decimal[] PredictedUsage { get; set; } = new decimal[13];

    public DateTime? LastReceiptDate { get; init; }
    public DateTime? LastGoodsIssueDate { get; init; }
    public DateTime? LastConsumptionDate { get; init; }
    public DateTime? LastGoodsMovementDate { get; init; }

    public decimal? StockTurns { get; init; }
    public decimal? DaysInStock { get; init; }
    public decimal DailyRequirementValue { get; init; }
    public string? TurnoverCategory { get; init; }
    public string? Warning { get; init; }
}

/// <summary>SAP T025/T025T/T134 pull (GET SapServer /api/performance/turns-valclass/valuation-classes).</summary>
public sealed record SapValuationClassRow(string ValuationClass, string MaterialType, string? AccountRef, string? Description);

/// <summary>SAP MVER pull, totalled per fiscal year (GET SapServer /api/mrp-analysis/consumption-by-year).</summary>
public sealed record SapConsumptionByYearRow(string Material, int FiscalYear, decimal Qty);

/// <summary>SAP MSEG/MKPF+EKKO pull, already aggregated per material/vendor/year (GET SapServer /api/mrp-analysis/goods-receipt-history).</summary>
public sealed record SapGoodsReceiptHistoryRow(string Material, string? Vendor, int Year, decimal Qty, string? Uom);

// ── Refresh orchestration results ──────────────────────────────────────────

/// <summary>One dataset's outcome from a refresh run — Node's own untyped {name,status,rowCount|error} shape, typed.</summary>
public sealed record RefreshDatasetOutcome(string Name, string Status, int? RowCount = null, string? Error = null);

// ── Delivery -&gt; order link cache (log.DeliveryOrderLink) ──────────────────

public sealed record DeliveryOrderLinkRow(string DeliveryNumber, string DeliveryItem, string OrderNumber, string OrderItem);
