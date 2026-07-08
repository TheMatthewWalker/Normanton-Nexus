/* ============================================================
   MM Turns / Valuation Class — run against the kongsberg database.
   Compatibility : SQL Server 2005+ (matches the rest of the
   Performance* snapshot tables — no GO, no CONCAT(), no DATETIME2).

   Stores the data pulled from SapServer's PerformanceController
   turns-valclass endpoints:
     GET  /api/performance/turns-valclass
     GET  /api/performance/turns-valclass/valuation-classes
     POST /api/performance/turns-valclass/change-valuation-class

   1. dbo.TurnsValClassSnapshot   — one row per material/plant, latest
                                     pull only (TRUNCATE + reinsert on
                                     every sync — same pattern as
                                     dbo.StockSnapshot / dbo.AgreementSnapshot).
   2. dbo.ValuationClassCatalog   — valid valuation classes per material
                                     type, for the change-valuation-class
                                     dropdown (T025/T025T/T134 catalog).
   3. dbo.ValuationClassChangeBatch  — one row per change-valuation-class
                                        POST (header: order, plant, who, when).
   4. dbo.ValuationClassChangeDetail — one row per material within that
                                        batch (mirrors ValClassChangeResult).

   dbo.RefreshLog already exists (written by the Stock/Agreements/
   Invoicing/Otif sync) and is reused here with two new DatasetName
   values: 'TurnsValClass' and 'ValuationClasses'. It is (re)created
   below with IF NOT EXISTS purely as a safety net — the block is a
   no-op on any database where it's already present.
   ============================================================ */


/* ── 0. RefreshLog (safety net — normally already exists) ───────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.RefreshLog') AND type = 'U')
BEGIN
  CREATE TABLE dbo.RefreshLog (
    RunId          INT           NOT NULL IDENTITY(1,1),
    DatasetName    NVARCHAR(50)  NOT NULL,
    StartedAtUtc   DATETIME      NOT NULL,
    CompletedAtUtc DATETIME      NULL,
    Status         NVARCHAR(20)  NOT NULL,   -- 'Running' | 'Success' | 'Failed'
    TotalRows      INT           NULL,
    ErrorMessage   NVARCHAR(4000) NULL,

    CONSTRAINT PK_RefreshLog PRIMARY KEY (RunId)
  );

  CREATE INDEX IX_RefreshLog_Dataset ON dbo.RefreshLog (DatasetName, RunId DESC);

  PRINT 'Created dbo.RefreshLog';
END
ELSE
  PRINT 'dbo.RefreshLog already exists — skipped';


/* ── 1. TurnsValClassSnapshot ────────────────────────────────────────────
   Direct port of TurnsValClassRow. History/forecast are stored as 13 wide
   columns (not a child table) to keep the existing replaceTable() batch-
   insert helper (TRUNCATE + UNION ALL SELECT) working unchanged — the
   same approach already used for every other *Snapshot table.
   Column suffix M12..M00 mirrors the row comment: index 0 = 12 months
   out (oldest for history, furthest-out for forecast), index 12 = the
   current partial month — so M12 is the oldest/furthest bucket and M00
   is the current month for both series.                                */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.TurnsValClassSnapshot') AND type = 'U')
