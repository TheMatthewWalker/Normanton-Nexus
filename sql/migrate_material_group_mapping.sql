/* ============================================================
   SAP Material Group lookup for freight-cost PO creation — run against
   the kongsberg database.
   Compatibility : SQL Server 2005+ (matches create_performance_turnsvalclass_database.sql
   — no GO, no CONCAT(), no DATETIME2).

   Why this exists: SapServer's POST /api/purchasing/create-po-and-receipt
   (task #415, called from routes/shipmentcost.js's post-migo) requires a
   real SAP Material Group code (WGRU/MATKL, e.g. "ITLG01A") on every PO
   item. post-migo used to build this as free text — `${modeOfTransport}
   Freight`, e.g. "Road Freight" — which isn't a valid SAP code and is
   exactly why PO creation kept rolling back (confirmed working with the
   real code via a manual SapServer test call). SAP material groups are
   tied to account determination (GL account) as well as, in this
   business's case, the mode of transport, so a single fixed code isn't
   enough either — hence a proper lookup table instead of a hardcoded
   constant.

   Keyed on (CostElement, ModeOfTransport) — CostElement is the GL account
   from ShipmentCost.costElement / the cost line, ModeOfTransport is one of
   OS_TRANSPORT_MODES (private/js/logistics.js: Road/Sea/Air/Rail/Courier/
   Other). ModeOfTransport is nullable so a row can also be entered as a
   default for a GL account regardless of transport mode — the lookup
   (routes/materialgroups.js's lookupMaterialGroup) tries the exact
   (CostElement, ModeOfTransport) match first, then falls back to
   (CostElement, NULL), and only errors out if neither exists, naming the
   missing combination so whoever's maintaining this table knows exactly
   what to add.

   Maintained via a new Logistics admin tile (Material Group Mapping,
   alongside Update Forwarders) rather than SQL directly, once seeded.
   ============================================================ */


IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.MaterialGroupMapping') AND type = 'U')
BEGIN
  CREATE TABLE dbo.MaterialGroupMapping (
    MappingId       INT           NOT NULL IDENTITY(1,1),

    -- GL account (matches ShipmentCost.costElement / PO item GlAccount).
    CostElement     NVARCHAR(10)  NOT NULL,

    -- One of OS_TRANSPORT_MODES (Road/Sea/Air/Rail/Courier/Other), or NULL
    -- to act as the default/fallback for this CostElement regardless of
    -- mode — see header note above.
    ModeOfTransport NVARCHAR(20)  NULL,

    -- Plain NVARCHAR(CostElement, ModeOfTransport) can't be made UNIQUE the
    -- way we need with a single ordinary constraint — SQL Server treats
    -- every NULL as distinct in a unique index/constraint, so it would
    -- happily accept more than one NULL-mode "default" row per CostElement,
    -- which is exactly the ambiguity the lookup needs to rule out. Filtered
    -- indexes (CREATE INDEX ... WHERE) would solve this cleanly but are a
    -- SQL Server 2008+ feature — this project targets 2005+ throughout (see
    -- header). A PERSISTED computed column collapsing NULL to '' sidesteps
    -- that: computed columns with PERSISTED have been supported since SQL
    -- Server 2005, so a plain UNIQUE constraint on (CostElement, ModeKey)
    -- gives a true single-row-per-combination guarantee, including at most
    -- one default (NULL-mode) row per CostElement.
    ModeKey AS (ISNULL(ModeOfTransport, N'')) PERSISTED,

    -- SAP Material Group code (WGRU/MATKL) — up to 9 chars in standard SAP,
    -- matches PurchasingModels.cs's MaterialGroup field in SapServer.
    MaterialGroup   NVARCHAR(9)   NOT NULL,

    Description     NVARCHAR(200) NULL,
    CreatedBy       NVARCHAR(100) NULL,
    CreatedAtUtc    DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    UpdatedAtUtc    DATETIME      NOT NULL DEFAULT GETUTCDATE(),

    CONSTRAINT PK_MaterialGroupMapping PRIMARY KEY (MappingId),
    CONSTRAINT UQ_MGM_CostElement_ModeKey UNIQUE (CostElement, ModeKey)
  );

  PRINT 'Created dbo.MaterialGroupMapping';
END
ELSE
  PRINT 'dbo.MaterialGroupMapping already exists — skipped';


/* ── Seed the one code already confirmed working (task #415 manual test:
   Vendor 0000078712, GL account 0000602200, ITLG01A, succeeded) ──────────
   CostElement here must match whatever routes/shipmentcost.js's post-migo
   actually sends as line.costElement at runtime — that's ShipmentCost.
   costElement, which routes/shipmentmain.js populates from CostElements.
   elementCode (the app's 6-char short code, e.g. '602200'), NOT the
   10-digit zero-padded format SAP's own GlAccount field displays as
   ('0000602200' — see the manual test that confirmed this code works).
   The first version of this migration seeded the wrong (10-digit) format,
   which would never actually match a real line.costElement value and so
   would have silently never been used by the lookup — corrected below. */
IF EXISTS (SELECT 1 FROM dbo.MaterialGroupMapping WHERE CostElement = '0000602200' AND ModeOfTransport IS NULL)
BEGIN
  UPDATE dbo.MaterialGroupMapping SET CostElement = '602200', UpdatedAtUtc = GETUTCDATE()
  WHERE CostElement = '0000602200' AND ModeOfTransport IS NULL;

  PRINT 'Corrected MaterialGroupMapping seed row: CostElement 0000602200 -> 602200';
END

IF NOT EXISTS (SELECT 1 FROM dbo.MaterialGroupMapping WHERE CostElement = '602200' AND ModeOfTransport IS NULL)
BEGIN
  INSERT INTO dbo.MaterialGroupMapping (CostElement, ModeOfTransport, MaterialGroup, Description, CreatedBy)
  VALUES ('602200', NULL, 'ITLG01A', 'Inbound Standard Freight — confirmed working via manual SapServer test', 'migration seed');

  PRINT 'Seeded default MaterialGroupMapping for CostElement 602200';
END


/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT COUNT(*) AS MaterialGroupMappingRows FROM dbo.MaterialGroupMapping;
