/* ============================================================
   MRP Phase 2c — inbound shipment tracking + supplier references. Run
   against the kongsberg database. Compatibility : SQL Server 2005+
   (matches migrate_order_suggestions.sql / migrate_vendor_master_data.sql —
   no GO, no CONCAT(), no DATETIME2).

   Two independent ways to reconcile a PurchaseOrderSuggestion order against
   what actually happens in the real world, added at the user's request:

   1. dbo.PurchaseOrderShipment — an inbound shipment/load record, modelled
      after Logistics.dbo.ShipmentMain's role in the Open Deliveries / TMS
      workflow (select lines, Create Shipment) but much lighter — no
      pallets, customs, or PDF documents, since none of that applies to a
      purchase order arriving from a vendor:
        ShipmentReference — AUTO-GENERATED at creation as "INB-NNNNNN" from
          the identity value (see performancesql.js's createOrderShipment),
          NOT user-entered, matching the read-only shipmentRef convention
          used for outbound shipments (formatShipmentRef).
        DispatchDate / ExpectedEta — when the load left the vendor / when
          it's due at Kongsberg.
        Haulier / ModeOfTransport / TrackingNumber — who's carrying it, how
          (Road/Sea/Air/Rail/Courier/Other), and their tracking reference.
        BillOfLading / ContainerNumber — for sea/rail freight.
        ReceivedAtUtc / ReceivedBy — stamped when an operator marks the
          shipment received (see STATUS LIFECYCLE below); NULL until then.
        CancelledAtUtc / CancelledBy — stamped by Cancel Shipment (Inbound
          Log). Cancelling unlinks every order on the shipment (sets their
          PurchaseOrderSuggestion.ShipmentId back to NULL, leaving the
          order's own Status untouched) rather than deleting the shipment
          row, so it stays visible for audit. Only possible before the
          shipment is received — a received shipment's orders are already
          Booked, so cancelling would leave them pointing at a dead
          shipment; markShipmentReceived and cancelOrderShipment are
          mutually exclusive terminal states.
      Deliberately separate from Logistics.dbo.ShipmentMain (outbound
      customer deliveries, KN booking API integration) — this is inbound
      only. Several PurchaseOrderSuggestion rows can point at the same
      shipment (several materials/orders consolidated onto one load), via
      the PurchaseOrderSuggestion.ShipmentId FK — nullable, since most
      orders won't have a shipment yet at accept time; a shipment is
      created later by selecting order lines in the Tracked Orders view
      (mirrors Open Deliveries' select-lines-then-Create-Shipment flow) and
      is then managed from the Inbound Log tile.

   2. PurchaseOrderSuggestion.SupplierReference — for vendors who deliver
      themselves rather than going through a haulier (no shipment record
      needed): just the supplier's own order/confirmation number, stamped
      directly on the order line so it can be matched against their
      confirmation. Lives on the order itself, not the shipment, since each
      order line usually carries its own confirmation number even when
      several ship together.

   STATUS LIFECYCLE ADDITION (see migrate_order_suggestions.sql for the
   original Accepted -> Ordered -> Received -> Cancelled chain): a new
   'Booked' status sits between Ordered and Received. Marking a shipment
   received (Inbound Log's "Mark Received" action, routes/performancesql.js's
   markShipmentReceived) bulk-flips every non-cancelled order on that
   shipment to 'Booked' — meaning "physically arrived and logged as
   received, SAP goods-receipt posting is pending/placeholder". The
   existing 'Received' status is left as a manual step for once that SAP
   posting is confirmed. postGoodsReceiptToSap() in performancesql.js is a
   deliberate placeholder — real SAP RFC integration comes later; for now
   it's a no-op called once per order so the real implementation has an
   obvious, already-wired hook to fill in.
   ============================================================ */


/* ── 1. PurchaseOrderShipment ─────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.PurchaseOrderShipment') AND type = 'U')
BEGIN
  CREATE TABLE dbo.PurchaseOrderShipment (
    ShipmentId        INT           NOT NULL IDENTITY(1,1),
    ShipmentReference NVARCHAR(50)  NULL,   -- auto-generated "INB-NNNNNN" — see header note, not user-entered
    DispatchDate      DATETIME      NULL,
    ExpectedEta       DATETIME      NULL,
    Haulier           NVARCHAR(100) NULL,
    ModeOfTransport   NVARCHAR(20)  NULL,   -- Road / Sea / Air / Rail / Courier / Other
    TrackingNumber    NVARCHAR(100) NULL,
    BillOfLading      NVARCHAR(50)  NULL,
    ContainerNumber   NVARCHAR(50)  NULL,
    Notes             NVARCHAR(500) NULL,

    ReceivedAtUtc     DATETIME      NULL,   -- stamped by Mark Received — see STATUS LIFECYCLE note above
    ReceivedBy        NVARCHAR(100) NULL,

    CreatedAtUtc      DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    UpdatedAtUtc      DATETIME      NOT NULL DEFAULT GETUTCDATE(),

    CONSTRAINT PK_PurchaseOrderShipment PRIMARY KEY (ShipmentId)
  );

  PRINT 'Created dbo.PurchaseOrderShipment';
END
ELSE
  PRINT 'dbo.PurchaseOrderShipment already exists — skipped';


/* ── 1b. PurchaseOrderShipment — add dispatch/ETA/B-L/container/received
   columns (existing installs — e.g. if the CREATE TABLE above already ran
   before this update). Same COL_LENGTH()-guarded pattern used elsewhere;
   safe to re-run. */
