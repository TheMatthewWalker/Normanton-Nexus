/* ============================================================
   Vendor Consignment Tracker — run against the kongsberg database.
   Compatibility: SQL Server 2005+ (no GO, no MERGE, no DATE type —
   matches every other migration in this project).

   Replaces the three manually-maintained "2026 Consignment Report -
   <Vendor>.xlsx" workbooks (Chemours, Fothergill/FCF, Raaj) with a
   SQL-backed tracker for vendor-owned stock physically on Kongsberg's
   site (SOBKZ=K goods receipt — same direction as the existing
   TurnsValClassSnapshot.ConsignmentQty MRP feature, NOT the same as
   dbo.ConsignmentCustomer, which is the opposite direction — see that
   table's own header comment).

   Raaj's workbook is the most complex of the three: the supplier needs
   to know exactly which delivery/invoice line each SAP settlement
   (transaction MRKO, document 1700******) actually drew down, since
   consumption must respect each delivery's expiry date, not just FIFO
   quantity. This schema runs the same process for all three vendors
   (Chemours/FCF just never trip the expiry gate), rather than building
   two separate code paths.

   HOW "UNDECLARED CONSUMPTION" IS CALCULATED — deliberately a BALANCE,
   not a raw SAP movement-type pull:
     Undeclared (per vendor+material) =
       SUM(ConsignmentDelivery.Quantity)                    -- everything ever GR'd
       − live SAP consignment stock (MKOL SLABS, the SAME
         BuildConsignmentStockRequest already proven for MRP)
       − SUM(ConsignmentDeclarationLine.QtyAllocated) for
         Confirmed declarations only                        -- already declared
   This mirrors exactly what the existing Chemours/FCF spreadsheets already
   do by hand (Consumption = Opening + Deliveries − Closing) and avoids
   guessing at which SAP movement type/table represents a "withdrawal from
   consignment" at this plant — GR (BWART 101/SOBKZ K) and live stock
   (MKOL) are the only two consignment data points already proven
   elsewhere in this codebase. A future phase can add a raw
   movement-level consumption pull once that table/BWART is confirmed
   against a real SAP GUI session — this balance approach doesn't block
   on that.

   MRKO ITSELF STAYS MANUAL (by design, this phase): Nexus proposes which
   delivery lines to declare (FEFO by default, since expiry is the
   binding constraint — configurable to FIFO or manual-only per vendor
   via dbo.ConsignmentVendorConfig), prints the declaration for the
   supplier, and once the user runs MRKO themselves in SAP GUI, the
   resulting settlement document number (1700******) is pasted back onto
   the declaration to close the loop. A BDC/BAPI replication of MRKO
   itself (like the LT04 transfer requirement replicator) is a possible
   future phase, not attempted here — MRKO creates a real financial
   settlement/payable document and shouldn't be blind-BDC'd without a
   supervised first real test.

   1. dbo.ConsignmentVendorConfig  — per-vendor expiry-tracking toggle +
                                      warning window + default allocation
                                      method. One row per dbo.Vendor that
                                      participates in this feature.
   2. dbo.ConsignmentDelivery      — one row per GR line (SAP-synced via
                                      MSEG BWART=101/SOBKZ=K/LIFNR=vendor,
                                      or manually added/CSV-imported as a
                                      fallback). RemainingQty is a running
                                      balance, decremented as declaration
                                      lines against it are confirmed.
   3. dbo.ConsignmentDeclaration   — one header per declaration run
                                      (draft → confirmed, with the pasted-
                                      back MRKO settlement doc number).
   4. dbo.ConsignmentDeclarationLine — the matrix cells: how much of a
                                      given delivery line this declaration
                                      allocates, mirroring the Summary tab
                                      of Raaj's existing workbook
                                      (invoice/batch × settlement doc).
   ============================================================ */