BEGIN
  CREATE TABLE dbo.TurnsValClassSnapshot (
    Material               NVARCHAR(18)   NOT NULL,   -- MATNR
    Plant                  NVARCHAR(4)    NOT NULL,   -- WERKS
    MaterialText            NVARCHAR(40)   NULL,       -- MAKTX
    CreatedDate             DATETIME       NULL,        -- ERSDA
    MaterialType             NVARCHAR(4)    NULL,       -- MTART
    Uom                      NVARCHAR(3)    NULL,       -- MEINS
    ProfitCentre             NVARCHAR(10)   NULL,       -- PRCTR
    DeletionFlag             BIT            NOT NULL DEFAULT 0, -- LVORM
    AbcIndicator             NVARCHAR(1)    NULL,       -- MAABC
    PurchasingGroup          NVARCHAR(3)    NULL,       -- EKGRP
    MrpController            NVARCHAR(3)    NULL,       -- DISPO
    ValuationClass           NVARCHAR(4)    NULL,       -- BKLAS
    LotSizeProcedure         NVARCHAR(2)    NULL,       -- DISLS
    PlanningTimeFence        DECIMAL(9,0)   NULL,       -- FXHOR
    GrProcessingTime         DECIMAL(9,2)   NULL,       -- WEBAZ
    TotalReplenishmentTime   DECIMAL(9,2)   NULL,       -- DZEIT
    SafetyStock              DECIMAL(15,3)  NULL,       -- EISBE
    MinLotSize               DECIMAL(15,3)  NULL,       -- BSTMI
    MaxLotSize               DECIMAL(15,3)  NULL,       -- BSTMA
    FixedLotSize             DECIMAL(15,3)  NULL,       -- BSTFE
    RoundingValue            DECIMAL(15,3)  NULL,       -- BSTRF
    SpecialProcurementType   NVARCHAR(2)    NULL,       -- SOBSL
    PlannedDeliveryTime      DECIMAL(9,2)   NULL,       -- PLIFZ

    StockQty                 DECIMAL(15,3)  NULL,       -- MBEW-LBKUM
    StockValue                DECIMAL(18,2) NULL,       -- MBEW-SALK3
    UnitPrice                 DECIMAL(15,4) NULL,       -- MBEW-STPRS / PEINH
    BookValue                 DECIMAL(18,2) NULL,       -- StockValue * factor(ValuationClass)

    -- ConsumptionHistory[0..12] — MVER GSV01-12, 13 rolling months
    HistoryM12 DECIMAL(15,3) NULL,  HistoryM11 DECIMAL(15,3) NULL,  HistoryM10 DECIMAL(15,3) NULL,
    HistoryM09 DECIMAL(15,3) NULL,  HistoryM08 DECIMAL(15,3) NULL,  HistoryM07 DECIMAL(15,3) NULL,
    HistoryM06 DECIMAL(15,3) NULL,  HistoryM05 DECIMAL(15,3) NULL,  HistoryM04 DECIMAL(15,3) NULL,
    HistoryM03 DECIMAL(15,3) NULL,  HistoryM02 DECIMAL(15,3) NULL,  HistoryM01 DECIMAL(15,3) NULL,
    HistoryM00 DECIMAL(15,3) NULL,

    -- DemandForecast[0..12] — Z_STOCK_REQ_LIST summary, 13 rolling months
    ForecastM12 DECIMAL(15,3) NULL, ForecastM11 DECIMAL(15,3) NULL, ForecastM10 DECIMAL(15,3) NULL,
    ForecastM09 DECIMAL(15,3) NULL, ForecastM08 DECIMAL(15,3) NULL, ForecastM07 DECIMAL(15,3) NULL,
    ForecastM06 DECIMAL(15,3) NULL, ForecastM05 DECIMAL(15,3) NULL, ForecastM04 DECIMAL(15,3) NULL,
    ForecastM03 DECIMAL(15,3) NULL, ForecastM02 DECIMAL(15,3) NULL, ForecastM01 DECIMAL(15,3) NULL,
    ForecastM00 DECIMAL(15,3) NULL,

    LastReceiptDate        DATETIME NULL,   -- S032 LETZTZUG
    LastGoodsIssueDate     DATETIME NULL,   -- S032 LETZTABG
    LastConsumptionDate    DATETIME NULL,   -- S032 LETZTVER
    LastGoodsMovementDate  DATETIME NULL,   -- S032 LETZTBEW

    StockTurns              DECIMAL(15,4) NULL,   -- NULL when non-numeric state
    DaysInStock             DECIMAL(15,2) NULL,
    DailyRequirementValue    DECIMAL(18,4) NULL,
    TurnoverCategory          NVARCHAR(30)  NULL,
    Warning                   NVARCHAR(200) NULL,

    SnapshotAtUtc             DATETIME NOT NULL DEFAULT GETUTCDATE(),

    CONSTRAINT PK_TurnsValClassSnapshot PRIMARY KEY (Material, Plant)
  );

  CREATE INDEX IX_TVC_ValuationClass ON dbo.TurnsValClassSnapshot (ValuationClass) INCLUDE (Material, StockValue, BookValue);
  CREATE INDEX IX_TVC_MrpController  ON dbo.TurnsValClassSnapshot (MrpController) INCLUDE (Material, StockValue);
  CREATE INDEX IX_TVC_MaterialType   ON dbo.TurnsValClassSnapshot (MaterialType)  INCLUDE (Material, StockValue);
  CREATE INDEX IX_TVC_ProfitCentre   ON dbo.TurnsValClassSnapshot (ProfitCentre)  INCLUDE (Material, StockValue);

  PRINT 'Created dbo.TurnsValClassSnapshot';
END
ELSE
  PRINT 'dbo.TurnsValClassSnapshot already exists — skipped';


