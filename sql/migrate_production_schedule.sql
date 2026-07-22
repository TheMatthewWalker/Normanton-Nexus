/* ============================================================
   Production Schedule + Arrears + OTIF tracking — run against the
   kongsberg database.
   Compatibility: SQL Server 2005+ (no GO, no MERGE, no DATE type —
   matches every other migration in this project).

   Three pieces:

   1. dbo.ProductionScheduleComments — planner comment + ETA per
      order line (Sales and Production Supervisors can both write
      here). Keyed on (ReferenceDocument, Item) — Item is the SAP
      line item number, the correct grain for this report (Material
      can repeat within an agreement across multiple items, but
      Item is unique per line). Replaces the older idea of pushing
      an SAP ADD_TEXT call per comment: this app has no existing
      ADD_TEXT integration (see routes/performancesap.js — nothing
      calls SAP to write order text anywhere), and SQL-only keeps
      the report fast and makes future KPI reporting possible
      without an SAP round trip per row. Mirrors the existing
      dbo.OrderBookLineNotes pattern (sql/migrate_orderbook_line_notes.sql).

   2. dbo.OrderFulfillmentTracking — the OTIF (on-time-in-full) fact
      table. One row per order line ever seen open in
      dbo.AgreementSnapshot. A background diff job (see
      routes/performancesql.js: diffProductionScheduleOtif(), run
      daily from server.js) compares today's AgreementSnapshot
      against yesterday's tracked OPEN lines: a line still present
      gets its LastSeenUtc/DueDate refreshed; a line that's vanished
      is presumed completed (SAP no longer shows it as open) and is
      marked COMPLETED as of today, with OnTime computed against its
      last known due date, and Reason backfilled from
      dbo.ProductionScheduleComments if it was late.

   3. SALES_SUPERVISOR permission — mirrors PROD_SUPERVISOR so Sales
      users can also confirm/edit Production Schedule rows without
      needing full admin rights. See sql/migrate_permissions.sql for
      the permissions system this extends.
   ============================================================ */


/* ── 1. Production Schedule comments + ETA ──────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.ProductionScheduleComments') AND type = 'U')
BEGIN
  CREATE TABLE dbo.ProductionScheduleComments (
    ReferenceDocument NVARCHAR(10)  NOT NULL,  -- matches AgreementSnapshot.ReferenceDocument
    Item              NVARCHAR(6)   NOT NULL,  -- matches AgreementSnapshot.Item

    Comment           NVARCHAR(500) NULL,
    Eta               DATETIME      NULL,       -- planner-entered date, only meaningful when the line won't be met on RequestDate

    LastUpdatedUtc    DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    UpdatedByUsername NVARCHAR(80)  NULL,

    CONSTRAINT PK_ProductionScheduleComments PRIMARY KEY (ReferenceDocument, Item)
  );

  PRINT 'Created dbo.ProductionScheduleComments';
END
ELSE
  PRINT 'dbo.ProductionScheduleComments already exists — skipped';


/* ── 2. OTIF tracking (disappearance-based) ──────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.OrderFulfillmentTracking') AND type = 'U')
BEGIN
  CREATE TABLE dbo.OrderFulfillmentTracking (
    TrackingID        INT           NOT NULL IDENTITY(1,1),

    ReferenceDocument NVARCHAR(10)  NOT NULL,
    Item              NVARCHAR(6)   NOT NULL,
    Customer          NVARCHAR(10)  NULL,
    CustomerName      NVARCHAR(35)  NULL,
    Material          NVARCHAR(18)  NULL,
    MaterialText      NVARCHAR(40)  NULL,
    ValueStream       VARCHAR(8)    NULL,
    OrderQty          DECIMAL(15,3) NULL,
    Uom               VARCHAR(3)    NULL,

    -- Latest RequestDate observed while this line was open — refreshed every
    -- diff run so a rescheduled order is judged against its current due date,
    -- not whatever it happened to be the first time we saw it.
    DueDate           DATETIME      NULL,

    FirstSeenUtc      DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    LastSeenUtc       DATETIME      NOT NULL DEFAULT GETUTCDATE(),

    -- OPEN while still present in AgreementSnapshot; COMPLETED once a diff
    -- run finds it's disappeared. No DB constraint enforcing "one OPEN row
    -- per (ReferenceDocument,Item)" — SQL Server 2005 has no filtered unique
    -- index (added in 2008) — enforced in application code instead (see
    -- diffProductionScheduleOtif in performancesql.js).
    Status            VARCHAR(10)   NOT NULL DEFAULT 'OPEN',

    CompletedDate     DATETIME      NULL,
    OnTime            BIT           NULL,        -- CompletedDate <= DueDate, computed once on completion
    Reason            NVARCHAR(500) NULL,         -- ProductionScheduleComments.Comment at the moment it went late, NULL if on time

    CONSTRAINT PK_OrderFulfillmentTracking PRIMARY KEY (TrackingID)
  );

  CREATE INDEX IX_OFT_RefItemStatus ON dbo.OrderFulfillmentTracking (ReferenceDocument, Item, Status);
  CREATE INDEX IX_OFT_CompletedDate ON dbo.OrderFulfillmentTracking (CompletedDate);

  PRINT 'Created dbo.OrderFulfillmentTracking';
END
ELSE
  PRINT 'dbo.OrderFulfillmentTracking already exists — skipped';


/* ── 3. SALES_SUPERVISOR permission ──────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = N'SALES_SUPERVISOR')
  INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category) VALUES
    (N'SALES_SUPERVISOR', N'Sales Supervisor',
     N'Confirm/edit Production Schedule and Arrears rows — comments and ETA overrides', N'Sales');

PRINT 'SALES_SUPERVISOR permission verified/added';


/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT COUNT(*) AS ProductionScheduleCommentsRows FROM dbo.ProductionScheduleComments;
SELECT COUNT(*) AS OrderFulfillmentTrackingRows    FROM dbo.OrderFulfillmentTracking;
SELECT PermissionCode FROM dbo.PortalPermissions WHERE PermissionCode = N'SALES_SUPERVISOR';