/* ── 1. ConsignmentVendorConfig ──────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.ConsignmentVendorConfig') AND type = 'U')
BEGIN
  CREATE TABLE dbo.ConsignmentVendorConfig (
    VendorId           INT           NOT NULL,

    -- Off for vendors who only care about FIFO quantity (Chemours/FCF today).
    -- On for Raaj, and any future vendor whose material carries a shelf life.
    TrackExpiry        BIT           NOT NULL DEFAULT 0,

    -- Flag delivery lines expiring within this many days on the dashboard —
    -- only meaningful when TrackExpiry = 1. NULL = no warning window set.
    ExpiryWarningDays   INT           NULL,

    -- FEFO (first-expire-first-out — default when TrackExpiry=1), FIFO
    -- (first-in-first-out by DocumentDate — default when TrackExpiry=0), or
    -- MANUAL (never auto-propose, user always hand-picks delivery lines).
    -- See ConsignmentDeclaration.AllocationMethod for the per-run record of
    -- what was actually used, which can differ from this default.
    DefaultAllocationMethod NVARCHAR(10) NOT NULL DEFAULT 'FEFO',

    Active              BIT           NOT NULL DEFAULT 1,
    Notes               NVARCHAR(500) NULL,

    UpdatedAtUtc        DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    UpdatedByUsername   NVARCHAR(80)  NULL,

    CONSTRAINT PK_ConsignmentVendorConfig PRIMARY KEY (VendorId),
    CONSTRAINT FK_ConsignmentVendorConfig_Vendor FOREIGN KEY (VendorId) REFERENCES dbo.Vendor (VendorId),
    CONSTRAINT CK_ConsignmentVendorConfig_Method CHECK (DefaultAllocationMethod IN ('FEFO', 'FIFO', 'MANUAL'))
  );

  PRINT 'Created dbo.ConsignmentVendorConfig';
END
ELSE
  PRINT 'dbo.ConsignmentVendorConfig already exists — skipped';


/* ── 2. ConsignmentDelivery ───────────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.ConsignmentDelivery') AND type = 'U')
BEGIN
  CREATE TABLE dbo.ConsignmentDelivery (
    DeliveryId          INT           NOT NULL IDENTITY(1,1),
    VendorId             INT           NOT NULL,
    Material              NVARCHAR(18)  NOT NULL,   -- MATNR

    MaterialDocument      NVARCHAR(10)  NOT NULL,   -- MSEG-MBLNR
    MaterialDocItem       NVARCHAR(4)   NOT NULL DEFAULT '0001',  -- MSEG-ZEILE

    Quantity              DECIMAL(15,3) NOT NULL,
    Uom                   NVARCHAR(3)   NULL,

    Container             NVARCHAR(20)  NULL,
    BillOfLading          NVARCHAR(30)  NULL,

    -- The vendor's own invoice/delivery reference (e.g. "RMIE 0041-1") —
    -- best-effort SAP-synced from MSEG-LFBNR (vendor delivery note number,
    -- the standard SAP field for exactly this purpose at goods receipt),
    -- always editable by hand since supplier paperwork sometimes disagrees
    -- with what was typed in at GR time.
    InvoiceNumber         NVARCHAR(30)  NULL,

    DocumentDate          DATETIME      NULL,
    PostingDate           DATETIME      NULL,

    -- Only populated/meaningful when the vendor's ConsignmentVendorConfig.
    -- TrackExpiry = 1. Manually entered against the supplier's shipment
    -- certificate — SAP has no reliably-populated expiry field for this
    -- material at GR time, so this is captured here rather than assumed
    -- computable from a shelf-life constant (Raaj's real expiry dates don't
    -- follow a clean fixed offset from DocumentDate).
    ExpiryDate            DATETIME      NULL,

    -- Running balance — starts equal to Quantity, decremented by
    -- ConsignmentDeclarationLine.QtyAllocated as declarations against this
    -- delivery line are confirmed. Denormalised (not just derived on read)
    -- so the FEFO/FIFO allocation proposal can cheaply scan "delivery lines
    -- with stock left" without summing every declaration line each time.
    RemainingQty          DECIMAL(15,3) NOT NULL,

    Source                NVARCHAR(10)  NOT NULL DEFAULT 'SAP',  -- SAP | MANUAL | CSV
    CreatedAtUtc           DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    CreatedByUsername      NVARCHAR(80)  NULL,

    CONSTRAINT PK_ConsignmentDelivery PRIMARY KEY (DeliveryId),
    CONSTRAINT FK_ConsignmentDelivery_Vendor FOREIGN KEY (VendorId) REFERENCES dbo.Vendor (VendorId),
    -- Prevents importing/syncing the same GR line twice (SAP sync re-runs
    -- daily and must be safely re-runnable).
    CONSTRAINT UQ_ConsignmentDelivery UNIQUE (MaterialDocument, MaterialDocItem),
    CONSTRAINT CK_ConsignmentDelivery_Source CHECK (Source IN ('SAP', 'MANUAL', 'CSV'))
  );

  CREATE INDEX IX_ConsignmentDelivery_VendorMaterial
    ON dbo.ConsignmentDelivery (VendorId, Material)
    INCLUDE (RemainingQty, ExpiryDate, DocumentDate, InvoiceNumber);

  PRINT 'Created dbo.ConsignmentDelivery';
END
ELSE
  PRINT 'dbo.ConsignmentDelivery already exists — skipped';


/* ── 3. ConsignmentDeclaration ────────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.ConsignmentDeclaration') AND type = 'U')
BEGIN
  CREATE TABLE dbo.ConsignmentDeclaration (
    DeclarationId          INT           NOT NULL IDENTITY(1,1),
    VendorId                INT           NOT NULL,

    Status                  NVARCHAR(20)  NOT NULL DEFAULT 'Draft',  -- Draft | Confirmed | Cancelled
    AllocationMethod         NVARCHAR(10)  NOT NULL DEFAULT 'FEFO',   -- FEFO | FIFO | MANUAL — what was actually used to build this run
    TotalQty                 DECIMAL(15,3) NOT NULL DEFAULT 0,

    CreatedAtUtc             DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    CreatedByUsername        NVARCHAR(80)  NULL,

    -- Set only once the declaration is Confirmed — see middleware/auth.js
    -- requirePermission('VENDOR_CONSIGNMENT') gating the confirm route.
    ConfirmedAtUtc           DATETIME      NULL,
    ConfirmedByUsername      NVARCHAR(80)  NULL,

    -- Pasted back by the user after they run MRKO themselves in SAP GUI —
    -- see the header comment above for why this stays manual this phase.
    SettlementDocumentNumber NVARCHAR(10)  NULL,   -- SAP settlement doc, pattern 1700******

    -- Optional: the total qty MRKO actually settled, if the user wants to
    -- paste it in from SAP's own confirmation screen — compared against
    -- TotalQty above so a mismatch banner can be shown rather than silently
    -- trusting the proposal matched what SAP actually did.
    SettlementReconciledQty  DECIMAL(15,3) NULL,

    Notes                    NVARCHAR(500) NULL,

    CONSTRAINT PK_ConsignmentDeclaration PRIMARY KEY (DeclarationId),
    CONSTRAINT FK_ConsignmentDeclaration_Vendor FOREIGN KEY (VendorId) REFERENCES dbo.Vendor (VendorId),
    CONSTRAINT CK_ConsignmentDeclaration_Status CHECK (Status IN ('Draft', 'Confirmed', 'Cancelled')),
    CONSTRAINT CK_ConsignmentDeclaration_Method CHECK (AllocationMethod IN ('FEFO', 'FIFO', 'MANUAL'))
  );

  CREATE INDEX IX_ConsignmentDeclaration_Vendor ON dbo.ConsignmentDeclaration (VendorId, Status);

  PRINT 'Created dbo.ConsignmentDeclaration';
END
ELSE
  PRINT 'dbo.ConsignmentDeclaration already exists — skipped';


/* ── 4. ConsignmentDeclarationLine ────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.ConsignmentDeclarationLine') AND type = 'U')
BEGIN
  CREATE TABLE dbo.ConsignmentDeclarationLine (
    DeclarationLineId  INT           NOT NULL IDENTITY(1,1),
    DeclarationId        INT           NOT NULL,
    DeliveryId            INT           NOT NULL,

    Material               NVARCHAR(18)  NOT NULL,  -- denormalised for reporting/print convenience
    QtyAllocated            DECIMAL(15,3) NOT NULL,

    CreatedAtUtc            DATETIME      NOT NULL DEFAULT GETUTCDATE(),

    CONSTRAINT PK_ConsignmentDeclarationLine PRIMARY KEY (DeclarationLineId),
    CONSTRAINT FK_ConsignmentDeclarationLine_Declaration FOREIGN KEY (DeclarationId) REFERENCES dbo.ConsignmentDeclaration (DeclarationId),
    CONSTRAINT FK_ConsignmentDeclarationLine_Delivery FOREIGN KEY (DeliveryId) REFERENCES dbo.ConsignmentDelivery (DeliveryId)
  );

  CREATE INDEX IX_ConsignmentDeclarationLine_Declaration ON dbo.ConsignmentDeclarationLine (DeclarationId);
  CREATE INDEX IX_ConsignmentDeclarationLine_Delivery ON dbo.ConsignmentDeclarationLine (DeliveryId);

  PRINT 'Created dbo.ConsignmentDeclarationLine';
END
ELSE
  PRINT 'dbo.ConsignmentDeclarationLine already exists — skipped';


/* ── 5. Seed config rows for the three known vendors ─────────────────────────
   Chemours/Fothergill (FCF)/Raaj already exist in dbo.Vendor (seeded from
   MRP2.xlsx — see scripts/seed-vendor-materials.js). This just switches on
   TrackExpiry for Raaj (the only one whose workbook tracked expiry) and adds
   a default config row for the other two so the tile has something to show
   immediately. Raaj's SAP vendor number (LIFNR 200604, confirmed by the
   user) is pre-filled here rather than left for the user to look up.
   Chemours/Fothergill's SAP vendor numbers aren't in their workbooks (no
   GR/Settlements tabs), so those stay NULL — fill in via the existing
   Vendor Master Data page (Logistics > Material Planning), same as any
   other vendor's SapVendorNumber. GR/stock SAP sync for a vendor is
   blocked with a clear error until SapVendorNumber is set, same pattern
   as PO creation.

   NOTE: an earlier version of this migration pre-filled Raaj's number as
   0000078200 (mis-derived from the GR sheet's 'Supplier' column, which
   turned out not to be the LIFNR). The UPDATE below also corrects that
   value if it was already applied, so re-running this script safely
   fixes an already-migrated database as well as seeding a fresh one. */

