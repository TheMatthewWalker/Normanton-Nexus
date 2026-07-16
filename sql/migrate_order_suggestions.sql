/* ============================================================
   MRP Phase 2b — order suggestions. Run against the kongsberg database.
   Compatibility : SQL Server 2005+ (matches create_performance_turnsvalclass_database.sql
   and migrate_vendor_master_data.sql — no GO, no CONCAT(), no DATETIME2).

   dbo.PurchaseOrderSuggestion is NOT where "what needs ordering" is computed —
   that list is worked out live, on every request, in Node (routes/performance.js
   GET /order-suggestions) from TurnsValClassSnapshot (stock + predicted usage)
   joined against dbo.Vendor / dbo.VendorMaterial (lead time, Incoterms, transit
   time, MOQ, safety stock). This table only starts existing once a suggestion
   is ACCEPTED — it's the record of "we decided to order this", not the
   suggestion engine's working data. Keeping the live computation out of SQL
   means the trigger logic can change freely without a migration; only
   accepted decisions are durable.

   TRIGGER LOGIC (Node, for reference — not enforced here). Deliberately NOT
   just-in-time: this business sees frequent supplier date slips, so ordering
   is triggered off a maintained safety-stock FLOOR, not off hitting zero.
     safetyStockQty = VendorMaterial.MinSafetyStockQty
                       ?? TurnsValClassSnapshot.SafetyStock (SAP MARC-EISBE)
                       ?? 0
     Stock is projected forward week-by-week using PredictedUsage (same
     spreading as buildWeeklyStockForecast in routes/performance.js) to find
     the date stock is projected to drop to/below safetyStockQty (breachDate).
     A material needs ordering when placing the order today wouldn't get
     replacement stock there before that floor is breached:
       leadTimeDays = VendorMaterial.LeadTimeDaysOverride
                       ?? TurnsValClassSnapshot.PlannedDeliveryTime (SAP PLIFZ)
                       ?? Vendor.DefaultLeadTimeDays ?? 0
       orderByDate  = breachDate - leadTimeDays (WORKING days — see
                       addWorkingDaysUtc in routes/performance.js; SAP's
                       PLIFZ and this app's lead/transit time fields are all
                       working-day figures, so the date math skips weekends)
     Surfaced once orderByDate falls within a review window (today + 14
     calendar days — the review window itself is not a lead-time figure, so
     it stays on calendar days); flagged "Overdue" if orderByDate has
     already passed.

   SUGGESTED QTY (Node): demand over (leadTimeDays + 30 calendar-day buffer),
   plus safetyStockQty (the same floor used for the trigger, so the order
   actually rebuilds the buffer rather than just topping up to it), minus
   current stock, minus anything already incoming (this table's Accepted/
   Ordered rows for that material) — then, if the material has a MOQ
   (VendorMaterial.MaterialMoqQty), rounded UP to the next whole multiple of
   it. MOQ here is a LOT SIZE, not just a floor: a vendor supplying in 1000kg
   lots gets ordered 1000/2000/3000kg etc, never a raw shortfall like 1300kg.
   If the material also has a ceiling (VendorMaterial.MaterialMaxQty), the
   result is clamped down to the largest whole lot that still fits under it.

   Both MaterialMoqQty/MaterialMaxQty (per material) and OrderMoqQty/
   OrderMaxQty (per vendor, see below) are ENFORCED, not just hinted at in
   the UI: enforceMaterialQty()/validateVendorCombinedQty() in routes/
   performance.js re-derive the current constraints fresh from the DB at
   accept time (not trusting whatever the client submitted) and either
   auto-snap the quantity (material level — always correctable, since
   there's only one number to adjust) or hard-block the request with a 400
   (vendor combined level — NOT auto-correctable, since there's no
   non-arbitrary way to decide which material in a multi-material order to
   bump or trim).

   The vendor's combined order-level MOQ (dbo.Vendor.OrderMoqQty, spanning
   multiple materials) IS actively managed: GET /order-suggestions groups the
   list by vendor and tallies the combined suggested quantity against it
   (groupSuggestionsByVendor), and the Build Order modal (GET /order-
   suggestions/vendor/:vendorId/build, POST /order-suggestions/accept-batch)
   lets a buyer pull in materials that aren't urgent yet to close a gap and
   accept several materials from one vendor as a single batch under one
   OrderDate. dbo.Vendor.OrderMaxQty is the same idea as a ceiling; when
   OrderMaxQty equals OrderMoqQty the combined order must be an EXACT amount
   (e.g. Raaj Ratna: exactly 20,000kg per order, no more, no less) rather
   than just a minimum — groupSuggestionsByVendor's isExactQty flag and the
   Build Order modal both branch on this case specifically.

   DATES stamped onto this table at accept time (see migrate_vendor_master_data.sql's
   DATE MATH block for the full reasoning):
     DeliveryDate       = OrderDate + LeadTimeDaysUsed (working days)
     ReadyToCollectDate = OrderDate + LeadTimeDaysUsed - TransitTimeDaysUsed
                           (working days; EXW vendors only — the date
                           actually quoted to the supplier; NULL for every
                           other Incoterm)
   Snapshotted rather than recalculated live, so a later change to a vendor's
   lead time or transit time doesn't silently rewrite the dates on an order
   that's already been placed.

   STATUS LIFECYCLE: Accepted -> Ordered -> Received, or -> Cancelled at any
   point before Received. A row only exists once a suggestion has been
   accepted — there is deliberately no "Suggested" status stored here.
   ============================================================ */


