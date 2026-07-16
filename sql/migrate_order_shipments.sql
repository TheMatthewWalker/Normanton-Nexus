/* ============================================================
   MRP Phase 2c — inbound shipment tracking + supplier references. Run
   against the kongsberg database. Compatibility : SQL Server 2005+
   (matches migrate_order_suggestions.sql / migrate_vendor_master_data.sql —
   no GO, no CONCAT(), no DATETIME2).

   Two independent ways to reconcile a PurchaseOrderSuggestion order against
   what actually happens in the real world, added at the user's request:

   1. dbo.PurchaseOrderShipment — a lightweight inbound shipment/load
      record: Haulier, ModeOfTransport, TrackingNumber, ShipmentReference,
      Notes. Deliberately separate from Logistics.dbo.ShipmentMain, which
      models OUTBOUND deliveries to customers (KN booking API integration,
      pallets, customs declarations, PDF documents) — inbound purchase
      orders need none of that, just who's hauling it and a tracking
      number. Several PurchaseOrderSuggestion rows can point at the same
      shipment (several materials/orders consolidated onto one load), via
      the new PurchaseOrderSuggestion.ShipmentId FK — nullable, since most
      orders won't have a shipment yet at accept time; it's filled in once
      the order is actually collected/dispatched.

   2. PurchaseOrderSuggestion.SupplierReference — for vendors who deliver
      themselves rather than going through a haulier (no shipment record
      needed): just the supplier's own order/confirmation number, stamped
      directly on the order line so it can be matched against their
      confirmation. Lives on the order itself, not the shipment, since each
      order line usually carries its own confirmation number even when
      several ship together.
   ============================================================ */


/* ── 1. PurchaseOrderShipment ─────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.PurchaseOrderShipment') AND type = 'U')
BEGIN
  CREATE TABLE dbo.PurchaseOrderShipment (
    ShipmentId        INT           NOT NULL IDENTITY(1,1),
    ShipmentReference NVARCHAR(50)  NULL,   -- free text — forwarder's booking ref, or just a label
    Haulier           NVARCHAR(100) NULL,
    ModeOfTransport   NVARCHAR(20)  NULL,   -- Road / Sea / Air / Rail / Courier / Other
    TrackingNumber    NVARCHAR(100) NULL,
    Notes             NVARCHAR(500) NULL,

    CreatedAtUtc      DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    UpdatedAtUtc      DATETIME      NOT NULL DEFAULT GETUTCDATE(),

    CONSTRAINT PK_PurchaseOrderShipment PRIMARY KEY (ShipmentId)
  );

  PRINT 'Created dbo.PurchaseOrderShipment';
END
ELSE
  PRINT 'dbo.PurchaseOrderShipment already exists — skipped';


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
