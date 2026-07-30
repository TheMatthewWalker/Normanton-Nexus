/* ============================================================
   ConsignmentStockSnapshot — run against the kongsberg database.
   Compatibility: SQL Server 2005+ (no GO, no MERGE — matches every other
   migration in this project).

   Caches the plant-wide consignment stock pull (MKOL SLABS, SOBKZ=K) that
   the Vendor Consignment Tracker's balance dashboard needs, so opening the
   dashboard is an instant SQL read instead of a live synchronous SAP call.

   WHY THIS EXISTS: PerformanceHelpers.BuildConsignmentStockRequest is an
   unfiltered plant-wide table scan — the codebase's own precedent for how
   slow it can be is the turns-valclass MRP sync, which gives its SAP client
   a 10-minute timeout for exactly this call (see routes/performancesap.js).
   The balance dashboard originally called it live, synchronously, on every
   page open — users were waiting minutes for a page load (2026-07-30). This
   table lets a daily cron job (see server.js's 06:20 slot, extended in
   routes/consignment.js's runConsignmentSync) do that slow pull once every
   morning and cache the result, with an optional manual "Refresh Now" for
   anyone who needs fresher numbers before the next cron run — see
   POST /api/consignment/stock/refresh.

   Deliberately overwrite-only (TRUNCATE + re-insert every run), same
   convention as dbo.TurnsValClassSnapshot — this is a live cache, not a
   history table. No FK to dbo.Vendor: the underlying SAP query is
   plant-wide and materials aren't owned by any single vendor at this
   table's level; the balance route filters down to a vendor's own
   materials itself (via dbo.VendorMaterial) after reading this table.
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.ConsignmentStockSnapshot') AND type = 'U')
BEGIN
  CREATE TABLE dbo.ConsignmentStockSnapshot (
    Material       NVARCHAR(18)  NOT NULL,
    Qty            DECIMAL(15,3) NOT NULL,
    SnapshotAtUtc  DATETIME      NOT NULL,

    CONSTRAINT PK_ConsignmentStockSnapshot PRIMARY KEY (Material)
  );

  PRINT 'Created dbo.ConsignmentStockSnapshot';
END
ELSE
  PRINT 'dbo.ConsignmentStockSnapshot already exists — skipped';

/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT COUNT(*) AS MaterialCount, MAX(SnapshotAtUtc) AS LastSnapshotAtUtc
FROM dbo.ConsignmentStockSnapshot;
