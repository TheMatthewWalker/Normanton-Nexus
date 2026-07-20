/* ============================================================
   Manual demand adjustments for MRP — run against the kongsberg database.
   Compatibility : SQL Server 2005+ (matches create_performance_turnsvalclass_database.sql
   — no GO, no CONCAT(), no DATETIME2).

   Lets a planner override a material's predicted usage for a known reason
   the seasonal-index forecast (performanceforecast.js) can't see on its
   own — a machine down for maintenance, a planned extra production run, or
   simply a standing correction because the automatic forecast is running
   too high or low for a material. Expressed as a percentage of whatever
   the forecast already predicts for each day (50 = half the normal rate,
   150 = one and a half times), over an optional date range.

   Both StartDate and EndDate are nullable, independently:
     StartDate NULL  = no lower bound — applies from the start of the
                        13-month forecast horizon (i.e. from "today"
                        onward, since the horizon always starts there).
     EndDate   NULL  = no upper bound — applies indefinitely until the
                        row is edited or deleted. This is the "the
                        forecast is just wrong for this material" case,
                        as opposed to a temporary, dated event.
   Both NULL together = a permanent, unconditional correction to the
   material's predicted usage.

   Read by routes/performance.js's buildWeeklyStockForecast/demandOverDays
   (both switched from a month-overlap-fraction usage calc to a day-by-day
   one specifically to support this — see those functions' comments) and
   applied to both the Stock History & Forecast graph and the order-
   suggestion engine, since both are driven by the same underlying
   PredictedUsage figures.

   Overlapping date ranges for the SAME material are rejected at the
   application layer (routes/performancesql.js's createDemandAdjustment/
   updateDemandAdjustment) rather than with a SQL constraint — a range
   check across nullable bounds isn't expressible as a simple CHECK
   constraint, and the app needs to return a clear error message anyway.
   ============================================================ */


IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.DemandAdjustment') AND type = 'U')
BEGIN
  CREATE TABLE dbo.DemandAdjustment (
    AdjustmentId    INT           NOT NULL IDENTITY(1,1),
    Material        NVARCHAR(18)  NOT NULL,  -- MATNR, matches TurnsValClassSnapshot.Material

    -- NULL = unbounded in that direction — see the header note above.
    -- DATETIME, not DATE, to match every other date column in this project
    -- (Vendor, PurchaseOrderShipment, etc.) — this SQL Server instance
    -- predates the DATE type (added in SQL Server 2008). Time component is
    -- always midnight; comparisons in findOverlappingDemandAdjustment and
    -- the day-level forecast walk only ever compare whole days.
    StartDate       DATETIME      NULL,
    EndDate         DATETIME      NULL,

    -- Percentage of the normal predicted daily usage to apply over the
    -- range above. 0 = fully stopped (e.g. a machine down for the whole
    -- period), 50 = half rate, 150 = one and a half times (planned extra
    -- production). Never negative — a material can't un-consume itself.
    UsagePercent    DECIMAL(9,2)  NOT NULL,

    Reason          NVARCHAR(500) NULL,
    CreatedBy       NVARCHAR(100) NULL,
    CreatedAtUtc    DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    UpdatedAtUtc    DATETIME      NOT NULL DEFAULT GETUTCDATE(),

    CONSTRAINT PK_DemandAdjustment PRIMARY KEY (AdjustmentId),
    CONSTRAINT CK_DemandAdjustment_DateRange CHECK (EndDate IS NULL OR StartDate IS NULL OR EndDate >= StartDate),
    CONSTRAINT CK_DemandAdjustment_UsagePercent CHECK (UsagePercent >= 0)
  );

  CREATE INDEX IX_DemandAdjustment_Material ON dbo.DemandAdjustment (Material);

  PRINT 'Created dbo.DemandAdjustment';
END
ELSE
  PRINT 'dbo.DemandAdjustment already exists — skipped';


/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT COUNT(*) AS DemandAdjustmentRows FROM dbo.DemandAdjustment;
