/* ============================================================
   Staging Post — material requisition from Production to Stores.
   Run against the kongsberg database.
   Compatibility : SQL Server 2005+ (matches migrate_vendor_master_data.sql
   and migrate_order_suggestions.sql — no GO, no CONCAT(), no DATETIME2).
   DATETIME (not DATE) throughout — this instance predates the DATE type
   (SQL Server 2008+ only), same lesson as migrate_demand_adjustments.sql.

   WORKFLOW:
     1. Production raises a request (dbo.StagingRequest): material, quantity,
        a plant location it needs delivering to, an optional specific batch
        (for materials where a particular drum matters), and a due date —
        "Needed By" — enforced client/server side to be at least 4 hours out
        (NeededByMinLeadHours in routes/staging.js), so Stores is never asked
        for an impossible immediate turnaround; production can push it out
        further (8 hours, next shift, etc.) with no upper bound.
     2. Stores works the open list (Status = 'Open'), sorted by DueAtUtc —
        the SAP stock lookup (LQUA via SapServer's existing GetStock/
        BuildStockRequest) and transfer order creation
        (L_TO_CREATE_SINGLE, also pre-existing) both happen live against SAP,
        nothing about physical stock is cached in this table.
     3. Each "Mark Delivered" action creates one dbo.StagingRequestDelivery
        row (a full audit trail of every transfer order raised against a
        request, since one request can be fulfilled across more than one
        trip) and adds to StagingRequest.QuantityDelivered.
     4. If the new cumulative QuantityDelivered is within 10% of
        QuantityRequested (routes/staging.js's WITHIN_TOLERANCE_PCT), Stores
        is offered a choice: confirm the request Complete, or leave it Open
        (e.g. they know more is coming). Outside that 10% band the request
        just stays Open automatically — no choice offered, since it's
        obviously not done yet.
     5. Completed (or Cancelled) requests move out of the open list into the
        audit trail — see dbo.StagingRequestDelivery for the full delivery
        history behind each one, and routes/staging.js's KPI endpoint for the
        on-time% / lead-time reporting built from CompletedAtUtc vs DueAtUtc
        and RequestedAtUtc.

   BATCH-SPECIFIC REQUESTS: RequestedBatch is populated by Production only
   when they need a specific drum/batch (picked from the material's live SAP
   stock at request time — there's no "is this material batch managed" flag
   stored anywhere in this app, so the request form simply offers a batch
   picker whenever LQUA actually returns batches for that material). When
   set, Stores' stock view for that request is pre-filtered to just that
   batch's location rather than showing the whole material's spread.

   BIN RESTRICTIONS (dbo.StagingBinRestriction): some materials must only be
   picked from specific bins/bin types due to manual FIFO placement on the
   floor. A material can have several allowed rows; Bin left NULL means "any
   bin within this StorageType is allowed". Only used to flag/sort Stores'
   stock view (allowed bins first/highlighted) — SAP itself enforces nothing
   here, so the restriction is advisory-but-obvious, and Stores can still see
   (just not be steered toward) stock sitting in a non-permitted bin, so they
   don't mistakenly think there's no stock at all.
   ============================================================ */