/* ── 2. ValuationClassCatalog ─────────────────────────────────────────────
   Direct port of ValClassRow (T025/T025T/T134). Small reference table,
   refreshed the same TRUNCATE + reinsert way as the snapshot table.     */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.ValuationClassCatalog') AND type = 'U')
BEGIN
  CREATE TABLE dbo.ValuationClassCatalog (
    ValuationClass NVARCHAR(4)  NOT NULL,   -- BKLAS
    MaterialType   NVARCHAR(4)  NOT NULL,   -- MTART
    AccountRef     NVARCHAR(4)  NULL,       -- KKREF
    Description    NVARCHAR(40) NULL,       -- BKBEZ

    CONSTRAINT PK_ValuationClassCatalog PRIMARY KEY (ValuationClass, MaterialType)
  );

  PRINT 'Created dbo.ValuationClassCatalog';
END
ELSE
  PRINT 'dbo.ValuationClassCatalog already exists — skipped';


/* ── 3. ValuationClassChangeBatch ─────────────────────────────────────────
   Audit header — one row per change-valuation-class POST. This table is
   append-only (never truncated); it's the log of who changed what.      */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.ValuationClassChangeBatch') AND type = 'U')
BEGIN
  CREATE TABLE dbo.ValuationClassChangeBatch (
    BatchID           INT           NOT NULL IDENTITY(1,1),
    OrderNumber       NVARCHAR(12)  NOT NULL,   -- SAP production/CO order used as the transit doc
    Plant             NVARCHAR(4)   NULL,
    RequestedByUserID INT           NULL,
    RequestedByName   NVARCHAR(80)  NULL,
    RequestedAtUtc    DATETIME      NOT NULL DEFAULT GETUTCDATE(),
    Success           BIT           NOT NULL DEFAULT 0,
    TotalValueChange  DECIMAL(18,2) NULL,
    ErrorMessage      NVARCHAR(4000) NULL,

    CONSTRAINT PK_ValuationClassChangeBatch PRIMARY KEY (BatchID)
  );

  CREATE INDEX IX_VCCBatch_RequestedAt ON dbo.ValuationClassChangeBatch (RequestedAtUtc DESC);

  PRINT 'Created dbo.ValuationClassChangeBatch';
END
ELSE
  PRINT 'dbo.ValuationClassChangeBatch already exists — skipped';


/* ── 4. ValuationClassChangeDetail ────────────────────────────────────────
   One row per material within a batch — mirrors ValClassChangeResult.   */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.ValuationClassChangeDetail') AND type = 'U')
BEGIN
  CREATE TABLE dbo.ValuationClassChangeDetail (
    DetailID          INT           NOT NULL IDENTITY(1,1),
    BatchID           INT           NOT NULL,
    Material          NVARCHAR(18)  NOT NULL,
    MaterialText      NVARCHAR(40)  NULL,
    Plant             NVARCHAR(4)   NULL,
    StockQty          DECIMAL(15,3) NULL,
    OldValuationClass NVARCHAR(4)   NULL,
    NewValuationClass NVARCHAR(4)   NULL,
    OldBookValue      DECIMAL(18,2) NULL,
    NewBookValue      DECIMAL(18,2) NULL,
    ValueChange       DECIMAL(18,2) NULL,
    Success           BIT           NOT NULL DEFAULT 0,
    Message           NVARCHAR(500) NULL,

    CONSTRAINT PK_ValuationClassChangeDetail PRIMARY KEY (DetailID),
    CONSTRAINT FK_VCCDetail_Batch FOREIGN KEY (BatchID)
                                  REFERENCES  dbo.ValuationClassChangeBatch (BatchID)
  );

  CREATE INDEX IX_VCCDetail_Batch    ON dbo.ValuationClassChangeDetail (BatchID);
  CREATE INDEX IX_VCCDetail_Material ON dbo.ValuationClassChangeDetail (Material) INCLUDE (BatchID, Success);

  PRINT 'Created dbo.ValuationClassChangeDetail';
END
ELSE
  PRINT 'dbo.ValuationClassChangeDetail already exists — skipped';


/* ── Verify ──────────────────────────────────────────────────────────────── */
SELECT 'TurnsValClassSnapshot'      AS TableName, COUNT(*) AS Rows FROM dbo.TurnsValClassSnapshot
UNION ALL
SELECT 'ValuationClassCatalog',                   COUNT(*)         FROM dbo.ValuationClassCatalog
UNION ALL
SELECT 'ValuationClassChangeBatch',               COUNT(*)         FROM dbo.ValuationClassChangeBatch
UNION ALL
SELECT 'ValuationClassChangeDetail',              COUNT(*)         FROM dbo.ValuationClassChangeDetail;
