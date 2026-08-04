'use strict';
// Initial schema migration for Production (prod.* shop-floor tables) —
// generated from a live extraction of the current production database
// (sql/generate_production_schema_script.sql, run via the admin.html SQL
// Console) on 2026-08-04. Reproduces every base table, DEFAULT/UNIQUE/CHECK
// constraint, non-PK index, and foreign key.
//
// prod.vw_ActiveBatches (view) and the trg_EwaldBoxes_SyncTotals trigger on
// prod.EwaldBoxes both came back with empty OBJECT_DEFINITION() text from
// the live extraction (WITH ENCRYPTION on the source server blocks reading
// it back) — both are reconstructed further down instead, from the last
// known unencrypted source (sql/create_production_database.sql +
// sql/migrate_production_v6.sql's later ALTER VIEW). See the comment at
// that point in this file, and migrations/README.md, for the full story.
//
// NOT reproduced — flagged here rather than silently dropped:
//   - No stored procedures existed to extract (the PROCS section of the
//     extraction came back empty).
//
// Schema only — no data. Reference/lookup data seeding is a separate,
// later migration once that's been decided per table.

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
    // CREATE DATABASE only gives you dbo — the prod schema itself needs
    // creating before any CREATE TABLE prod.* below can run. CREATE SCHEMA
    // must be the only statement in its batch, so it's wrapped in EXEC()
    // to give it that batch on its own within this one knex.raw() call.
    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'prod') EXEC('CREATE SCHEMA prod')");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.BackflushAlerts') AND type = 'U')\r\nCREATE TABLE prod.BackflushAlerts (\r\n    AlertID INT IDENTITY(1,1) NOT NULL\r\n,    ProcessCode NVARCHAR(5) NOT NULL\r\n,    ProcessRecordID INT NOT NULL\r\n,    BatchRef NVARCHAR(15) NULL\r\n,    MaterialDocument NVARCHAR(10) NULL\r\n,    MessageNumber NVARCHAR(4) NOT NULL\r\n,    MessageText NVARCHAR(500) NOT NULL\r\n,    AlertType NVARCHAR(50) NOT NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,    ReviewedAt DATETIME NULL\r\n,    ReviewedByUserID INT NULL\r\n,    ReviewNotes NVARCHAR(500) NULL\r\n,\r\n    CONSTRAINT PK_BackflushAlerts PRIMARY KEY (AlertID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.BatchOperators') AND type = 'U')\r\nCREATE TABLE prod.BatchOperators (\r\n    BatchOperatorID INT IDENTITY(1,1) NOT NULL\r\n,    ProcessCode NVARCHAR(5) NOT NULL\r\n,    ProcessRecordID INT NOT NULL\r\n,    UserID INT NOT NULL\r\n,    IsPrimary BIT NOT NULL\r\n,    AssignedAt DATETIME NOT NULL\r\n,    AssignedByUserID INT NOT NULL\r\n,    RemovedAt DATETIME NULL\r\n,\r\n    CONSTRAINT PK_BatchOperators PRIMARY KEY (BatchOperatorID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Braiding') AND type = 'U')\r\nCREATE TABLE prod.Braiding (\r\n    BraidingID INT IDENTITY(1,1) NOT NULL\r\n,    ShiftID TINYINT NOT NULL\r\n,    MachineID INT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    LengthMetres DECIMAL(12,3) NOT NULL\r\n,    Status TINYINT NOT NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,    StartedAt DATETIME NULL\r\n,    CompletedAt DATETIME NULL\r\n,    CreatedByUserID INT NOT NULL\r\n,    IsReversed BIT NOT NULL\r\n,    ReversedAt DATETIME NULL\r\n,    ReversedByUserID INT NULL\r\n,    Notes NVARCHAR(MAX) NULL\r\n,    BraidRef NVARCHAR(10) NULL\r\n,\r\n    CONSTRAINT PK_Braiding PRIMARY KEY (BraidingID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Convoluting') AND type = 'U')\r\nCREATE TABLE prod.Convoluting (\r\n    ConvolutingID INT IDENTITY(1,1) NOT NULL\r\n,    ShiftID TINYINT NOT NULL\r\n,    MachineID INT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    LengthMetres DECIMAL(12,3) NOT NULL\r\n,    Status TINYINT NOT NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,    StartedAt DATETIME NULL\r\n,    CompletedAt DATETIME NULL\r\n,    CreatedByUserID INT NOT NULL\r\n,    IsReversed BIT NOT NULL\r\n,    ReversedAt DATETIME NULL\r\n,    ReversedByUserID INT NULL\r\n,    Notes NVARCHAR(MAX) NULL\r\n,    ConvRef NVARCHAR(10) NULL\r\n,\r\n    CONSTRAINT PK_Convoluting PRIMARY KEY (ConvolutingID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Coverline') AND type = 'U')\r\nCREATE TABLE prod.Coverline (\r\n    CoverlineID INT IDENTITY(1,1) NOT NULL\r\n,    ShiftID TINYINT NOT NULL\r\n,    MachineID INT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    LengthMetres DECIMAL(12,3) NOT NULL\r\n,    Status TINYINT NOT NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,    StartedAt DATETIME NULL\r\n,    CompletedAt DATETIME NULL\r\n,    CreatedByUserID INT NOT NULL\r\n,    IsReversed BIT NOT NULL\r\n,    ReversedAt DATETIME NULL\r\n,    ReversedByUserID INT NULL\r\n,    Notes NVARCHAR(MAX) NULL\r\n,    CovRef NVARCHAR(10) NULL\r\n,\r\n    CONSTRAINT PK_Coverline PRIMARY KEY (CoverlineID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Drumming') AND type = 'U')\r\nCREATE TABLE prod.Drumming (\r\n    DrummingID INT IDENTITY(1,1) NOT NULL\r\n,    ShiftID TINYINT NOT NULL\r\n,    MachineID INT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    LengthMetres DECIMAL(12,3) NOT NULL\r\n,    SalesOrderSAP NVARCHAR(12) NULL\r\n,    TestPressureBar DECIMAL(6,2) NULL\r\n,    Status TINYINT NOT NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,    StartedAt DATETIME NULL\r\n,    CompletedAt DATETIME NULL\r\n,    CreatedByUserID INT NOT NULL\r\n,    IsReversed BIT NOT NULL\r\n,    ReversedAt DATETIME NULL\r\n,    ReversedByUserID INT NULL\r\n,    Notes NVARCHAR(MAX) NULL\r\n,    PackagingType NVARCHAR(10) NULL\r\n,    TestPressurePSI DECIMAL(6,2) NULL\r\n,    CustomerOrderNo NVARCHAR(50) NULL\r\n,    CustomerID NVARCHAR(50) NULL\r\n,    DrumRef NVARCHAR(10) NULL\r\n,    WeightKG DECIMAL(12,3) NULL\r\n,    EntryType NVARCHAR(10) NULL\r\n,    OrderItem NVARCHAR(6) NULL\r\n,\r\n    CONSTRAINT PK_Drumming PRIMARY KEY (DrummingID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.DrummingCoils') AND type = 'U')\r\nCREATE TABLE prod.DrummingCoils (\r\n    CoilID INT IDENTITY(1,1) NOT NULL\r\n,    DrummingID INT NOT NULL\r\n,    CoilSeq INT NOT NULL\r\n,    LengthM DECIMAL(10,3) NOT NULL\r\n,\r\n    CONSTRAINT PK_DrummingCoils PRIMARY KEY (CoilID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.EventLog') AND type = 'U')\r\nCREATE TABLE prod.EventLog (\r\n    EventID INT IDENTITY(1,1) NOT NULL\r\n,    ProcessCode NVARCHAR(5) NOT NULL\r\n,    ProcessRecordID INT NOT NULL\r\n,    EventType NVARCHAR(20) NOT NULL\r\n,    EventMessage NVARCHAR(MAX) NOT NULL\r\n,    Severity TINYINT NOT NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,    CreatedByUserID INT NOT NULL\r\n,\r\n    CONSTRAINT PK_EventLog PRIMARY KEY (EventID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Ewald') AND type = 'U')\r\nCREATE TABLE prod.Ewald (\r\n    EwaldID INT IDENTITY(1,1) NOT NULL\r\n,    ShiftID TINYINT NOT NULL\r\n,    MachineID INT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    TotalPiecesEA INT NOT NULL\r\n,    TotalBoxes INT NOT NULL\r\n,    FirewallRequired BIT NOT NULL\r\n,    Status TINYINT NOT NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,    StartedAt DATETIME NULL\r\n,    CompletedAt DATETIME NULL\r\n,    CreatedByUserID INT NOT NULL\r\n,    IsReversed BIT NOT NULL\r\n,    ReversedAt DATETIME NULL\r\n,    ReversedByUserID INT NULL\r\n,    Notes NVARCHAR(MAX) NULL\r\n,    EwaldRef NVARCHAR(10) NULL\r\n,\r\n    CONSTRAINT PK_Ewald PRIMARY KEY (EwaldID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.EwaldBoxes') AND type = 'U')\r\nCREATE TABLE prod.EwaldBoxes (\r\n    EwaldBoxID INT IDENTITY(1,1) NOT NULL\r\n,    EwaldID INT NOT NULL\r\n,    PiecesEA INT NOT NULL\r\n,    CustomerCode NVARCHAR(10) NULL\r\n,    SAPBatchNumber NVARCHAR(10) NULL\r\n,    BackflushedAt DATETIME NULL\r\n,    BackflushedByUserID INT NULL\r\n,    IsReversed BIT NOT NULL\r\n,    ReversedAt DATETIME NULL\r\n,    ReversedByUserID INT NULL\r\n,    ReversalDocumentSAP NVARCHAR(10) NULL\r\n,\r\n    CONSTRAINT PK_EwaldBoxes PRIMARY KEY (EwaldBoxID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Extrusion') AND type = 'U')\r\nCREATE TABLE prod.Extrusion (\r\n    ExtrusionID INT IDENTITY(1,1) NOT NULL\r\n,    ShiftID TINYINT NOT NULL\r\n,    MachineID INT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    LengthMetres DECIMAL(12,3) NOT NULL\r\n,    Preforms INT NULL\r\n,    Status TINYINT NOT NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,    StartedAt DATETIME NULL\r\n,    CompletedAt DATETIME NULL\r\n,    CreatedByUserID INT NOT NULL\r\n,    IsReversed BIT NOT NULL\r\n,    ReversedAt DATETIME NULL\r\n,    ReversedByUserID INT NULL\r\n,    Notes NVARCHAR(MAX) NULL\r\n,    ExtRef NVARCHAR(10) NULL\r\n,\r\n    CONSTRAINT PK_Extrusion PRIMARY KEY (ExtrusionID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Firewall') AND type = 'U')\r\nCREATE TABLE prod.Firewall (\r\n    FirewallID INT IDENTITY(1,1) NOT NULL\r\n,    EwaldID INT NOT NULL\r\n,    InspectedByUserID INT NOT NULL\r\n,    InspectedAt DATETIME NOT NULL\r\n,    TotalInspectedEA INT NOT NULL\r\n,    PassedEA INT NOT NULL\r\n,    FailedEA INT NOT NULL\r\n,    Status TINYINT NOT NULL\r\n,    IsReversed BIT NOT NULL\r\n,    ReversedAt DATETIME NULL\r\n,    ReversedByUserID INT NULL\r\n,    Notes NVARCHAR(MAX) NULL\r\n,    FWRef NVARCHAR(10) NULL\r\n,\r\n    CONSTRAINT PK_Firewall PRIMARY KEY (FirewallID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.HoseAssembly') AND type = 'U')\r\nCREATE TABLE prod.HoseAssembly (\r\n    HoseAssemblyID INT IDENTITY(1,1) NOT NULL\r\n,    ShiftID TINYINT NOT NULL\r\n,    MachineID INT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    QuantityEA INT NOT NULL\r\n,    SalesOrderSAP NVARCHAR(12) NULL\r\n,    RequiresQA BIT NOT NULL\r\n,    Status TINYINT NOT NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,    StartedAt DATETIME NULL\r\n,    CompletedAt DATETIME NULL\r\n,    CreatedByUserID INT NOT NULL\r\n,    IsReversed BIT NOT NULL\r\n,    ReversedAt DATETIME NULL\r\n,    ReversedByUserID INT NULL\r\n,    Notes NVARCHAR(MAX) NULL\r\n,    HARef NVARCHAR(10) NULL\r\n,\r\n    CONSTRAINT PK_HoseAssembly PRIMARY KEY (HoseAssemblyID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.HoseAssemblyQARouting') AND type = 'U')\r\nCREATE TABLE prod.HoseAssemblyQARouting (\r\n    RoutingID INT IDENTITY(1,1) NOT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    RequiresQA BIT NOT NULL\r\n,    Notes NVARCHAR(500) NULL\r\n,    UpdatedAt DATETIME NOT NULL\r\n,    UpdatedByUserID INT NOT NULL\r\n,\r\n    CONSTRAINT PK_HARouting PRIMARY KEY (RoutingID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Machines') AND type = 'U')\r\nCREATE TABLE prod.Machines (\r\n    MachineID INT IDENTITY(1,1) NOT NULL\r\n,    WorkCentreID INT NOT NULL\r\n,    MachineCode NVARCHAR(20) NOT NULL\r\n,    MachineName NVARCHAR(100) NOT NULL\r\n,    IdealOutputPerHour DECIMAL(10,3) NULL\r\n,    PlannedHoursPerShift DECIMAL(5,2) NULL\r\n,    IsActive BIT NOT NULL\r\n,    Notes NVARCHAR(MAX) NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_Machines PRIMARY KEY (MachineID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Mixing') AND type = 'U')\r\nCREATE TABLE prod.Mixing (\r\n    MixingID INT IDENTITY(1,1) NOT NULL\r\n,    ShiftID TINYINT NOT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    MixCode NVARCHAR(18) NOT NULL\r\n,    TotalWeightKG DECIMAL(12,3) NOT NULL\r\n,    SupplierBatchNo NVARCHAR(50) NOT NULL\r\n,    SupplierTubNo NVARCHAR(20) NOT NULL\r\n,    Status TINYINT NOT NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,    StartedAt DATETIME NULL\r\n,    CompletedAt DATETIME NULL\r\n,    CreatedByUserID INT NOT NULL\r\n,    IsReversed BIT NOT NULL\r\n,    ReversedAt DATETIME NULL\r\n,    ReversedByUserID INT NULL\r\n,    Notes NVARCHAR(MAX) NULL\r\n,    MixRef NVARCHAR(10) NULL\r\n,\r\n    CONSTRAINT PK_Mixing PRIMARY KEY (MixingID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.MixingTubs') AND type = 'U')\r\nCREATE TABLE prod.MixingTubs (\r\n    TubID INT IDENTITY(1,1) NOT NULL\r\n,    MixingID INT NOT NULL\r\n,    TubSeq INT NOT NULL\r\n,    SupplierTubNo NVARCHAR(20) NOT NULL\r\n,    TubWeightKG DECIMAL(10,3) NOT NULL\r\n,    MaterialDocumentSAP NVARCHAR(10) NULL\r\n,    SAPSuccess BIT NOT NULL\r\n,    SAPErrorMessage NVARCHAR(MAX) NULL\r\n,\r\n    CONSTRAINT PK_MixingTubs PRIMARY KEY (TubID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.ProductionTrace') AND type = 'U')\r\nCREATE TABLE prod.ProductionTrace (\r\n    TraceID INT IDENTITY(1,1) NOT NULL\r\n,    ChildProcessCode NVARCHAR(5) NOT NULL\r\n,    ChildRecordID INT NOT NULL\r\n,    ParentProcessCode NVARCHAR(5) NOT NULL\r\n,    ParentRecordID INT NOT NULL\r\n,    LinkedAt DATETIME NOT NULL\r\n,    LinkedByUserID INT NOT NULL\r\n,    QuantityConsumed DECIMAL(12,3) NULL\r\n,    UnitOfMeasure NVARCHAR(5) NULL\r\n,    MaterialDocumentSAP NVARCHAR(10) NULL\r\n,\r\n    CONSTRAINT PK_ProductionTrace PRIMARY KEY (TraceID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.SAPPostings') AND type = 'U')\r\nCREATE TABLE prod.SAPPostings (\r\n    SAPPostingID INT IDENTITY(1,1) NOT NULL\r\n,    ProcessCode NVARCHAR(5) NOT NULL\r\n,    ProcessRecordID INT NOT NULL\r\n,    PostingType NVARCHAR(20) NOT NULL\r\n,    SalesOrderSAP NVARCHAR(12) NULL\r\n,    ProductionOrderSAP NVARCHAR(12) NULL\r\n,    MaterialDocumentSAP NVARCHAR(10) NULL\r\n,    SAPBatchNumber NVARCHAR(10) NULL\r\n,    Quantity DECIMAL(12,3) NOT NULL\r\n,    UnitOfMeasure NVARCHAR(5) NOT NULL\r\n,    PostedAt DATETIME NOT NULL\r\n,    PostedByUserID INT NOT NULL\r\n,    IsSuccess BIT NOT NULL\r\n,    ErrorMessage NVARCHAR(MAX) NULL\r\n,    IsReversed BIT NOT NULL\r\n,    ReversalDocumentSAP NVARCHAR(10) NULL\r\n,    ReversedAt DATETIME NULL\r\n,    ReversedByUserID INT NULL\r\n,\r\n    CONSTRAINT PK_SAPPostings PRIMARY KEY (SAPPostingID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.ScrapEntries') AND type = 'U')\r\nCREATE TABLE prod.ScrapEntries (\r\n    ScrapID INT IDENTITY(1,1) NOT NULL\r\n,    ProcessCode NVARCHAR(5) NOT NULL\r\n,    ProcessRecordID INT NOT NULL\r\n,    ReasonID INT NOT NULL\r\n,    Quantity DECIMAL(12,3) NOT NULL\r\n,    UnitOfMeasure NVARCHAR(5) NOT NULL\r\n,    EnteredAt DATETIME NOT NULL\r\n,    EnteredByUserID INT NOT NULL\r\n,    Notes NVARCHAR(MAX) NULL\r\n,    IsApproved BIT NOT NULL\r\n,    ApprovedAt DATETIME NULL\r\n,    ApprovedByUserID INT NULL\r\n,    SAPPosted BIT NOT NULL\r\n,    SAPMaterialDocument NVARCHAR(10) NULL\r\n,    SAPErrorMessage NVARCHAR(MAX) NULL\r\n,    IsReversed BIT NOT NULL\r\n,    ReversedAt DATETIME NULL\r\n,    ReversedByUserID INT NULL\r\n,    IsVoided BIT NOT NULL\r\n,\r\n    CONSTRAINT PK_ScrapEntries PRIMARY KEY (ScrapID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.ScrapMaterialDocuments') AND type = 'U')\r\nCREATE TABLE prod.ScrapMaterialDocuments (\r\n    ScrapDocumentID INT IDENTITY(1,1) NOT NULL\r\n,    ScrapID INT NOT NULL\r\n,    MaterialDocument NVARCHAR(18) NOT NULL\r\n,    SAPType NVARCHAR(1) NOT NULL\r\n,    MessageClass NVARCHAR(3) NULL\r\n,    MessageNumber NVARCHAR(4) NULL\r\n,    SAPMessage NVARCHAR(500) NULL\r\n,    PostedAt DATETIME NOT NULL\r\n,    PostedByUserID INT NULL\r\n,    IsReversed BIT NOT NULL\r\n,    ReversalDocument NVARCHAR(18) NULL\r\n,    ReversedAt DATETIME NULL\r\n,    ReversedByUserID INT NULL\r\n,\r\n    CONSTRAINT PK_ScrapMaterialDocuments PRIMARY KEY (ScrapDocumentID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.ScrapReasons') AND type = 'U')\r\nCREATE TABLE prod.ScrapReasons (\r\n    ReasonID INT IDENTITY(1,1) NOT NULL\r\n,    ReasonCode NVARCHAR(10) NOT NULL\r\n,    ReasonDescription NVARCHAR(200) NOT NULL\r\n,    AppliesTo NVARCHAR(100) NULL\r\n,    IsActive BIT NOT NULL\r\n,\r\n    CONSTRAINT PK_ScrapReasons PRIMARY KEY (ReasonID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Shifts') AND type = 'U')\r\nCREATE TABLE prod.Shifts (\r\n    ShiftID TINYINT NOT NULL\r\n,    ShiftName NVARCHAR(10) NOT NULL\r\n,    StartTime NVARCHAR(5) NOT NULL\r\n,    EndTime NVARCHAR(5) NOT NULL\r\n,    SpansMidnight BIT NOT NULL\r\n,    IsActive BIT NOT NULL\r\n,\r\n    CONSTRAINT PK_Shifts PRIMARY KEY (ShiftID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.StatusCodes') AND type = 'U')\r\nCREATE TABLE prod.StatusCodes (\r\n    StatusID TINYINT NOT NULL\r\n,    StatusName NVARCHAR(20) NOT NULL\r\n,\r\n    CONSTRAINT PK_StatusCodes PRIMARY KEY (StatusID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.TapeWrap') AND type = 'U')\r\nCREATE TABLE prod.TapeWrap (\r\n    TapeWrapID INT IDENTITY(1,1) NOT NULL\r\n,    ShiftID TINYINT NOT NULL\r\n,    MachineID INT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    LengthMetres DECIMAL(12,3) NOT NULL\r\n,    Status TINYINT NOT NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,    StartedAt DATETIME NULL\r\n,    CompletedAt DATETIME NULL\r\n,    CreatedByUserID INT NOT NULL\r\n,    IsReversed BIT NOT NULL\r\n,    ReversedAt DATETIME NULL\r\n,    ReversedByUserID INT NULL\r\n,    Notes NVARCHAR(MAX) NULL\r\n,    TWRef NVARCHAR(10) NULL\r\n,\r\n    CONSTRAINT PK_TapeWrap PRIMARY KEY (TapeWrapID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.WorkCentres') AND type = 'U')\r\nCREATE TABLE prod.WorkCentres (\r\n    WorkCentreID INT IDENTITY(1,1) NOT NULL\r\n,    ProcessCode NVARCHAR(5) NOT NULL\r\n,    WorkCentreName NVARCHAR(50) NOT NULL\r\n,    SAPWorkCentre NVARCHAR(20) NULL\r\n,    IsActive BIT NOT NULL\r\n,    Notes NVARCHAR(500) NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_WorkCentres PRIMARY KEY (WorkCentreID)\r\n)");

    await knex.raw("ALTER TABLE prod.BackflushAlerts ADD CONSTRAINT DF_BackflushAlerts_CreatedAt DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE prod.BatchOperators ADD CONSTRAINT DF_BatchOp_IsPrimary DEFAULT ((0)) FOR IsPrimary");

    await knex.raw("ALTER TABLE prod.BatchOperators ADD CONSTRAINT DF_BatchOp_AssignedAt DEFAULT (getdate()) FOR AssignedAt");

    await knex.raw("ALTER TABLE prod.Braiding ADD CONSTRAINT DF_Braiding_Metres DEFAULT ((0)) FOR LengthMetres");

    await knex.raw("ALTER TABLE prod.Braiding ADD CONSTRAINT DF_Braiding_Status DEFAULT ((1)) FOR Status");

    await knex.raw("ALTER TABLE prod.Braiding ADD CONSTRAINT DF_Braiding_CreatedAt DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE prod.Braiding ADD CONSTRAINT DF_Braiding_IsReversed DEFAULT ((0)) FOR IsReversed");

    await knex.raw("ALTER TABLE prod.Convoluting ADD CONSTRAINT DF_Convo_Metres DEFAULT ((0)) FOR LengthMetres");

    await knex.raw("ALTER TABLE prod.Convoluting ADD CONSTRAINT DF_Convo_Status DEFAULT ((1)) FOR Status");

    await knex.raw("ALTER TABLE prod.Convoluting ADD CONSTRAINT DF_Convo_CreatedAt DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE prod.Convoluting ADD CONSTRAINT DF_Convo_IsReversed DEFAULT ((0)) FOR IsReversed");

    await knex.raw("ALTER TABLE prod.Coverline ADD CONSTRAINT DF_Coverline_Metres DEFAULT ((0)) FOR LengthMetres");

    await knex.raw("ALTER TABLE prod.Coverline ADD CONSTRAINT DF_Coverline_Status DEFAULT ((1)) FOR Status");

    await knex.raw("ALTER TABLE prod.Coverline ADD CONSTRAINT DF_Coverline_CreatedAt DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE prod.Coverline ADD CONSTRAINT DF_Coverline_IsReversed DEFAULT ((0)) FOR IsReversed");

    await knex.raw("ALTER TABLE prod.Drumming ADD CONSTRAINT DF_Drumming_Metres DEFAULT ((0)) FOR LengthMetres");

    await knex.raw("ALTER TABLE prod.Drumming ADD CONSTRAINT DF_Drumming_Status DEFAULT ((1)) FOR Status");

    await knex.raw("ALTER TABLE prod.Drumming ADD CONSTRAINT DF_Drumming_CreatedAt DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE prod.Drumming ADD CONSTRAINT DF_Drumming_IsReversed DEFAULT ((0)) FOR IsReversed");

    await knex.raw("ALTER TABLE prod.Drumming ADD CONSTRAINT DF__Drumming__EntryT__40F9A68C DEFAULT ('stock') FOR EntryType");

    await knex.raw("ALTER TABLE prod.EventLog ADD CONSTRAINT DF_EventLog_Severity DEFAULT ((0)) FOR Severity");

    await knex.raw("ALTER TABLE prod.EventLog ADD CONSTRAINT DF_EventLog_CreatedAt DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE prod.Ewald ADD CONSTRAINT DF_Ewald_Pieces DEFAULT ((0)) FOR TotalPiecesEA");

    await knex.raw("ALTER TABLE prod.Ewald ADD CONSTRAINT DF_Ewald_Boxes DEFAULT ((0)) FOR TotalBoxes");

    await knex.raw("ALTER TABLE prod.Ewald ADD CONSTRAINT DF_Ewald_FWRequired DEFAULT ((1)) FOR FirewallRequired");

    await knex.raw("ALTER TABLE prod.Ewald ADD CONSTRAINT DF_Ewald_Status DEFAULT ((1)) FOR Status");

    await knex.raw("ALTER TABLE prod.Ewald ADD CONSTRAINT DF_Ewald_CreatedAt DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE prod.Ewald ADD CONSTRAINT DF_Ewald_IsReversed DEFAULT ((0)) FOR IsReversed");

    await knex.raw("ALTER TABLE prod.EwaldBoxes ADD CONSTRAINT DF_EwaldBoxes_IsReversed DEFAULT ((0)) FOR IsReversed");

    await knex.raw("ALTER TABLE prod.Extrusion ADD CONSTRAINT DF_Extrusion_Metres DEFAULT ((0)) FOR LengthMetres");

    await knex.raw("ALTER TABLE prod.Extrusion ADD CONSTRAINT DF_Extrusion_Status DEFAULT ((1)) FOR Status");

    await knex.raw("ALTER TABLE prod.Extrusion ADD CONSTRAINT DF_Extrusion_CreatedAt DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE prod.Extrusion ADD CONSTRAINT DF_Extrusion_IsReversed DEFAULT ((0)) FOR IsReversed");

    await knex.raw("ALTER TABLE prod.Firewall ADD CONSTRAINT DF_Firewall_InspectedAt DEFAULT (getdate()) FOR InspectedAt");

    await knex.raw("ALTER TABLE prod.Firewall ADD CONSTRAINT DF_Firewall_TotalInspected DEFAULT ((0)) FOR TotalInspectedEA");

    await knex.raw("ALTER TABLE prod.Firewall ADD CONSTRAINT DF_Firewall_PassedEA DEFAULT ((0)) FOR PassedEA");

    await knex.raw("ALTER TABLE prod.Firewall ADD CONSTRAINT DF_Firewall_FailedEA DEFAULT ((0)) FOR FailedEA");

    await knex.raw("ALTER TABLE prod.Firewall ADD CONSTRAINT DF_Firewall_Status DEFAULT ((1)) FOR Status");

    await knex.raw("ALTER TABLE prod.Firewall ADD CONSTRAINT DF_Firewall_IsReversed DEFAULT ((0)) FOR IsReversed");

    await knex.raw("ALTER TABLE prod.HoseAssembly ADD CONSTRAINT DF_HA_Qty DEFAULT ((0)) FOR QuantityEA");

    await knex.raw("ALTER TABLE prod.HoseAssembly ADD CONSTRAINT DF_HA_RequiresQA DEFAULT ((0)) FOR RequiresQA");

    await knex.raw("ALTER TABLE prod.HoseAssembly ADD CONSTRAINT DF_HA_Status DEFAULT ((1)) FOR Status");

    await knex.raw("ALTER TABLE prod.HoseAssembly ADD CONSTRAINT DF_HA_CreatedAt DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE prod.HoseAssembly ADD CONSTRAINT DF_HA_IsReversed DEFAULT ((0)) FOR IsReversed");

    await knex.raw("ALTER TABLE prod.HoseAssemblyQARouting ADD CONSTRAINT DF_HARouting_RequiresQA DEFAULT ((0)) FOR RequiresQA");

    await knex.raw("ALTER TABLE prod.HoseAssemblyQARouting ADD CONSTRAINT DF_HARouting_UpdatedAt DEFAULT (getdate()) FOR UpdatedAt");

    await knex.raw("ALTER TABLE prod.Machines ADD CONSTRAINT DF_Machines_IsActive DEFAULT ((1)) FOR IsActive");

    await knex.raw("ALTER TABLE prod.Machines ADD CONSTRAINT DF_Machines_CreatedAt DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE prod.Mixing ADD CONSTRAINT DF_Mixing_Weight DEFAULT ((0)) FOR TotalWeightKG");

    await knex.raw("ALTER TABLE prod.Mixing ADD CONSTRAINT DF_Mixing_Status DEFAULT ((1)) FOR Status");

    await knex.raw("ALTER TABLE prod.Mixing ADD CONSTRAINT DF_Mixing_CreatedAt DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE prod.Mixing ADD CONSTRAINT DF_Mixing_IsReversed DEFAULT ((0)) FOR IsReversed");

    await knex.raw("ALTER TABLE prod.MixingTubs ADD CONSTRAINT DF_MixingTubs_SAPSuccess DEFAULT ((0)) FOR SAPSuccess");

    await knex.raw("ALTER TABLE prod.ProductionTrace ADD CONSTRAINT DF_Trace_LinkedAt DEFAULT (getdate()) FOR LinkedAt");

    await knex.raw("ALTER TABLE prod.SAPPostings ADD CONSTRAINT DF_SAPPost_PostedAt DEFAULT (getdate()) FOR PostedAt");

    await knex.raw("ALTER TABLE prod.SAPPostings ADD CONSTRAINT DF_SAPPost_IsSuccess DEFAULT ((0)) FOR IsSuccess");

    await knex.raw("ALTER TABLE prod.SAPPostings ADD CONSTRAINT DF_SAPPost_IsReversed DEFAULT ((0)) FOR IsReversed");

    await knex.raw("ALTER TABLE prod.ScrapEntries ADD CONSTRAINT DF_Scrap_EnteredAt DEFAULT (getdate()) FOR EnteredAt");

    await knex.raw("ALTER TABLE prod.ScrapEntries ADD CONSTRAINT DF_Scrap_IsApproved DEFAULT ((0)) FOR IsApproved");

    await knex.raw("ALTER TABLE prod.ScrapEntries ADD CONSTRAINT DF_Scrap_SAPPosted DEFAULT ((0)) FOR SAPPosted");

    await knex.raw("ALTER TABLE prod.ScrapEntries ADD CONSTRAINT DF_Scrap_IsReversed DEFAULT ((0)) FOR IsReversed");

    await knex.raw("ALTER TABLE prod.ScrapEntries ADD CONSTRAINT DF__ScrapEntr__IsVoi__40058253 DEFAULT ((0)) FOR IsVoided");

    await knex.raw("ALTER TABLE prod.ScrapMaterialDocuments ADD CONSTRAINT DF_ScrapDocs_PostedAt DEFAULT (getdate()) FOR PostedAt");

    await knex.raw("ALTER TABLE prod.ScrapMaterialDocuments ADD CONSTRAINT DF_ScrapDocs_IsReversed DEFAULT ((0)) FOR IsReversed");

    await knex.raw("ALTER TABLE prod.ScrapReasons ADD CONSTRAINT DF_ScrapReasons_IsActive DEFAULT ((1)) FOR IsActive");

    await knex.raw("ALTER TABLE prod.Shifts ADD CONSTRAINT DF_Shifts_SpansMidnight DEFAULT ((0)) FOR SpansMidnight");

    await knex.raw("ALTER TABLE prod.Shifts ADD CONSTRAINT DF_Shifts_IsActive DEFAULT ((1)) FOR IsActive");

    await knex.raw("ALTER TABLE prod.TapeWrap ADD CONSTRAINT DF_TapeWrap_Metres DEFAULT ((0)) FOR LengthMetres");

    await knex.raw("ALTER TABLE prod.TapeWrap ADD CONSTRAINT DF_TapeWrap_Status DEFAULT ((1)) FOR Status");

    await knex.raw("ALTER TABLE prod.TapeWrap ADD CONSTRAINT DF_TapeWrap_CreatedAt DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE prod.TapeWrap ADD CONSTRAINT DF_TapeWrap_IsReversed DEFAULT ((0)) FOR IsReversed");

    await knex.raw("ALTER TABLE prod.WorkCentres ADD CONSTRAINT DF_WorkCentres_IsActive DEFAULT ((1)) FOR IsActive");

    await knex.raw("ALTER TABLE prod.WorkCentres ADD CONSTRAINT DF_WorkCentres_CreatedAt DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE prod.Firewall ADD CONSTRAINT UQ_Firewall_EwaldID UNIQUE (EwaldID)");

    await knex.raw("ALTER TABLE prod.HoseAssemblyQARouting ADD CONSTRAINT UQ_HARouting_Material UNIQUE (Material)");

    await knex.raw("ALTER TABLE prod.Machines ADD CONSTRAINT UQ_Machines_Code UNIQUE (MachineCode)");

    await knex.raw("ALTER TABLE prod.ProductionTrace ADD CONSTRAINT UQ_ProductionTrace UNIQUE (ChildProcessCode, ChildRecordID, ParentProcessCode, ParentRecordID)");

    await knex.raw("ALTER TABLE prod.ScrapReasons ADD CONSTRAINT UQ_ScrapReasons_Code UNIQUE (ReasonCode)");

    await knex.raw("ALTER TABLE prod.Shifts ADD CONSTRAINT UQ_Shifts_Name UNIQUE (ShiftName)");

    await knex.raw("ALTER TABLE prod.StatusCodes ADD CONSTRAINT UQ_StatusCodes_Name UNIQUE (StatusName)");

    await knex.raw("ALTER TABLE prod.BatchOperators ADD CONSTRAINT CK_BatchOp_ProcessCode CHECK ([ProcessCode]=N'PV' OR [ProcessCode]=N'HA' OR [ProcessCode]=N'FW' OR [ProcessCode]=N'EW' OR [ProcessCode]=N'DR' OR [ProcessCode]=N'TW' OR [ProcessCode]=N'CL' OR [ProcessCode]=N'BR' OR [ProcessCode]=N'CO' OR [ProcessCode]=N'EX' OR [ProcessCode]=N'MX')");

    await knex.raw("ALTER TABLE prod.EventLog ADD CONSTRAINT CK_EventLog_EventType CHECK ([EventType]=N'NOTE' OR [EventType]=N'FIREWALL' OR [EventType]=N'REVERSAL' OR [EventType]=N'SAP_FAIL' OR [EventType]=N'SAP_POST' OR [EventType]=N'SCRAP' OR [EventType]=N'OPERATOR_REMOVE' OR [EventType]=N'OPERATOR_ADD' OR [EventType]=N'CANCELLED' OR [EventType]=N'ON_HOLD' OR [EventType]=N'COMPLETED' OR [EventType]=N'STARTED')");

    await knex.raw("ALTER TABLE prod.EventLog ADD CONSTRAINT CK_EventLog_ProcessCode CHECK ([ProcessCode]=N'PV' OR [ProcessCode]=N'HA' OR [ProcessCode]=N'FW' OR [ProcessCode]=N'EW' OR [ProcessCode]=N'DR' OR [ProcessCode]=N'TW' OR [ProcessCode]=N'CL' OR [ProcessCode]=N'BR' OR [ProcessCode]=N'CO' OR [ProcessCode]=N'EX' OR [ProcessCode]=N'MX')");

    await knex.raw("ALTER TABLE prod.EventLog ADD CONSTRAINT CK_EventLog_Severity CHECK ([Severity]=(2) OR [Severity]=(1) OR [Severity]=(0))");

    await knex.raw("ALTER TABLE prod.EwaldBoxes ADD CONSTRAINT CK_EwaldBoxes_Pieces CHECK ([PiecesEA]>(0))");

    await knex.raw("ALTER TABLE prod.Firewall ADD CONSTRAINT CK_Firewall_Qty CHECK (([PassedEA]+[FailedEA])<=[TotalInspectedEA])");

    await knex.raw("ALTER TABLE prod.ProductionTrace ADD CONSTRAINT CK_Trace_ChildCode CHECK ([ChildProcessCode]=N'PV' OR [ChildProcessCode]=N'HA' OR [ChildProcessCode]=N'FW' OR [ChildProcessCode]=N'EW' OR [ChildProcessCode]=N'DR' OR [ChildProcessCode]=N'TW' OR [ChildProcessCode]=N'CL' OR [ChildProcessCode]=N'BR' OR [ChildProcessCode]=N'CO' OR [ChildProcessCode]=N'EX' OR [ChildProcessCode]=N'MX')");

    await knex.raw("ALTER TABLE prod.ProductionTrace ADD CONSTRAINT CK_Trace_NoSelfLink CHECK (NOT ([ChildProcessCode]=[ParentProcessCode] AND [ChildRecordID]=[ParentRecordID]))");

    await knex.raw("ALTER TABLE prod.ProductionTrace ADD CONSTRAINT CK_Trace_ParentCode CHECK ([ParentProcessCode]=N'PV' OR [ParentProcessCode]=N'HA' OR [ParentProcessCode]=N'FW' OR [ParentProcessCode]=N'EW' OR [ParentProcessCode]=N'DR' OR [ParentProcessCode]=N'TW' OR [ParentProcessCode]=N'CL' OR [ParentProcessCode]=N'BR' OR [ParentProcessCode]=N'CO' OR [ParentProcessCode]=N'EX' OR [ParentProcessCode]=N'MX')");

    await knex.raw("ALTER TABLE prod.SAPPostings ADD CONSTRAINT CK_SAPPost_PostingType CHECK ([PostingType]=N'REVERSAL' OR [PostingType]=N'SCRAP' OR [PostingType]=N'GOODS_ISSUE' OR [PostingType]=N'BACKFLUSH')");

    await knex.raw("ALTER TABLE prod.SAPPostings ADD CONSTRAINT CK_SAPPost_ProcessCode CHECK ([ProcessCode]=N'PV' OR [ProcessCode]=N'HA' OR [ProcessCode]=N'FW' OR [ProcessCode]=N'EW' OR [ProcessCode]=N'DR' OR [ProcessCode]=N'TW' OR [ProcessCode]=N'CL' OR [ProcessCode]=N'BR' OR [ProcessCode]=N'CO' OR [ProcessCode]=N'EX' OR [ProcessCode]=N'MX')");

    await knex.raw("ALTER TABLE prod.SAPPostings ADD CONSTRAINT CK_SAPPost_UOM CHECK ([UnitOfMeasure]=N'EA' OR [UnitOfMeasure]=N'M' OR [UnitOfMeasure]=N'KG')");

    await knex.raw("ALTER TABLE prod.ScrapEntries ADD CONSTRAINT CK_Scrap_ProcessCode CHECK ([ProcessCode]=N'PV' OR [ProcessCode]=N'HA' OR [ProcessCode]=N'FW' OR [ProcessCode]=N'EW' OR [ProcessCode]=N'DR' OR [ProcessCode]=N'TW' OR [ProcessCode]=N'CL' OR [ProcessCode]=N'BR' OR [ProcessCode]=N'CO' OR [ProcessCode]=N'EX' OR [ProcessCode]=N'MX')");

    await knex.raw("ALTER TABLE prod.ScrapEntries ADD CONSTRAINT CK_Scrap_Qty CHECK ([Quantity]>(0))");

    await knex.raw("ALTER TABLE prod.ScrapEntries ADD CONSTRAINT CK_Scrap_UOM CHECK ([UnitOfMeasure]=N'EA' OR [UnitOfMeasure]=N'M' OR [UnitOfMeasure]=N'KG')");

    await knex.raw("ALTER TABLE prod.WorkCentres ADD CONSTRAINT CK_WorkCentres_ProcCode CHECK ([ProcessCode]=N'PV' OR [ProcessCode]=N'HA' OR [ProcessCode]=N'EW' OR [ProcessCode]=N'DR' OR [ProcessCode]=N'TW' OR [ProcessCode]=N'CL' OR [ProcessCode]=N'BR' OR [ProcessCode]=N'CO' OR [ProcessCode]=N'EX' OR [ProcessCode]=N'MX')");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_BackflushAlerts_Process ON prod.BackflushAlerts (ProcessCode, ProcessRecordID)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_BackflushAlerts_Reviewed ON prod.BackflushAlerts (ReviewedAt) INCLUDE (ProcessCode, BatchRef, AlertType)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_BatchOp_Process ON prod.BatchOperators (ProcessCode, ProcessRecordID) INCLUDE (UserID, IsPrimary, RemovedAt)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_BatchOp_User ON prod.BatchOperators (UserID) INCLUDE (ProcessCode, ProcessRecordID, IsPrimary)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Braiding_CreatedAt ON prod.Braiding (CreatedAt) INCLUDE (Material, Status, BraidRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Braiding_Status ON prod.Braiding (Status) INCLUDE (Material, CreatedAt, BraidRef)");

    await knex.raw("CREATE UNIQUE NONCLUSTERED INDEX UQ_Braiding_BraidRef ON prod.Braiding (BraidRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Convo_CreatedAt ON prod.Convoluting (CreatedAt) INCLUDE (Material, Status, ConvRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Convo_Status ON prod.Convoluting (Status) INCLUDE (Material, CreatedAt, ConvRef)");

    await knex.raw("CREATE UNIQUE NONCLUSTERED INDEX UQ_Convo_ConvRef ON prod.Convoluting (ConvRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Coverline_CreatedAt ON prod.Coverline (CreatedAt) INCLUDE (Material, Status, CovRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Coverline_Status ON prod.Coverline (Status) INCLUDE (Material, CreatedAt, CovRef)");

    await knex.raw("CREATE UNIQUE NONCLUSTERED INDEX UQ_Coverline_CovRef ON prod.Coverline (CovRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Drumming_CreatedAt ON prod.Drumming (CreatedAt) INCLUDE (Material, Status, DrumRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Drumming_SalesOrder ON prod.Drumming (SalesOrderSAP) INCLUDE (Material, Status, DrumRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Drumming_Status ON prod.Drumming (Status) INCLUDE (Material, CreatedAt, DrumRef)");

    await knex.raw("CREATE UNIQUE NONCLUSTERED INDEX UQ_Drumming_DrumRef ON prod.Drumming (DrumRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_DrummingCoils_DrummingID ON prod.DrummingCoils (DrummingID) INCLUDE (CoilSeq, LengthM)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_EventLog_CreatedAt ON prod.EventLog (CreatedAt) INCLUDE (ProcessCode, ProcessRecordID, EventType, Severity)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_EventLog_Process ON prod.EventLog (ProcessCode, ProcessRecordID, CreatedAt) INCLUDE (EventType, Severity)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Ewald_CreatedAt ON prod.Ewald (CreatedAt) INCLUDE (Material, Status, EwaldRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Ewald_Status ON prod.Ewald (Status) INCLUDE (Material, CreatedAt, EwaldRef)");

    await knex.raw("CREATE UNIQUE NONCLUSTERED INDEX UQ_Ewald_EwaldRef ON prod.Ewald (EwaldRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_EwaldBoxes_EwaldID ON prod.EwaldBoxes (EwaldID) INCLUDE (PiecesEA, IsReversed)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Extrusion_CreatedAt ON prod.Extrusion (CreatedAt) INCLUDE (Material, Status, ExtRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Extrusion_Status ON prod.Extrusion (Status) INCLUDE (Material, CreatedAt, ExtRef)");

    await knex.raw("CREATE UNIQUE NONCLUSTERED INDEX UQ_Extrusion_ExtRef ON prod.Extrusion (ExtRef)");

    await knex.raw("CREATE UNIQUE NONCLUSTERED INDEX UQ_Firewall_FWRef ON prod.Firewall (FWRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_HA_CreatedAt ON prod.HoseAssembly (CreatedAt) INCLUDE (Material, Status, HARef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_HA_Status ON prod.HoseAssembly (Status) INCLUDE (Material, CreatedAt, HARef)");

    await knex.raw("CREATE UNIQUE NONCLUSTERED INDEX UQ_HA_HARef ON prod.HoseAssembly (HARef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Mixing_CreatedAt ON prod.Mixing (CreatedAt) INCLUDE (Material, Status, MixRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Mixing_Status ON prod.Mixing (Status) INCLUDE (Material, CreatedAt, MixRef)");

    await knex.raw("CREATE UNIQUE NONCLUSTERED INDEX UQ_Mixing_MixRef ON prod.Mixing (MixRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_MixingTubs_MixingID ON prod.MixingTubs (MixingID) INCLUDE (TubSeq, TubWeightKG, SAPSuccess)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Trace_Child ON prod.ProductionTrace (ChildProcessCode, ChildRecordID) INCLUDE (ParentProcessCode, ParentRecordID)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Trace_Parent ON prod.ProductionTrace (ParentProcessCode, ParentRecordID) INCLUDE (ChildProcessCode, ChildRecordID)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_SAPPost_MatDoc ON prod.SAPPostings (MaterialDocumentSAP) INCLUDE (ProcessCode, ProcessRecordID, PostingType, IsReversed)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_SAPPost_PostedAt ON prod.SAPPostings (PostedAt) INCLUDE (ProcessCode, ProcessRecordID, IsSuccess, IsReversed)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_SAPPost_Process ON prod.SAPPostings (ProcessCode, ProcessRecordID) INCLUDE (PostingType, PostedAt, IsSuccess, IsReversed)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Scrap_Approved ON prod.ScrapEntries (IsApproved, SAPPosted) INCLUDE (ProcessCode, ProcessRecordID, Quantity)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Scrap_EnteredAt ON prod.ScrapEntries (EnteredAt) INCLUDE (ProcessCode, ProcessRecordID, Quantity)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Scrap_Process ON prod.ScrapEntries (ProcessCode, ProcessRecordID) INCLUDE (Quantity, UnitOfMeasure, EnteredAt)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_ScrapDocs_Reversible ON prod.ScrapMaterialDocuments (IsReversed) INCLUDE (ScrapID, MaterialDocument, ReversalDocument)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_ScrapDocs_ScrapID ON prod.ScrapMaterialDocuments (ScrapID) INCLUDE (MaterialDocument, PostedAt, IsReversed)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_TapeWrap_CreatedAt ON prod.TapeWrap (CreatedAt) INCLUDE (Material, Status, TWRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_TapeWrap_Status ON prod.TapeWrap (Status) INCLUDE (Material, CreatedAt, TWRef)");

    await knex.raw("CREATE UNIQUE NONCLUSTERED INDEX UQ_TapeWrap_TWRef ON prod.TapeWrap (TWRef)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_WorkCentres_ProcessCode ON prod.WorkCentres (ProcessCode)");

    await knex.raw("ALTER TABLE prod.Braiding ADD CONSTRAINT FK_Braiding_Mach FOREIGN KEY (MachineID) REFERENCES prod.Machines (MachineID)");

    await knex.raw("ALTER TABLE prod.Braiding ADD CONSTRAINT FK_Braiding_Shift FOREIGN KEY (ShiftID) REFERENCES prod.Shifts (ShiftID)");

    await knex.raw("ALTER TABLE prod.Braiding ADD CONSTRAINT FK_Braiding_Status FOREIGN KEY (Status) REFERENCES prod.StatusCodes (StatusID)");

    await knex.raw("ALTER TABLE prod.Convoluting ADD CONSTRAINT FK_Convo_Machine FOREIGN KEY (MachineID) REFERENCES prod.Machines (MachineID)");

    await knex.raw("ALTER TABLE prod.Convoluting ADD CONSTRAINT FK_Convo_Shift FOREIGN KEY (ShiftID) REFERENCES prod.Shifts (ShiftID)");

    await knex.raw("ALTER TABLE prod.Convoluting ADD CONSTRAINT FK_Convo_Status FOREIGN KEY (Status) REFERENCES prod.StatusCodes (StatusID)");

    await knex.raw("ALTER TABLE prod.Coverline ADD CONSTRAINT FK_Coverline_Mach FOREIGN KEY (MachineID) REFERENCES prod.Machines (MachineID)");

    await knex.raw("ALTER TABLE prod.Coverline ADD CONSTRAINT FK_Coverline_Shift FOREIGN KEY (ShiftID) REFERENCES prod.Shifts (ShiftID)");

    await knex.raw("ALTER TABLE prod.Coverline ADD CONSTRAINT FK_Coverline_Status FOREIGN KEY (Status) REFERENCES prod.StatusCodes (StatusID)");

    await knex.raw("ALTER TABLE prod.Drumming ADD CONSTRAINT FK_Drumming_Mach FOREIGN KEY (MachineID) REFERENCES prod.Machines (MachineID)");

    await knex.raw("ALTER TABLE prod.Drumming ADD CONSTRAINT FK_Drumming_Shift FOREIGN KEY (ShiftID) REFERENCES prod.Shifts (ShiftID)");

    await knex.raw("ALTER TABLE prod.Drumming ADD CONSTRAINT FK_Drumming_Status FOREIGN KEY (Status) REFERENCES prod.StatusCodes (StatusID)");

    await knex.raw("ALTER TABLE prod.DrummingCoils ADD CONSTRAINT FK_DrummingCoils_DR FOREIGN KEY (DrummingID) REFERENCES prod.Drumming (DrummingID)");

    await knex.raw("ALTER TABLE prod.Ewald ADD CONSTRAINT FK_Ewald_Mach FOREIGN KEY (MachineID) REFERENCES prod.Machines (MachineID)");

    await knex.raw("ALTER TABLE prod.Ewald ADD CONSTRAINT FK_Ewald_Shift FOREIGN KEY (ShiftID) REFERENCES prod.Shifts (ShiftID)");

    await knex.raw("ALTER TABLE prod.Ewald ADD CONSTRAINT FK_Ewald_Status FOREIGN KEY (Status) REFERENCES prod.StatusCodes (StatusID)");

    await knex.raw("ALTER TABLE prod.EwaldBoxes ADD CONSTRAINT FK_EwaldBoxes_Ewald FOREIGN KEY (EwaldID) REFERENCES prod.Ewald (EwaldID)");

    await knex.raw("ALTER TABLE prod.Extrusion ADD CONSTRAINT FK_Extrusion_Machine FOREIGN KEY (MachineID) REFERENCES prod.Machines (MachineID)");

    await knex.raw("ALTER TABLE prod.Extrusion ADD CONSTRAINT FK_Extrusion_Shift FOREIGN KEY (ShiftID) REFERENCES prod.Shifts (ShiftID)");

    await knex.raw("ALTER TABLE prod.Extrusion ADD CONSTRAINT FK_Extrusion_Status FOREIGN KEY (Status) REFERENCES prod.StatusCodes (StatusID)");

    await knex.raw("ALTER TABLE prod.Firewall ADD CONSTRAINT FK_Firewall_Ewald FOREIGN KEY (EwaldID) REFERENCES prod.Ewald (EwaldID)");

    await knex.raw("ALTER TABLE prod.Firewall ADD CONSTRAINT FK_Firewall_Status FOREIGN KEY (Status) REFERENCES prod.StatusCodes (StatusID)");

    await knex.raw("ALTER TABLE prod.HoseAssembly ADD CONSTRAINT FK_HA_Mach FOREIGN KEY (MachineID) REFERENCES prod.Machines (MachineID)");

    await knex.raw("ALTER TABLE prod.HoseAssembly ADD CONSTRAINT FK_HA_Shift FOREIGN KEY (ShiftID) REFERENCES prod.Shifts (ShiftID)");

    await knex.raw("ALTER TABLE prod.HoseAssembly ADD CONSTRAINT FK_HA_Status FOREIGN KEY (Status) REFERENCES prod.StatusCodes (StatusID)");

    await knex.raw("ALTER TABLE prod.Machines ADD CONSTRAINT FK_Machines_WC FOREIGN KEY (WorkCentreID) REFERENCES prod.WorkCentres (WorkCentreID)");

    await knex.raw("ALTER TABLE prod.Mixing ADD CONSTRAINT FK_Mixing_Shift FOREIGN KEY (ShiftID) REFERENCES prod.Shifts (ShiftID)");

    await knex.raw("ALTER TABLE prod.Mixing ADD CONSTRAINT FK_Mixing_Status FOREIGN KEY (Status) REFERENCES prod.StatusCodes (StatusID)");

    await knex.raw("ALTER TABLE prod.MixingTubs ADD CONSTRAINT FK_MixingTubs_MX FOREIGN KEY (MixingID) REFERENCES prod.Mixing (MixingID)");

    await knex.raw("ALTER TABLE prod.ScrapEntries ADD CONSTRAINT FK_Scrap_Reason FOREIGN KEY (ReasonID) REFERENCES prod.ScrapReasons (ReasonID)");

    await knex.raw("ALTER TABLE prod.ScrapMaterialDocuments ADD CONSTRAINT FK_ScrapDocs_Scrap FOREIGN KEY (ScrapID) REFERENCES prod.ScrapEntries (ScrapID)");

    await knex.raw("ALTER TABLE prod.TapeWrap ADD CONSTRAINT FK_TapeWrap_Mach FOREIGN KEY (MachineID) REFERENCES prod.Machines (MachineID)");

    await knex.raw("ALTER TABLE prod.TapeWrap ADD CONSTRAINT FK_TapeWrap_Shift FOREIGN KEY (ShiftID) REFERENCES prod.Shifts (ShiftID)");

    await knex.raw("ALTER TABLE prod.TapeWrap ADD CONSTRAINT FK_TapeWrap_Status FOREIGN KEY (Status) REFERENCES prod.StatusCodes (StatusID)");

    // prod.vw_ActiveBatches and prod.trg_EwaldBoxes_SyncTotals were both
    // WITH ENCRYPTION on the source server, so OBJECT_DEFINITION() came back
    // empty during extraction (see migrations/README.md). Reconstructed here
    // from the last known unencrypted source instead: the view is the final
    // form per sql/migrate_production_v6.sql's ALTER VIEW (superseding the
    // original in sql/create_production_database.sql — column shape
    // cross-checked against sql/production_schema.csv's live column dump,
    // 11 columns, exact match); the trigger was never altered after its
    // original creation in sql/create_production_database.sql. Neither
    // tracked source ever included WITH ENCRYPTION, so that must have been
    // added later via SSMS directly, outside any committed script — meaning
    // there's a small chance of an undocumented logic change alongside that
    // step that this reconstruction wouldn't capture. Recreated here
    // unencrypted on purpose — encryption only hides them from yourself.
    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.vw_ActiveBatches') AND type = 'V') BEGIN DECLARE @sql NVARCHAR(MAX); SET @sql = N'CREATE VIEW prod.vw_ActiveBatches AS\n    SELECT N''MX''  AS ProcessCode, MixingID        AS RecordID, MixRef     AS BatchRef, Material, CAST(TotalWeightKG         AS DECIMAL(12,3)) AS Quantity, N''KG'' AS UOM, Status, ShiftID, NULL AS MachineID, CreatedAt, StartedAt FROM prod.Mixing       WHERE Status IN (1,2) AND IsReversed = 0\n    UNION ALL SELECT N''EX'',  ExtrusionID,   ExtRef,   Material, LengthMetres,                          N''M'',  Status, ShiftID, MachineID,              CreatedAt, StartedAt FROM prod.Extrusion    WHERE Status IN (1,2) AND IsReversed=0\n    UNION ALL SELECT N''CO'',  ConvolutingID, ConvRef,  Material, LengthMetres,                          N''M'',  Status, ShiftID, MachineID,              CreatedAt, StartedAt FROM prod.Convoluting  WHERE Status IN (1,2) AND IsReversed=0\n    UNION ALL SELECT N''BR'',  BraidingID,    BraidRef, Material, LengthMetres,                          N''M'',  Status, ShiftID, MachineID,              CreatedAt, StartedAt FROM prod.Braiding     WHERE Status IN (1,2) AND IsReversed=0\n    UNION ALL SELECT N''CL'',  CoverlineID,   CovRef,   Material, LengthMetres,                          N''M'',  Status, ShiftID, MachineID,              CreatedAt, StartedAt FROM prod.Coverline    WHERE Status IN (1,2) AND IsReversed=0\n    UNION ALL SELECT N''TW'',  TapeWrapID,    TWRef,    Material, LengthMetres,                          N''M'',  Status, ShiftID, MachineID,              CreatedAt, StartedAt FROM prod.TapeWrap     WHERE Status IN (1,2) AND IsReversed=0\n    UNION ALL SELECT N''DR'',  DrummingID,    DrumRef,  Material, LengthMetres,                          N''M'',  Status, ShiftID, NULL      AS MachineID, CreatedAt, StartedAt FROM prod.Drumming     WHERE Status IN (1,2) AND IsReversed=0\n    UNION ALL SELECT N''EW'',  EwaldID,       EwaldRef, Material, CAST(TotalPiecesEA AS DECIMAL(12,3)),  N''EA'', Status, ShiftID, MachineID,              CreatedAt, StartedAt FROM prod.Ewald        WHERE Status IN (1,2) AND IsReversed=0\n    UNION ALL SELECT N''HA'',  HoseAssemblyID,HARef,    Material, CAST(QuantityEA    AS DECIMAL(12,3)),  N''EA'', Status, ShiftID, MachineID,              CreatedAt, StartedAt FROM prod.HoseAssembly WHERE Status IN (1,2) AND IsReversed=0'; EXEC(@sql); END");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.triggers WHERE name = N'trg_EwaldBoxes_SyncTotals' AND parent_id = OBJECT_ID(N'prod.EwaldBoxes')) BEGIN DECLARE @sql NVARCHAR(MAX); SET @sql = N'CREATE TRIGGER prod.trg_EwaldBoxes_SyncTotals\nON prod.EwaldBoxes\nAFTER INSERT, UPDATE\nAS\nBEGIN\n    SET NOCOUNT ON\n    UPDATE e\n    SET\n        e.TotalPiecesEA = ISNULL((\n            SELECT SUM(eb.PiecesEA)\n            FROM   prod.EwaldBoxes eb\n            WHERE  eb.EwaldID    = e.EwaldID\n              AND  eb.IsReversed = 0\n        ), 0),\n        e.TotalBoxes = ISNULL((\n            SELECT COUNT(*)\n            FROM   prod.EwaldBoxes eb\n            WHERE  eb.EwaldID    = e.EwaldID\n              AND  eb.IsReversed = 0\n        ), 0)\n    FROM prod.Ewald e\n    INNER JOIN (SELECT DISTINCT EwaldID FROM inserted) i\n        ON i.EwaldID = e.EwaldID\nEND'; EXEC(@sql); END");
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = N'trg_EwaldBoxes_SyncTotals' AND parent_id = OBJECT_ID(N'prod.EwaldBoxes')) DROP TRIGGER prod.trg_EwaldBoxes_SyncTotals");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.vw_ActiveBatches') AND type = 'V') DROP VIEW prod.vw_ActiveBatches");

    await knex.raw('ALTER TABLE prod.Braiding DROP CONSTRAINT FK_Braiding_Mach');
    await knex.raw('ALTER TABLE prod.Braiding DROP CONSTRAINT FK_Braiding_Shift');
    await knex.raw('ALTER TABLE prod.Braiding DROP CONSTRAINT FK_Braiding_Status');
    await knex.raw('ALTER TABLE prod.Convoluting DROP CONSTRAINT FK_Convo_Machine');
    await knex.raw('ALTER TABLE prod.Convoluting DROP CONSTRAINT FK_Convo_Shift');
    await knex.raw('ALTER TABLE prod.Convoluting DROP CONSTRAINT FK_Convo_Status');
    await knex.raw('ALTER TABLE prod.Coverline DROP CONSTRAINT FK_Coverline_Mach');
    await knex.raw('ALTER TABLE prod.Coverline DROP CONSTRAINT FK_Coverline_Shift');
    await knex.raw('ALTER TABLE prod.Coverline DROP CONSTRAINT FK_Coverline_Status');
    await knex.raw('ALTER TABLE prod.Drumming DROP CONSTRAINT FK_Drumming_Mach');
    await knex.raw('ALTER TABLE prod.Drumming DROP CONSTRAINT FK_Drumming_Shift');
    await knex.raw('ALTER TABLE prod.Drumming DROP CONSTRAINT FK_Drumming_Status');
    await knex.raw('ALTER TABLE prod.DrummingCoils DROP CONSTRAINT FK_DrummingCoils_DR');
    await knex.raw('ALTER TABLE prod.Ewald DROP CONSTRAINT FK_Ewald_Mach');
    await knex.raw('ALTER TABLE prod.Ewald DROP CONSTRAINT FK_Ewald_Shift');
    await knex.raw('ALTER TABLE prod.Ewald DROP CONSTRAINT FK_Ewald_Status');
    await knex.raw('ALTER TABLE prod.EwaldBoxes DROP CONSTRAINT FK_EwaldBoxes_Ewald');
    await knex.raw('ALTER TABLE prod.Extrusion DROP CONSTRAINT FK_Extrusion_Machine');
    await knex.raw('ALTER TABLE prod.Extrusion DROP CONSTRAINT FK_Extrusion_Shift');
    await knex.raw('ALTER TABLE prod.Extrusion DROP CONSTRAINT FK_Extrusion_Status');
    await knex.raw('ALTER TABLE prod.Firewall DROP CONSTRAINT FK_Firewall_Ewald');
    await knex.raw('ALTER TABLE prod.Firewall DROP CONSTRAINT FK_Firewall_Status');
    await knex.raw('ALTER TABLE prod.HoseAssembly DROP CONSTRAINT FK_HA_Mach');
    await knex.raw('ALTER TABLE prod.HoseAssembly DROP CONSTRAINT FK_HA_Shift');
    await knex.raw('ALTER TABLE prod.HoseAssembly DROP CONSTRAINT FK_HA_Status');
    await knex.raw('ALTER TABLE prod.Machines DROP CONSTRAINT FK_Machines_WC');
    await knex.raw('ALTER TABLE prod.Mixing DROP CONSTRAINT FK_Mixing_Shift');
    await knex.raw('ALTER TABLE prod.Mixing DROP CONSTRAINT FK_Mixing_Status');
    await knex.raw('ALTER TABLE prod.MixingTubs DROP CONSTRAINT FK_MixingTubs_MX');
    await knex.raw('ALTER TABLE prod.ScrapEntries DROP CONSTRAINT FK_Scrap_Reason');
    await knex.raw('ALTER TABLE prod.ScrapMaterialDocuments DROP CONSTRAINT FK_ScrapDocs_Scrap');
    await knex.raw('ALTER TABLE prod.TapeWrap DROP CONSTRAINT FK_TapeWrap_Mach');
    await knex.raw('ALTER TABLE prod.TapeWrap DROP CONSTRAINT FK_TapeWrap_Shift');
    await knex.raw('ALTER TABLE prod.TapeWrap DROP CONSTRAINT FK_TapeWrap_Status');

    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.BackflushAlerts') AND type = 'U') DROP TABLE prod.BackflushAlerts");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.BatchOperators') AND type = 'U') DROP TABLE prod.BatchOperators");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Braiding') AND type = 'U') DROP TABLE prod.Braiding");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Convoluting') AND type = 'U') DROP TABLE prod.Convoluting");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Coverline') AND type = 'U') DROP TABLE prod.Coverline");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Drumming') AND type = 'U') DROP TABLE prod.Drumming");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.DrummingCoils') AND type = 'U') DROP TABLE prod.DrummingCoils");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.EventLog') AND type = 'U') DROP TABLE prod.EventLog");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Ewald') AND type = 'U') DROP TABLE prod.Ewald");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.EwaldBoxes') AND type = 'U') DROP TABLE prod.EwaldBoxes");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Extrusion') AND type = 'U') DROP TABLE prod.Extrusion");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Firewall') AND type = 'U') DROP TABLE prod.Firewall");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.HoseAssembly') AND type = 'U') DROP TABLE prod.HoseAssembly");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.HoseAssemblyQARouting') AND type = 'U') DROP TABLE prod.HoseAssemblyQARouting");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Machines') AND type = 'U') DROP TABLE prod.Machines");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Mixing') AND type = 'U') DROP TABLE prod.Mixing");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.MixingTubs') AND type = 'U') DROP TABLE prod.MixingTubs");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.ProductionTrace') AND type = 'U') DROP TABLE prod.ProductionTrace");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.SAPPostings') AND type = 'U') DROP TABLE prod.SAPPostings");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.ScrapEntries') AND type = 'U') DROP TABLE prod.ScrapEntries");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.ScrapMaterialDocuments') AND type = 'U') DROP TABLE prod.ScrapMaterialDocuments");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.ScrapReasons') AND type = 'U') DROP TABLE prod.ScrapReasons");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Shifts') AND type = 'U') DROP TABLE prod.Shifts");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.StatusCodes') AND type = 'U') DROP TABLE prod.StatusCodes");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.TapeWrap') AND type = 'U') DROP TABLE prod.TapeWrap");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.WorkCentres') AND type = 'U') DROP TABLE prod.WorkCentres");

    await knex.raw("IF EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'prod') EXEC('DROP SCHEMA prod')");
};
