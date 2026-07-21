/* ============================================================
   Order book line notes — run against the kongsberg database.
   Compatibility : SQL Server 2005+ (no GO, no MERGE, no DATE type —
   matches every other migration in this project).

   Persists the manual columns planners fill in on the "Breakdown for
   Month End" Excel export (Risk/Reason, Won't Get, Last Day/Last Day
   Time, and Bring Forward from the Next Month tab) so that when the
   file is uploaded back (routes/performance.js's upload-notes route),
   the next person who downloads the sheet sees what's already been
   flagged instead of starting from a blank sheet and duplicating work.

   Keyed on (ReferenceDocument, Material) — the same grain as a Data-
   sheet row (see getOrderBookBreakdown in performancesql.js), which is
   unique per order/material combination. One row here = one line's
   worth of manually-maintained commentary, overwritten wholesale each
   time that line is re-uploaded (last upload wins — see
   upsertOrderBookLineNotes).
   ============================================================ */


IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.OrderBookLineNotes') AND type = 'U')
BEGIN
  CREATE TABLE dbo.OrderBookLineNotes (
    ReferenceDocument NVARCHAR(10)  NOT NULL,  -- matches AgreementSnapshot.ReferenceDocument
    Material          NVARCHAR(18)  NOT NULL,  -- matches AgreementSnapshot.Material

    Risk              VARCHAR(1)    NULL,      -- 'x' = may or may not get this stock
    Reason            NVARCHAR(500) NULL,

    -- Separate from Risk — a confirmed miss, not a maybe. Excluded from the
    -- Dashboard's Invoiced + Potential Stock / Invoiced + Planned totals the
    -- same way a Risk flag is, but tracked and reported on its own card so
    -- "might not get it" and "definitely won't get it" aren't conflated.
    WontGet           VARCHAR(1)    NULL,      -- 'x' = confirmed NOT getting this stock

    LastDay           VARCHAR(1)    NULL,      -- 'x' = due on the last day of the month
    LastDayTime       VARCHAR(20)   NULL,      -- free text — "TBC", "AM", "15:00", etc.

    -- Next Month tab — flags an order to pull forward to help meet this
    -- month's target. Purely a planning flag round-tripped through the same
    -- upload; nothing in this app acts on it automatically.
    BringForward      VARCHAR(1)    NULL,      -- 'x' = flagged to bring forward

    -- Optional override of Planned Production Qty (Data tab), which
    -- otherwise just defaults to Order Qty every export. NULL means "no
    -- override recorded" — the export and the printable Production Plan
    -- both fall back to live Order Qty in that case. See
    -- getProductionPlan() in performancesql.js.
    PlannedProductionQty DECIMAL(15,3) NULL,

    LastUpdatedUtc    DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    UpdatedByUsername NVARCHAR(80)  NULL,

    CONSTRAINT PK_OrderBookLineNotes PRIMARY KEY (ReferenceDocument, Material)
  );

  PRINT 'Created dbo.OrderBookLineNotes';
END
ELSE
  PRINT 'dbo.OrderBookLineNotes already exists — skipped';


/* ── Add PlannedProductionQty to an existing install ─────────────────────────
   Guarded ALTER, same COL_LENGTH() pattern used elsewhere in this codebase
   (see migrate_vendor_master_data.sql) — safe to re-run every time this
   script executes, whether the table was just created above or already
   existed from before this column was added. */
IF COL_LENGTH('dbo.OrderBookLineNotes', 'PlannedProductionQty') IS NULL
  ALTER TABLE dbo.OrderBookLineNotes ADD PlannedProductionQty DECIMAL(15,3) NULL;

PRINT 'dbo.OrderBookLineNotes PlannedProductionQty column verified/added';


/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT COUNT(*) AS OrderBookLineNotesRows FROM dbo.OrderBookLineNotes;