/* ── 1. PurchaseOrderSuggestion ───────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.PurchaseOrderSuggestion') AND type = 'U')
BEGIN
  CREATE TABLE dbo.PurchaseOrderSuggestion (
    SuggestionId          INT           NOT NULL IDENTITY(1,1),
    VendorId              INT           NOT NULL,
    VendorMaterialId      INT           NOT NULL,
    Material              NVARCHAR(18)  NOT NULL,   -- denormalised for easy joins against TurnsValClassSnapshot

    Status                NVARCHAR(20)  NOT NULL DEFAULT 'Accepted',  -- Accepted / Ordered / Received / Cancelled

    -- What the engine suggested at accept time vs. what was actually ordered
    -- (the accept modal lets the qty be adjusted before saving).
    SuggestedQty           DECIMAL(15,3) NULL,
    OrderQty                DECIMAL(15,3) NOT NULL,
    OrderDate                DATETIME      NOT NULL,

    -- Snapshotted at accept time — see header DATES note above for why these
    -- aren't recalculated live from the current vendor record.
    LeadTimeDaysUsed          DECIMAL(9,2)  NULL,
    DeliveryDate               DATETIME      NULL,
    TransitTimeDaysUsed         DECIMAL(9,2)  NULL,
    ReadyToCollectDate            DATETIME      NULL,   -- EXW vendors only, NULL otherwise

    -- Snapshotted from VendorMaterial.ScheduleAgreement being blank at accept
    -- time: this material has no SAP scheduling agreement, so it'll need a
    -- spot PO raised manually in SAP rather than a release against one.
    IsSpotPo                       BIT           NOT NULL DEFAULT 0,

    -- Filled in by hand once the PO/release actually exists in SAP — no live
    -- SAP write-back yet (see Notes below).
    PoNumber                        NVARCHAR(20)  NULL,
    Notes                            NVARCHAR(500) NULL,

    CreatedAtUtc                     DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    UpdatedAtUtc                     DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    ReceivedAtUtc                    DATETIME      NULL,

    CONSTRAINT PK_PurchaseOrderSuggestion PRIMARY KEY (SuggestionId),
    CONSTRAINT FK_POS_Vendor FOREIGN KEY (VendorId) REFERENCES dbo.Vendor (VendorId),
    CONSTRAINT FK_POS_VendorMaterial FOREIGN KEY (VendorMaterialId) REFERENCES dbo.VendorMaterial (VendorMaterialId)
  );

  -- Used by the suggestion engine to find "already covered" materials (open
  -- Accepted/Ordered rows) so it doesn't keep re-flagging something already
  -- on order, and by the forecast-graph incoming-stock overlay.
  CREATE INDEX IX_POS_Material ON dbo.PurchaseOrderSuggestion (Material) INCLUDE (Status, OrderQty, DeliveryDate);
  CREATE INDEX IX_POS_Status   ON dbo.PurchaseOrderSuggestion (Status) INCLUDE (OrderDate, Material, OrderQty, DeliveryDate, VendorId);

  PRINT 'Created dbo.PurchaseOrderSuggestion';
END
ELSE
  PRINT 'dbo.PurchaseOrderSuggestion already exists — skipped';


/* ── Verify ───────────────────────────────────────────────────────────────────── */


SELECT 'PurchaseOrderSuggestion' AS TableName, COUNT(*) AS Rows FROM dbo.PurchaseOrderSuggestion;