/* ── 1. StagingRequest ────────────────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.StagingRequest') AND type = 'U')
BEGIN
  CREATE TABLE dbo.StagingRequest (
    RequestId         INT           NOT NULL IDENTITY(1,1),

    Material          NVARCHAR(18)  NOT NULL,
    MaterialText      NVARCHAR(80)  NULL,   -- snapshot at request time, for display without a join
    Uom               NVARCHAR(3)   NULL,

    QuantityRequested DECIMAL(15,3) NOT NULL,
    QuantityDelivered DECIMAL(15,3) NOT NULL DEFAULT 0,   -- cumulative across every StagingRequestDelivery row

    Location          NVARCHAR(100) NOT NULL,   -- one of the 7 production line names, or "Other: <free text>"
    RequestedBatch    NVARCHAR(10)  NULL,        -- specific drum/batch, only set when Production picked one

    DueAtUtc          DATETIME      NOT NULL,   -- "Needed By" — min now + 4 hours, enforced in routes/staging.js
    Notes             NVARCHAR(500) NULL,

    Status            NVARCHAR(20)  NOT NULL DEFAULT 'Open',  -- Open / Completed / Cancelled

    RequestedBy       NVARCHAR(100) NOT NULL,
    RequestedAtUtc    DATETIME      NOT NULL DEFAULT GETUTCDATE(),

    CompletedBy       NVARCHAR(100) NULL,
    CompletedAtUtc    DATETIME      NULL,

    CancelledBy       NVARCHAR(100) NULL,
    CancelledAtUtc    DATETIME      NULL,

    UpdatedAtUtc      DATETIME      NOT NULL DEFAULT GETUTCDATE(),

    CONSTRAINT PK_StagingRequest PRIMARY KEY (RequestId),
    CONSTRAINT CK_StagingRequest_Qty CHECK (QuantityRequested > 0 AND QuantityDelivered >= 0)
  );

  -- Stores' main tool: open demand only, sorted by due date.
  CREATE INDEX IX_StagingRequest_Status_Due ON dbo.StagingRequest (Status, DueAtUtc) INCLUDE (Material, QuantityRequested, QuantityDelivered, Location, RequestedBatch);
  CREATE INDEX IX_StagingRequest_Material    ON dbo.StagingRequest (Material);

  PRINT 'Created dbo.StagingRequest';
END
ELSE
  PRINT 'dbo.StagingRequest already exists — skipped';


/* ── 2. StagingRequestDelivery ────────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.StagingRequestDelivery') AND type = 'U')
BEGIN
  CREATE TABLE dbo.StagingRequestDelivery (
    DeliveryId             INT           NOT NULL IDENTITY(1,1),
    RequestId              INT           NOT NULL,

    QuantityMoved          DECIMAL(15,3) NOT NULL,
    Batch                  NVARCHAR(10)  NULL,

    SourceStorageType      NVARCHAR(3)   NULL,
    SourceBin              NVARCHAR(10)  NULL,
    DestinationStorageType NVARCHAR(3)   NULL,
    DestinationBin         NVARCHAR(10)  NULL,

    TransferOrderNumber    NVARCHAR(10)  NULL,   -- SAP L_TO_CREATE_SINGLE result; NULL if SAP rejected it but it was recorded anyway

    DeliveredBy            NVARCHAR(100) NOT NULL,
    DeliveredAtUtc          DATETIME      NOT NULL DEFAULT GETUTCDATE(),

    CONSTRAINT PK_StagingRequestDelivery PRIMARY KEY (DeliveryId),
    CONSTRAINT FK_SRD_StagingRequest FOREIGN KEY (RequestId) REFERENCES dbo.StagingRequest (RequestId)
  );

  CREATE INDEX IX_StagingRequestDelivery_RequestId ON dbo.StagingRequestDelivery (RequestId);

  PRINT 'Created dbo.StagingRequestDelivery';
END
ELSE
  PRINT 'dbo.StagingRequestDelivery already exists — skipped';


/* ── 3. StagingBinRestriction ─────────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.StagingBinRestriction') AND type = 'U')
BEGIN
  CREATE TABLE dbo.StagingBinRestriction (
    RestrictionId INT           NOT NULL IDENTITY(1,1),
    Material      NVARCHAR(18)  NOT NULL,
    StorageType   NVARCHAR(3)   NOT NULL,
    Bin           NVARCHAR(10)  NULL,   -- NULL = any bin within this storage type is allowed
    Notes         NVARCHAR(200) NULL,

    CreatedBy     NVARCHAR(100) NULL,
    CreatedAtUtc  DATETIME      NOT NULL DEFAULT GETUTCDATE(),

    CONSTRAINT PK_StagingBinRestriction PRIMARY KEY (RestrictionId)
  );

  CREATE INDEX IX_StagingBinRestriction_Material ON dbo.StagingBinRestriction (Material);

  PRINT 'Created dbo.StagingBinRestriction';
END
ELSE
  PRINT 'dbo.StagingBinRestriction already exists — skipped';


/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT 'StagingRequest'         AS TableName, COUNT(*) AS Rows FROM dbo.StagingRequest;
SELECT 'StagingRequestDelivery' AS TableName, COUNT(*) AS Rows FROM dbo.StagingRequestDelivery;
SELECT 'StagingBinRestriction'  AS TableName, COUNT(*) AS Rows FROM dbo.StagingBinRestriction;
