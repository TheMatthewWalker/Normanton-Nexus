/* ============================================================
   Vendor master data for MRP Phase 2 — run against the kongsberg database.
   Compatibility : SQL Server 2005+ (matches create_performance_turnsvalclass_database.sql
   — no GO, no CONCAT(), no DATETIME2).

   Adds the vendor/supplier data the MRP order-suggestion engine (a later phase)
   will need: which materials a vendor supplies, their lead time, Incoterms (so
   the right date — ex-works ready date vs. delivered date — gets communicated),
   and minimum order quantities, including combined/order-level MOQs that span
   multiple materials (e.g. a vendor requiring 20,000kg total per order, made up
   of any combination of materials that each also carry their own smaller MOQ).

   Deliberately separate from TurnsValClassSnapshot: this is manually-maintained
   business data (nobody at SAP knows your vendor contracts), not anything pulled
   from SAP. See the MRP Phase 1 conversation for why — vendor data was chosen to
   live in a new admin page rather than be sourced from SAP purchasing info
   records.

   1. dbo.Vendor          — one row per vendor. Incoterms + order-level MOQ live
                             here since both apply across everything a vendor
                             supplies, not per material.
   2. dbo.VendorMaterial   — one row per vendor+material assignment. Per-material
                             MOQ, an optional lead-time override (falls back to
                             SAP's own MARC-PLIFZ on TurnsValClassSnapshot when
                             left blank), and the SAP schedule agreement number
                             where one exists.
   ============================================================ */


/* ── 1. Vendor ────────────────────────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.Vendor') AND type = 'U')
BEGIN
  CREATE TABLE dbo.Vendor (
    VendorId            INT           NOT NULL IDENTITY(1,1),
    VendorName          NVARCHAR(80)  NOT NULL,

    -- Standard 3-letter Incoterm (EXW, FCA, FOB, CPT, CIP, DAP, DDP, ...). Origin
    -- terms (EXW/FCA/FOB/CPT/CIP) mean the date given to the supplier should be
    -- the ready-to-ship/ex-works date; destination terms (DAP/DDP/...) mean it
    -- should be the wanted delivery date. The order-suggestion engine (a later
    -- phase) decides which date to quote the vendor from this field — nothing
    -- else in the schema encodes that split, it's derived from the Incoterm code.
    Incoterms           NVARCHAR(3)   NULL,

    -- Combined MOQ across ANY combination of this vendor's materials in a single
    -- order (e.g. Raaj Ratna: 20,000kg total, made up of any mix of materials,
    -- each of which ALSO carries its own smaller per-material MOQ on
    -- VendorMaterial.MaterialMoqQty below). NULL = no order-level minimum, only
    -- each material's own MOQ (if any) applies.
    OrderMoqQty          DECIMAL(15,3) NULL,
    OrderMoqUom          NVARCHAR(3)   NULL,

    -- Fallback lead time (days) used only when a VendorMaterial row has no
    -- LeadTimeDaysOverride of its own AND the material's own SAP MARC-PLIFZ
    -- (TurnsValClassSnapshot.PlannedDeliveryTime) is blank. Rarely needed in
    -- practice but keeps the order-suggestion engine from having a hole to fall
    -- through if both of those are ever missing for a given material.
    DefaultLeadTimeDays  DECIMAL(9,2)  NULL,

    Notes                NVARCHAR(500) NULL,
    CreatedAtUtc         DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    UpdatedAtUtc         DATETIME      NOT NULL DEFAULT GETUTCDATE(),

    CONSTRAINT PK_Vendor PRIMARY KEY (VendorId),
    CONSTRAINT UQ_Vendor_Name UNIQUE (VendorName)
  );

  PRINT 'Created dbo.Vendor';
END
ELSE
  PRINT 'dbo.Vendor already exists — skipped';


/* ── 2. VendorMaterial ────────────────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.VendorMaterial') AND type = 'U')
BEGIN
  CREATE TABLE dbo.VendorMaterial (
    VendorMaterialId     INT           NOT NULL IDENTITY(1,1),
    VendorId             INT           NOT NULL,
    Material             NVARCHAR(18)  NOT NULL,   -- MATNR, matches TurnsValClassSnapshot.Material

    -- Per-material MOQ (e.g. Raaj Ratna: each material also has its own 1000kg
    -- floor, on top of the 20,000kg combined order MOQ on dbo.Vendor above).
    -- NULL = no per-material minimum, only the vendor's order-level MOQ (if any)
    -- applies.
    MaterialMoqQty        DECIMAL(15,3) NULL,

    -- NULL = fall back to TurnsValClassSnapshot.PlannedDeliveryTime (SAP
    -- MARC-PLIFZ) for this material, then to Vendor.DefaultLeadTimeDays if that's
    -- also blank. Only set this when the real vendor lead time genuinely differs
    -- from what SAP's material master says.
    LeadTimeDaysOverride  DECIMAL(9,2)  NULL,

    -- SAP scheduling agreement number, where this vendor+material is bought
    -- against one. Informational only for now (no live SAP data flows through
    -- this yet — see Notes in the SQL header).
    ScheduleAgreement     NVARCHAR(10)  NULL,

    -- Traceability only: the raw material code this row was seeded from when
    -- imported from the existing MRP2.xlsx vendor tabs, for cases where it
    -- couldn't be matched to a TurnsValClassSnapshot.Material with full
    -- confidence and needs a manual check. NULL for anything added by hand
    -- through the admin page.
    SourceHint            NVARCHAR(40)  NULL,

    CreatedAtUtc          DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    UpdatedAtUtc          DATETIME      NOT NULL DEFAULT GETUTCDATE(),

    CONSTRAINT PK_VendorMaterial PRIMARY KEY (VendorMaterialId),
    CONSTRAINT FK_VendorMaterial_Vendor FOREIGN KEY (VendorId) REFERENCES dbo.Vendor (VendorId),
    -- One assignment per vendor+material — a material CAN appear under more than
    -- one vendor (multi-sourced), just not twice under the SAME vendor.
    CONSTRAINT UQ_VendorMaterial UNIQUE (VendorId, Material)
  );

  CREATE INDEX IX_VendorMaterial_Material ON dbo.VendorMaterial (Material) INCLUDE (VendorId, MaterialMoqQty, LeadTimeDaysOverride);

  PRINT 'Created dbo.VendorMaterial';
END
ELSE
  PRINT 'dbo.VendorMaterial already exists — skipped';


/* ── Verify ──────────────────────────────────────────────────────────────── */
SELECT 'Vendor'         AS TableName, COUNT(*) AS Rows FROM dbo.Vendor
UNION ALL
SELECT 'VendorMaterial',              COUNT(*)         FROM dbo.VendorMaterial;
