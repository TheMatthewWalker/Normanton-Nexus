/* ============================================================
   Manual Outbound Shipment — for goods sent that are NOT managed through
   SAP and never go through the picksheet/pallet-builder process (e.g. an
   ad-hoc send of non-stock items). Run against the kongsberg database.
   Compatibility: SQL Server 2005+ (matches migrate_order_suggestions.sql /
   migrate_vendor_master_data.sql — no GO, no CONCAT(), no DATETIME2).

   WHY A NEW TABLE, NOT Logistics.dbo.PalletMain:
   PalletMain itself carries no SAP-specific columns (material/batch/sloc
   all live one level down, on PalletPackages) — but the tables around it
   are a different story. Logistics.dbo.DeliveryMain's deliveryID IS the
   real SAP delivery document number (VBELN) — it's created FROM a SAP
   delivery during sap-sync, and completing a delivery pushes ZDEL /
   ZDELFLAG-ZDELPACK BAPI calls into SAP keyed on that exact ID
   (routes/deliverymain.js's /:deliveryId/complete and
   runZdelflagMaintenance). Attaching manual/non-SAP cargo anywhere in the
   DeliveryLink -> PalletMain chain would mean either fabricating a
   plausible-looking SAP delivery number (collision risk) or threading an
   IsManual guard through every one of those SAP-push code paths — a wide
   blast radius for something that's supposed to be a small, isolated
   escape hatch. It would also inflate the "pallets finished" warehouse KPI
   on the landing page sparkline, which counts PalletMain rows with
   palletFinish=1 regardless of how they got there.

   Instead, manual cargo attaches directly to Logistics.dbo.ShipmentMain
   (new IsManual flag) via this new table, skipping DeliveryMain /
   DeliveryLink / PalletMain / PalletPackages entirely — the same
   "flag on the header, separate child data" pattern already used for
   Manual Inbound Shipment (dbo.PurchaseOrderShipment.IsManual, see
   migrate_inbound_costs_forwarders.sql).

   No FK constraints are declared here (ShipmentID -> ShipmentMain,
   DeliveryID -> DeliveryMain, etc. are likewise app-managed, not
   FK-enforced, throughout Logistics.dbo — see ShipmentLink/DeliveryLink),
   matching that existing convention.
   ============================================================ */


/* ── 1. Logistics.dbo.ShipmentMain — add IsManual flag ──────────────────
   0 (default) = normal shipment, built from picksheet-completed
   deliveries via Create Shipment. 1 = manual shipment — no linked
   deliveries at all; its cargo lives in ManualCargoItem below instead. */
IF COL_LENGTH('Logistics.dbo.ShipmentMain', 'IsManual') IS NULL
  ALTER TABLE Logistics.dbo.ShipmentMain ADD IsManual BIT NOT NULL DEFAULT 0;

PRINT 'Logistics.dbo.ShipmentMain.IsManual column verified/added';


/* ── 2. Logistics.dbo.ManualCargoItem ────────────────────────────────────
   One row per physical item/package on a manual shipment — the simplified
   equivalent of a PalletMain row, but with only the generic physical
   attributes an operator can type in by hand (no SAP material/batch/sloc,
   no packaging-instruction, no picksheet linkage). */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'Logistics.dbo.ManualCargoItem') AND type = 'U')
BEGIN
  CREATE TABLE Logistics.dbo.ManualCargoItem (
    CargoID         INT           NOT NULL IDENTITY(1,1),
    ShipmentID      BIGINT        NOT NULL,   -- Logistics.dbo.ShipmentMain.shipmentID, app-managed (see header note)

    Description     NVARCHAR(200) NULL,       -- free text, e.g. "Steel brackets", operator-entered
    PackageCount    INT           NOT NULL DEFAULT 1,
    Weight          DECIMAL(18,3) NOT NULL DEFAULT 0,   -- kg, gross weight for the row (all packages combined)
    Length          DECIMAL(18,2) NULL,       -- cm, matches PalletMain's palletLength/Width/Height convention
    Width           DECIMAL(18,2) NULL,
    Height          DECIMAL(18,2) NULL,
    Volume          DECIMAL(18,3) NULL,       -- m3, computed client-side from L/W/H and stored (not a computed column, for SQL2005 compatibility)

    Removed         BIT           NOT NULL DEFAULT 0,   -- soft delete, matches PalletMain.palletRemoved
    CreatedAtUtc    DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    CreatedBy       NVARCHAR(100) NULL,

    CONSTRAINT PK_ManualCargoItem PRIMARY KEY (CargoID)
  );

  CREATE INDEX IX_ManualCargoItem_Shipment ON Logistics.dbo.ManualCargoItem (ShipmentID);

  PRINT 'Created Logistics.dbo.ManualCargoItem';
END
ELSE
  PRINT 'Logistics.dbo.ManualCargoItem already exists — skipped';


/* ── Verify ───────────────────────────────────────────────────────────── */

SELECT 'ManualCargoItem' AS TableName, COUNT(*) AS Rows FROM Logistics.dbo.ManualCargoItem;