IF EXISTS (SELECT 1 FROM dbo.Vendor WHERE VendorName = N'Raaj')
BEGIN
  UPDATE dbo.Vendor SET SapVendorNumber = N'0000200604'
    WHERE VendorName = N'Raaj' AND (SapVendorNumber IS NULL OR SapVendorNumber = N'0000078200');

  IF NOT EXISTS (SELECT 1 FROM dbo.ConsignmentVendorConfig cvc
                 JOIN dbo.Vendor v ON v.VendorId = cvc.VendorId WHERE v.VendorName = N'Raaj')
    INSERT INTO dbo.ConsignmentVendorConfig (VendorId, TrackExpiry, ExpiryWarningDays, DefaultAllocationMethod)
    SELECT VendorId, 1, 30, N'FEFO' FROM dbo.Vendor WHERE VendorName = N'Raaj';
END

IF EXISTS (SELECT 1 FROM dbo.Vendor WHERE VendorName = N'Chemours')
   AND NOT EXISTS (SELECT 1 FROM dbo.ConsignmentVendorConfig cvc
                   JOIN dbo.Vendor v ON v.VendorId = cvc.VendorId WHERE v.VendorName = N'Chemours')
  INSERT INTO dbo.ConsignmentVendorConfig (VendorId, TrackExpiry, DefaultAllocationMethod)
  SELECT VendorId, 0, N'FIFO' FROM dbo.Vendor WHERE VendorName = N'Chemours';

IF EXISTS (SELECT 1 FROM dbo.Vendor WHERE VendorName = N'Fothergill')
   AND NOT EXISTS (SELECT 1 FROM dbo.ConsignmentVendorConfig cvc
                   JOIN dbo.Vendor v ON v.VendorId = cvc.VendorId WHERE v.VendorName = N'Fothergill')
  INSERT INTO dbo.ConsignmentVendorConfig (VendorId, TrackExpiry, DefaultAllocationMethod)
  SELECT VendorId, 0, N'FIFO' FROM dbo.Vendor WHERE VendorName = N'Fothergill';

PRINT 'Consignment vendor config rows verified/seeded';


/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT 'ConsignmentVendorConfig'   AS TableName, COUNT(*) AS Rows FROM dbo.ConsignmentVendorConfig
UNION ALL
SELECT 'ConsignmentDelivery',                    COUNT(*)         FROM dbo.ConsignmentDelivery
UNION ALL
SELECT 'ConsignmentDeclaration',                 COUNT(*)         FROM dbo.ConsignmentDeclaration
UNION ALL
SELECT 'ConsignmentDeclarationLine',             COUNT(*)         FROM dbo.ConsignmentDeclarationLine;