IF COL_LENGTH('dbo.PurchaseOrderShipment', 'DispatchDate') IS NULL
  ALTER TABLE dbo.PurchaseOrderShipment ADD DispatchDate DATETIME NULL;
IF COL_LENGTH('dbo.PurchaseOrderShipment', 'ExpectedEta') IS NULL
  ALTER TABLE dbo.PurchaseOrderShipment ADD ExpectedEta DATETIME NULL;
IF COL_LENGTH('dbo.PurchaseOrderShipment', 'BillOfLading') IS NULL
  ALTER TABLE dbo.PurchaseOrderShipment ADD BillOfLading NVARCHAR(50) NULL;
IF COL_LENGTH('dbo.PurchaseOrderShipment', 'ContainerNumber') IS NULL
  ALTER TABLE dbo.PurchaseOrderShipment ADD ContainerNumber NVARCHAR(50) NULL;
IF COL_LENGTH('dbo.PurchaseOrderShipment', 'ReceivedAtUtc') IS NULL
  ALTER TABLE dbo.PurchaseOrderShipment ADD ReceivedAtUtc DATETIME NULL;
IF COL_LENGTH('dbo.PurchaseOrderShipment', 'ReceivedBy') IS NULL
  ALTER TABLE dbo.PurchaseOrderShipment ADD ReceivedBy NVARCHAR(100) NULL;

PRINT 'dbo.PurchaseOrderShipment dispatch/ETA/B-L/container/received columns verified/added';


/* ── 1c. PurchaseOrderShipment — add CancelledAtUtc/CancelledBy columns
   (existing installs). Same COL_LENGTH()-guarded pattern used elsewhere;
   safe to re-run. */
IF COL_LENGTH('dbo.PurchaseOrderShipment', 'CancelledAtUtc') IS NULL
  ALTER TABLE dbo.PurchaseOrderShipment ADD CancelledAtUtc DATETIME NULL;
IF COL_LENGTH('dbo.PurchaseOrderShipment', 'CancelledBy') IS NULL
  ALTER TABLE dbo.PurchaseOrderShipment ADD CancelledBy NVARCHAR(100) NULL;

PRINT 'dbo.PurchaseOrderShipment CancelledAtUtc/CancelledBy columns verified/added';


/* ── 2. PurchaseOrderSuggestion — add ShipmentId column (existing installs)
   Same COL_LENGTH()-guarded pattern used for TransitTimeDays/OrderMaxQty in
   migrate_vendor_master_data.sql — safe to re-run every time this script
   executes. */
IF COL_LENGTH('dbo.PurchaseOrderSuggestion', 'ShipmentId') IS NULL
  ALTER TABLE dbo.PurchaseOrderSuggestion ADD ShipmentId INT NULL;

PRINT 'dbo.PurchaseOrderSuggestion ShipmentId column verified/added';

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_POS_Shipment')
  ALTER TABLE dbo.PurchaseOrderSuggestion
    ADD CONSTRAINT FK_POS_Shipment FOREIGN KEY (ShipmentId) REFERENCES dbo.PurchaseOrderShipment (ShipmentId);

PRINT 'dbo.PurchaseOrderSuggestion FK_POS_Shipment verified/added';

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_POS_Shipment')
  CREATE INDEX IX_POS_Shipment ON dbo.PurchaseOrderSuggestion (ShipmentId);

PRINT 'dbo.PurchaseOrderSuggestion IX_POS_Shipment verified/added';


/* ── 3. PurchaseOrderSuggestion — add SupplierReference column (existing installs) ── */
IF COL_LENGTH('dbo.PurchaseOrderSuggestion', 'SupplierReference') IS NULL
  ALTER TABLE dbo.PurchaseOrderSuggestion ADD SupplierReference NVARCHAR(50) NULL;

PRINT 'dbo.PurchaseOrderSuggestion SupplierReference column verified/added';


/* ── Verify ───────────────────────────────────────────────────────────── */

SELECT 'PurchaseOrderShipment' AS TableName, COUNT(*) AS Rows FROM dbo.PurchaseOrderShipment;
