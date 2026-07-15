/* ============================================================
   Production Database -- Full Schema Creation Script
   Compatibility : SQL Server 2005+
   Run this script connected to the Production database.
   Create the database manually first if it does not exist:
       CREATE DATABASE Production
   Then connect to Production and execute this script.

   Changes from standard T-SQL for SQL 2005 compatibility:
     - No GO (not supported in all client tools)
     - No CONCAT() -- uses + concatenation instead
     - No DATETIME2 -- uses DATETIME
     - No filtered indexes (WHERE clause) -- SQL 2008+
     - CREATE SCHEMA / VIEW / TRIGGER wrapped in EXEC()
       because they must be the only statement in a batch
   ============================================================ */

/* ----------------------------------------------------------
   Schema
   ---------------------------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'prod')
    EXEC('CREATE SCHEMA prod')


/* ============================================================
   SECTION 1 -- REFERENCE / CONFIGURATION TABLES
   ============================================================ */

/* 1.1  StatusCodes ----------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.StatusCodes') AND type = 'U')
BEGIN
    CREATE TABLE prod.StatusCodes (
        StatusID   TINYINT      NOT NULL,
        StatusName NVARCHAR(20) NOT NULL,
        CONSTRAINT PK_StatusCodes      PRIMARY KEY (StatusID),
        CONSTRAINT UQ_StatusCodes_Name UNIQUE      (StatusName)
    )

    INSERT INTO prod.StatusCodes (StatusID, StatusName) VALUES (1, N'OPEN')
    INSERT INTO prod.StatusCodes (StatusID, StatusName) VALUES (2, N'IN_PROGRESS')
    INSERT INTO prod.StatusCodes (StatusID, StatusName) VALUES (3, N'ON_HOLD')
    INSERT INTO prod.StatusCodes (StatusID, StatusName) VALUES (4, N'COMPLETE')
    INSERT INTO prod.StatusCodes (StatusID, StatusName) VALUES (5, N'CANCELLED')
END


/* 1.2  Shifts ---------------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Shifts') AND type = 'U')
BEGIN
    CREATE TABLE prod.Shifts (
        ShiftID       TINYINT      NOT NULL,
        ShiftName     NVARCHAR(10) NOT NULL,
        StartTime     NVARCHAR(5)  NOT NULL,   -- stored as 'HH:MM'
        EndTime       NVARCHAR(5)  NOT NULL,
        SpansMidnight BIT          NOT NULL CONSTRAINT DF_Shifts_SpansMidnight DEFAULT 0,
        IsActive      BIT          NOT NULL CONSTRAINT DF_Shifts_IsActive      DEFAULT 1,
        CONSTRAINT PK_Shifts      PRIMARY KEY (ShiftID),
        CONSTRAINT UQ_Shifts_Name UNIQUE      (ShiftName)
    )

    INSERT INTO prod.Shifts (ShiftID, ShiftName, StartTime, EndTime, SpansMidnight) VALUES (1, N'DAYS',   N'06:00', N'14:00', 0)
    INSERT INTO prod.Shifts (ShiftID, ShiftName, StartTime, EndTime, SpansMidnight) VALUES (2, N'AFTERS', N'14:00', N'22:00', 0)
    INSERT INTO prod.Shifts (ShiftID, ShiftName, StartTime, EndTime, SpansMidnight) VALUES (3, N'NIGHTS', N'22:00', N'06:00', 1)
END


/* 1.3  WorkCentres ----------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.WorkCentres') AND type = 'U')
BEGIN
    CREATE TABLE prod.WorkCentres (
        WorkCentreID   INT           NOT NULL IDENTITY(1,1),
        ProcessCode    NVARCHAR(5)   NOT NULL,
        WorkCentreName NVARCHAR(50)  NOT NULL,
        SAPWorkCentre  NVARCHAR(20)  NULL,
        IsActive       BIT           NOT NULL CONSTRAINT DF_WorkCentres_IsActive  DEFAULT 1,
        Notes          NVARCHAR(500) NULL,
        CreatedAt      DATETIME      NOT NULL CONSTRAINT DF_WorkCentres_CreatedAt DEFAULT GETDATE(),
        CONSTRAINT PK_WorkCentres           PRIMARY KEY (WorkCentreID),
        CONSTRAINT CK_WorkCentres_ProcCode  CHECK (ProcessCode IN (N'MX',N'EXT',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'HA'))
    )

    CREATE INDEX IX_WorkCentres_ProcessCode ON prod.WorkCentres (ProcessCode)
END


/* 1.4  Machines -------------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Machines') AND type = 'U')
BEGIN
    CREATE TABLE prod.Machines (
        MachineID            INT           NOT NULL IDENTITY(1,1),
        WorkCentreID         INT           NOT NULL,
        MachineCode          NVARCHAR(20)  NOT NULL,
        MachineName          NVARCHAR(100) NOT NULL,
        IdealOutputPerHour   DECIMAL(10,3) NULL,
        PlannedHoursPerShift DECIMAL(5,2)  NULL,
        IsActive             BIT           NOT NULL CONSTRAINT DF_Machines_IsActive  DEFAULT 1,
        Notes                NVARCHAR(MAX) NULL,
        CreatedAt            DATETIME      NOT NULL CONSTRAINT DF_Machines_CreatedAt DEFAULT GETDATE(),
        CONSTRAINT PK_Machines          PRIMARY KEY (MachineID),
        CONSTRAINT UQ_Machines_Code     UNIQUE      (MachineCode),
        CONSTRAINT FK_Machines_WC       FOREIGN KEY (WorkCentreID) REFERENCES prod.WorkCentres (WorkCentreID)
    )
END


/* 1.5  ScrapReasons ---------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.ScrapReasons') AND type = 'U')
BEGIN
    CREATE TABLE prod.ScrapReasons (
        ReasonID          INT           NOT NULL IDENTITY(1,1),
        ReasonCode        NVARCHAR(10)  NOT NULL,
        ReasonDescription NVARCHAR(200) NOT NULL,
        AppliesTo         NVARCHAR(100) NULL,   -- comma-separated process codes; NULL = all
        IsActive          BIT           NOT NULL CONSTRAINT DF_ScrapReasons_IsActive DEFAULT 1,
        CONSTRAINT PK_ScrapReasons      PRIMARY KEY (ReasonID),
        CONSTRAINT UQ_ScrapReasons_Code UNIQUE      (ReasonCode)
    )
END


/* 1.6  HoseAssemblyQARouting ------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.HoseAssemblyQARouting') AND type = 'U')
BEGIN
    CREATE TABLE prod.HoseAssemblyQARouting (
        RoutingID       INT           NOT NULL IDENTITY(1,1),
        Material        NVARCHAR(18)  NOT NULL,
        RequiresQA      BIT           NOT NULL CONSTRAINT DF_HARouting_RequiresQA DEFAULT 0,
        Notes           NVARCHAR(500) NULL,
        UpdatedAt       DATETIME      NOT NULL CONSTRAINT DF_HARouting_UpdatedAt   DEFAULT GETDATE(),
        UpdatedByUserID INT           NOT NULL,
        CONSTRAINT PK_HARouting          PRIMARY KEY (RoutingID),
        CONSTRAINT UQ_HARouting_Material UNIQUE      (Material)
    )
END


/* ============================================================
   SECTION 2 -- PROCESS TABLES
   BatchRef pattern (8-digit zero-padded, e.g. MX-00001140):
     N'MX-' + RIGHT('00000000' + CAST([ID] AS VARCHAR(8)), 8)
   CONCAT() is not available in SQL Server 2005.
   ============================================================ */

/* 2.1  Mixing  --  KG  --  prefix MX ---------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Mixing') AND type = 'U')
BEGIN
    CREATE TABLE prod.Mixing (
        MixingID         INT           NOT NULL IDENTITY(1,1),
        MixRef           AS (CAST(N'MX-' + RIGHT('00000000' + CAST(MixingID AS VARCHAR(8)), 8) AS NVARCHAR(12))) PERSISTED,
        ShiftID          TINYINT       NOT NULL,
        Material         NVARCHAR(18)  NOT NULL,
        MixCode          NVARCHAR(18)  NOT NULL,
        TotalWeightKG    DECIMAL(12,3) NOT NULL CONSTRAINT DF_Mixing_Weight    DEFAULT 0,
        SupplierBatchNo  NVARCHAR(50)  NOT NULL,
        SupplierTubNo    NVARCHAR(20)  NOT NULL,
        Status           TINYINT       NOT NULL CONSTRAINT DF_Mixing_Status    DEFAULT 1,
        CreatedAt        DATETIME      NOT NULL CONSTRAINT DF_Mixing_CreatedAt DEFAULT GETDATE(),
        StartedAt        DATETIME      NULL,
        CompletedAt      DATETIME      NULL,
        CreatedByUserID  INT           NOT NULL,
        IsReversed       BIT           NOT NULL CONSTRAINT DF_Mixing_IsReversed DEFAULT 0,
        ReversedAt       DATETIME      NULL,
        ReversedByUserID INT           NULL,
        Notes            NVARCHAR(MAX) NULL,
        CONSTRAINT PK_Mixing        PRIMARY KEY (MixingID),
        CONSTRAINT FK_Mixing_Shift  FOREIGN KEY (ShiftID) REFERENCES prod.Shifts     (ShiftID),
        CONSTRAINT FK_Mixing_Status FOREIGN KEY (Status)  REFERENCES prod.StatusCodes(StatusID)
    )

    CREATE UNIQUE INDEX UQ_Mixing_MixRef   ON prod.Mixing (MixRef)
    CREATE INDEX IX_Mixing_Status          ON prod.Mixing (Status)    INCLUDE (MixRef, Material, CreatedAt)
    CREATE INDEX IX_Mixing_CreatedAt       ON prod.Mixing (CreatedAt) INCLUDE (MixRef, Material, Status)
END


/* 2.2  Extrusion  --  M  --  prefix EXT ------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Extrusion') AND type = 'U')
BEGIN
    CREATE TABLE prod.Extrusion (
        ExtrusionID      INT           NOT NULL IDENTITY(1,1),
        ExtRef           AS (CAST(N'EXT-' + RIGHT('00000000' + CAST(ExtrusionID AS VARCHAR(8)), 8) AS NVARCHAR(12))) PERSISTED,
        ShiftID          TINYINT       NOT NULL,
        MachineID        INT           NULL,
        Material         NVARCHAR(18)  NOT NULL,
        LengthMetres     DECIMAL(12,3) NOT NULL CONSTRAINT DF_Extrusion_Metres    DEFAULT 0,
        Preforms         INT           NULL,
        Status           TINYINT       NOT NULL CONSTRAINT DF_Extrusion_Status    DEFAULT 1,
        CreatedAt        DATETIME      NOT NULL CONSTRAINT DF_Extrusion_CreatedAt DEFAULT GETDATE(),
        StartedAt        DATETIME      NULL,
        CompletedAt      DATETIME      NULL,
        CreatedByUserID  INT           NOT NULL,
        IsReversed       BIT           NOT NULL CONSTRAINT DF_Extrusion_IsReversed DEFAULT 0,
        ReversedAt       DATETIME      NULL,
        ReversedByUserID INT           NULL,
        Notes            NVARCHAR(MAX) NULL,
        CONSTRAINT PK_Extrusion           PRIMARY KEY (ExtrusionID),
        CONSTRAINT FK_Extrusion_Shift     FOREIGN KEY (ShiftID)   REFERENCES prod.Shifts     (ShiftID),
        CONSTRAINT FK_Extrusion_Machine   FOREIGN KEY (MachineID) REFERENCES prod.Machines   (MachineID),
        CONSTRAINT FK_Extrusion_Status    FOREIGN KEY (Status)    REFERENCES prod.StatusCodes(StatusID)
    )

    CREATE UNIQUE INDEX UQ_Extrusion_ExtRef   ON prod.Extrusion (ExtRef)
    CREATE INDEX IX_Extrusion_Status          ON prod.Extrusion (Status)    INCLUDE (ExtRef, Material, CreatedAt)
    CREATE INDEX IX_Extrusion_CreatedAt       ON prod.Extrusion (CreatedAt) INCLUDE (ExtRef, Material, Status)
END


/* 2.3  Convoluting  --  M  --  prefix CO ------------------ */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Convoluting') AND type = 'U')
BEGIN
    CREATE TABLE prod.Convoluting (
        ConvolutingID    INT           NOT NULL IDENTITY(1,1),
        ConvRef          AS (CAST(N'CO-' + RIGHT('00000000' + CAST(ConvolutingID AS VARCHAR(8)), 8) AS NVARCHAR(12))) PERSISTED,
        ShiftID          TINYINT       NOT NULL,
        MachineID        INT           NULL,
        Material         NVARCHAR(18)  NOT NULL,
        LengthMetres     DECIMAL(12,3) NOT NULL CONSTRAINT DF_Convo_Metres    DEFAULT 0,
        Status           TINYINT       NOT NULL CONSTRAINT DF_Convo_Status    DEFAULT 1,
        CreatedAt        DATETIME      NOT NULL CONSTRAINT DF_Convo_CreatedAt DEFAULT GETDATE(),
        StartedAt        DATETIME      NULL,
        CompletedAt      DATETIME      NULL,
        CreatedByUserID  INT           NOT NULL,
        IsReversed       BIT           NOT NULL CONSTRAINT DF_Convo_IsReversed DEFAULT 0,
        ReversedAt       DATETIME      NULL,
        ReversedByUserID INT           NULL,
        Notes            NVARCHAR(MAX) NULL,
        CONSTRAINT PK_Convoluting        PRIMARY KEY (ConvolutingID),
        CONSTRAINT FK_Convo_Shift        FOREIGN KEY (ShiftID)   REFERENCES prod.Shifts     (ShiftID),
        CONSTRAINT FK_Convo_Machine      FOREIGN KEY (MachineID) REFERENCES prod.Machines   (MachineID),
        CONSTRAINT FK_Convo_Status       FOREIGN KEY (Status)    REFERENCES prod.StatusCodes(StatusID)
    )

    CREATE UNIQUE INDEX UQ_Convo_ConvRef   ON prod.Convoluting (ConvRef)
    CREATE INDEX IX_Convo_Status           ON prod.Convoluting (Status)    INCLUDE (ConvRef, Material, CreatedAt)
    CREATE INDEX IX_Convo_CreatedAt        ON prod.Convoluting (CreatedAt) INCLUDE (ConvRef, Material, Status)
END


/* 2.4  Braiding  --  M  --  prefix BR --------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Braiding') AND type = 'U')
BEGIN
    CREATE TABLE prod.Braiding (
        BraidingID       INT           NOT NULL IDENTITY(1,1),
        BraidRef         AS (CAST(N'BR-' + RIGHT('00000000' + CAST(BraidingID AS VARCHAR(8)), 8) AS NVARCHAR(12))) PERSISTED,
        ShiftID          TINYINT       NOT NULL,
        MachineID        INT           NULL,
        Material         NVARCHAR(18)  NOT NULL,
        LengthMetres     DECIMAL(12,3) NOT NULL CONSTRAINT DF_Braiding_Metres    DEFAULT 0,
        Status           TINYINT       NOT NULL CONSTRAINT DF_Braiding_Status    DEFAULT 1,
        CreatedAt        DATETIME      NOT NULL CONSTRAINT DF_Braiding_CreatedAt DEFAULT GETDATE(),
        StartedAt        DATETIME      NULL,
        CompletedAt      DATETIME      NULL,
        CreatedByUserID  INT           NOT NULL,
        IsReversed       BIT           NOT NULL CONSTRAINT DF_Braiding_IsReversed DEFAULT 0,
        ReversedAt       DATETIME      NULL,
        ReversedByUserID INT           NULL,
        Notes            NVARCHAR(MAX) NULL,
        CONSTRAINT PK_Braiding        PRIMARY KEY (BraidingID),
        CONSTRAINT FK_Braiding_Shift  FOREIGN KEY (ShiftID)   REFERENCES prod.Shifts     (ShiftID),
        CONSTRAINT FK_Braiding_Mach   FOREIGN KEY (MachineID) REFERENCES prod.Machines   (MachineID),
        CONSTRAINT FK_Braiding_Status FOREIGN KEY (Status)    REFERENCES prod.StatusCodes(StatusID)
    )

    CREATE UNIQUE INDEX UQ_Braiding_BraidRef ON prod.Braiding (BraidRef)
    CREATE INDEX IX_Braiding_Status          ON prod.Braiding (Status)    INCLUDE (BraidRef, Material, CreatedAt)
    CREATE INDEX IX_Braiding_CreatedAt       ON prod.Braiding (CreatedAt) INCLUDE (BraidRef, Material, Status)
END


/* 2.5  Coverline  --  M  --  prefix CL ------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Coverline') AND type = 'U')
BEGIN
    CREATE TABLE prod.Coverline (
        CoverlineID      INT           NOT NULL IDENTITY(1,1),
        CovRef           AS (CAST(N'CL-' + RIGHT('00000000' + CAST(CoverlineID AS VARCHAR(8)), 8) AS NVARCHAR(12))) PERSISTED,
        ShiftID          TINYINT       NOT NULL,
        MachineID        INT           NULL,
        Material         NVARCHAR(18)  NOT NULL,
        LengthMetres     DECIMAL(12,3) NOT NULL CONSTRAINT DF_Coverline_Metres    DEFAULT 0,
        Status           TINYINT       NOT NULL CONSTRAINT DF_Coverline_Status    DEFAULT 1,
        CreatedAt        DATETIME      NOT NULL CONSTRAINT DF_Coverline_CreatedAt DEFAULT GETDATE(),
        StartedAt        DATETIME      NULL,
        CompletedAt      DATETIME      NULL,
        CreatedByUserID  INT           NOT NULL,
        IsReversed       BIT           NOT NULL CONSTRAINT DF_Coverline_IsReversed DEFAULT 0,
        ReversedAt       DATETIME      NULL,
        ReversedByUserID INT           NULL,
        Notes            NVARCHAR(MAX) NULL,
        CONSTRAINT PK_Coverline        PRIMARY KEY (CoverlineID),
        CONSTRAINT FK_Coverline_Shift  FOREIGN KEY (ShiftID)   REFERENCES prod.Shifts     (ShiftID),
        CONSTRAINT FK_Coverline_Mach   FOREIGN KEY (MachineID) REFERENCES prod.Machines   (MachineID),
        CONSTRAINT FK_Coverline_Status FOREIGN KEY (Status)    REFERENCES prod.StatusCodes(StatusID)
    )

    CREATE UNIQUE INDEX UQ_Coverline_CovRef ON prod.Coverline (CovRef)
    CREATE INDEX IX_Coverline_Status         ON prod.Coverline (Status)    INCLUDE (CovRef, Material, CreatedAt)
    CREATE INDEX IX_Coverline_CreatedAt      ON prod.Coverline (CreatedAt) INCLUDE (CovRef, Material, Status)
END


/* 2.6  TapeWrap  --  M  --  prefix TW -------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.TapeWrap') AND type = 'U')
BEGIN
    CREATE TABLE prod.TapeWrap (
        TapeWrapID       INT           NOT NULL IDENTITY(1,1),
        TWRef            AS (CAST(N'TW-' + RIGHT('00000000' + CAST(TapeWrapID AS VARCHAR(8)), 8) AS NVARCHAR(12))) PERSISTED,
        ShiftID          TINYINT       NOT NULL,
        MachineID        INT           NULL,
        Material         NVARCHAR(18)  NOT NULL,
        LengthMetres     DECIMAL(12,3) NOT NULL CONSTRAINT DF_TapeWrap_Metres    DEFAULT 0,
        Status           TINYINT       NOT NULL CONSTRAINT DF_TapeWrap_Status    DEFAULT 1,
        CreatedAt        DATETIME      NOT NULL CONSTRAINT DF_TapeWrap_CreatedAt DEFAULT GETDATE(),
        StartedAt        DATETIME      NULL,
        CompletedAt      DATETIME      NULL,
        CreatedByUserID  INT           NOT NULL,
        IsReversed       BIT           NOT NULL CONSTRAINT DF_TapeWrap_IsReversed DEFAULT 0,
        ReversedAt       DATETIME      NULL,
        ReversedByUserID INT           NULL,
        Notes            NVARCHAR(MAX) NULL,
        CONSTRAINT PK_TapeWrap        PRIMARY KEY (TapeWrapID),
        CONSTRAINT FK_TapeWrap_Shift  FOREIGN KEY (ShiftID)   REFERENCES prod.Shifts     (ShiftID),
        CONSTRAINT FK_TapeWrap_Mach   FOREIGN KEY (MachineID) REFERENCES prod.Machines   (MachineID),
        CONSTRAINT FK_TapeWrap_Status FOREIGN KEY (Status)    REFERENCES prod.StatusCodes(StatusID)
    )

    CREATE UNIQUE INDEX UQ_TapeWrap_TWRef ON prod.TapeWrap (TWRef)
    CREATE INDEX IX_TapeWrap_Status       ON prod.TapeWrap (Status)    INCLUDE (TWRef, Material, CreatedAt)
    CREATE INDEX IX_TapeWrap_CreatedAt    ON prod.TapeWrap (CreatedAt) INCLUDE (TWRef, Material, Status)
END


/* 2.7  Drumming  --  M  --  prefix DR -------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Drumming') AND type = 'U')
BEGIN
    CREATE TABLE prod.Drumming (
        DrummingID       INT           NOT NULL IDENTITY(1,1),
        DrumRef          AS (CAST(N'DR-' + RIGHT('00000000' + CAST(DrummingID AS VARCHAR(8)), 8) AS NVARCHAR(12))) PERSISTED,
        ShiftID          TINYINT       NOT NULL,
        MachineID        INT           NULL,
        Material         NVARCHAR(18)  NOT NULL,
        LengthMetres     DECIMAL(12,3) NOT NULL CONSTRAINT DF_Drumming_Metres      DEFAULT 0,
        ProductBarcode   NVARCHAR(50)  NOT NULL,
        SalesOrderSAP    NVARCHAR(12)  NOT NULL,
        TestPressureBar  DECIMAL(6,2)  NULL,
        Status           TINYINT       NOT NULL CONSTRAINT DF_Drumming_Status      DEFAULT 1,
        CreatedAt        DATETIME      NOT NULL CONSTRAINT DF_Drumming_CreatedAt   DEFAULT GETDATE(),
        StartedAt        DATETIME      NULL,
        CompletedAt      DATETIME      NULL,
        CreatedByUserID  INT           NOT NULL,
        IsReversed       BIT           NOT NULL CONSTRAINT DF_Drumming_IsReversed  DEFAULT 0,
        ReversedAt       DATETIME      NULL,
        ReversedByUserID INT           NULL,
        Notes            NVARCHAR(MAX) NULL,
        CONSTRAINT PK_Drumming        PRIMARY KEY (DrummingID),
        CONSTRAINT FK_Drumming_Shift  FOREIGN KEY (ShiftID)   REFERENCES prod.Shifts     (ShiftID),
        CONSTRAINT FK_Drumming_Mach   FOREIGN KEY (MachineID) REFERENCES prod.Machines   (MachineID),
        CONSTRAINT FK_Drumming_Status FOREIGN KEY (Status)    REFERENCES prod.StatusCodes(StatusID)
    )

    CREATE UNIQUE INDEX UQ_Drumming_DrumRef  ON prod.Drumming (DrumRef)
    CREATE INDEX IX_Drumming_SalesOrder      ON prod.Drumming (SalesOrderSAP)  INCLUDE (DrumRef, Material, Status)
    CREATE INDEX IX_Drumming_Barcode         ON prod.Drumming (ProductBarcode)
    CREATE INDEX IX_Drumming_Status          ON prod.Drumming (Status)         INCLUDE (DrumRef, Material, CreatedAt)
    CREATE INDEX IX_Drumming_CreatedAt       ON prod.Drumming (CreatedAt)      INCLUDE (DrumRef, Material, Status)
END


/* 2.8  Ewald  --  EA  --  prefix EW ---------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Ewald') AND type = 'U')
BEGIN
    CREATE TABLE prod.Ewald (
        EwaldID          INT           NOT NULL IDENTITY(1,1),
        EwaldRef         AS (CAST(N'EW-' + RIGHT('00000000' + CAST(EwaldID AS VARCHAR(8)), 8) AS NVARCHAR(12))) PERSISTED,
        ShiftID          TINYINT       NOT NULL,
        MachineID        INT           NULL,
        Material         NVARCHAR(18)  NOT NULL,
        TotalPiecesEA    INT           NOT NULL CONSTRAINT DF_Ewald_Pieces         DEFAULT 0,
        TotalBoxes       INT           NOT NULL CONSTRAINT DF_Ewald_Boxes          DEFAULT 0,
        FirewallRequired BIT           NOT NULL CONSTRAINT DF_Ewald_FWRequired     DEFAULT 1,
        Status           TINYINT       NOT NULL CONSTRAINT DF_Ewald_Status         DEFAULT 1,
        CreatedAt        DATETIME      NOT NULL CONSTRAINT DF_Ewald_CreatedAt      DEFAULT GETDATE(),
        StartedAt        DATETIME      NULL,
        CompletedAt      DATETIME      NULL,
        CreatedByUserID  INT           NOT NULL,
        IsReversed       BIT           NOT NULL CONSTRAINT DF_Ewald_IsReversed     DEFAULT 0,
        ReversedAt       DATETIME      NULL,
        ReversedByUserID INT           NULL,
        Notes            NVARCHAR(MAX) NULL,
        CONSTRAINT PK_Ewald        PRIMARY KEY (EwaldID),
        CONSTRAINT FK_Ewald_Shift  FOREIGN KEY (ShiftID)   REFERENCES prod.Shifts     (ShiftID),
        CONSTRAINT FK_Ewald_Mach   FOREIGN KEY (MachineID) REFERENCES prod.Machines   (MachineID),
        CONSTRAINT FK_Ewald_Status FOREIGN KEY (Status)    REFERENCES prod.StatusCodes(StatusID)
    )

    CREATE UNIQUE INDEX UQ_Ewald_EwaldRef ON prod.Ewald (EwaldRef)
    CREATE INDEX IX_Ewald_Status          ON prod.Ewald (Status)    INCLUDE (EwaldRef, Material, CreatedAt)
    CREATE INDEX IX_Ewald_CreatedAt       ON prod.Ewald (CreatedAt) INCLUDE (EwaldRef, Material, Status)
END


/* 2.9  EwaldBoxes  --  child of Ewald --------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.EwaldBoxes') AND type = 'U')
BEGIN
    CREATE TABLE prod.EwaldBoxes (
        EwaldBoxID          INT          NOT NULL IDENTITY(1,1),
        EwaldID             INT          NOT NULL,
        PiecesEA            INT          NOT NULL,
        CustomerCode        NVARCHAR(10) NULL,
        SAPBatchNumber      NVARCHAR(10) NULL,
        BackflushedAt       DATETIME     NULL,
        BackflushedByUserID INT          NULL,
        IsReversed          BIT          NOT NULL CONSTRAINT DF_EwaldBoxes_IsReversed DEFAULT 0,
        ReversedAt          DATETIME     NULL,
        ReversedByUserID    INT          NULL,
        ReversalDocumentSAP NVARCHAR(10) NULL,
        CONSTRAINT PK_EwaldBoxes         PRIMARY KEY (EwaldBoxID),
        CONSTRAINT FK_EwaldBoxes_Ewald   FOREIGN KEY (EwaldID) REFERENCES prod.Ewald (EwaldID),
        CONSTRAINT CK_EwaldBoxes_Pieces  CHECK (PiecesEA > 0)
    )

    CREATE INDEX IX_EwaldBoxes_EwaldID ON prod.EwaldBoxes (EwaldID) INCLUDE (PiecesEA, IsReversed)
END


/* 2.10  Firewall  --  EA  --  prefix FW  (one-to-one Ewald) */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.Firewall') AND type = 'U')
BEGIN
    CREATE TABLE prod.Firewall (
        FirewallID        INT           NOT NULL IDENTITY(1,1),
        FWRef             AS (CAST(N'FW-' + RIGHT('00000000' + CAST(FirewallID AS VARCHAR(8)), 8) AS NVARCHAR(12))) PERSISTED,
        EwaldID           INT           NOT NULL,
        InspectedByUserID INT           NOT NULL,
        InspectedAt       DATETIME      NOT NULL CONSTRAINT DF_Firewall_InspectedAt   DEFAULT GETDATE(),
        TotalInspectedEA  INT           NOT NULL CONSTRAINT DF_Firewall_TotalInspected DEFAULT 0,
        PassedEA          INT           NOT NULL CONSTRAINT DF_Firewall_PassedEA       DEFAULT 0,
        FailedEA          INT           NOT NULL CONSTRAINT DF_Firewall_FailedEA       DEFAULT 0,
        Status            TINYINT       NOT NULL CONSTRAINT DF_Firewall_Status         DEFAULT 1,
        IsReversed        BIT           NOT NULL CONSTRAINT DF_Firewall_IsReversed     DEFAULT 0,
        ReversedAt        DATETIME      NULL,
        ReversedByUserID  INT           NULL,
        Notes             NVARCHAR(MAX) NULL,
        CONSTRAINT PK_Firewall         PRIMARY KEY (FirewallID),
        CONSTRAINT UQ_Firewall_EwaldID UNIQUE      (EwaldID),
        CONSTRAINT FK_Firewall_Ewald   FOREIGN KEY (EwaldID) REFERENCES prod.Ewald      (EwaldID),
        CONSTRAINT FK_Firewall_Status  FOREIGN KEY (Status)  REFERENCES prod.StatusCodes(StatusID),
        CONSTRAINT CK_Firewall_Qty     CHECK (PassedEA + FailedEA <= TotalInspectedEA)
    )

    CREATE UNIQUE INDEX UQ_Firewall_FWRef ON prod.Firewall (FWRef)
END


/* 2.11  HoseAssembly  --  EA  --  prefix HA --------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.HoseAssembly') AND type = 'U')
BEGIN
    CREATE TABLE prod.HoseAssembly (
        HoseAssemblyID   INT           NOT NULL IDENTITY(1,1),
        HARef            AS (CAST(N'HA-' + RIGHT('00000000' + CAST(HoseAssemblyID AS VARCHAR(8)), 8) AS NVARCHAR(12))) PERSISTED,
        ShiftID          TINYINT       NOT NULL,
        MachineID        INT           NULL,
        Material         NVARCHAR(18)  NOT NULL,
        QuantityEA       INT           NOT NULL CONSTRAINT DF_HA_Qty         DEFAULT 0,
        SalesOrderSAP    NVARCHAR(12)  NULL,
        RequiresQA       BIT           NOT NULL CONSTRAINT DF_HA_RequiresQA  DEFAULT 0,
        Status           TINYINT       NOT NULL CONSTRAINT DF_HA_Status      DEFAULT 1,
        CreatedAt        DATETIME      NOT NULL CONSTRAINT DF_HA_CreatedAt   DEFAULT GETDATE(),
        StartedAt        DATETIME      NULL,
        CompletedAt      DATETIME      NULL,
        CreatedByUserID  INT           NOT NULL,
        IsReversed       BIT           NOT NULL CONSTRAINT DF_HA_IsReversed  DEFAULT 0,
        ReversedAt       DATETIME      NULL,
        ReversedByUserID INT           NULL,
        Notes            NVARCHAR(MAX) NULL,
        CONSTRAINT PK_HoseAssembly        PRIMARY KEY (HoseAssemblyID),
        CONSTRAINT FK_HA_Shift            FOREIGN KEY (ShiftID)   REFERENCES prod.Shifts     (ShiftID),
        CONSTRAINT FK_HA_Mach             FOREIGN KEY (MachineID) REFERENCES prod.Machines   (MachineID),
        CONSTRAINT FK_HA_Status           FOREIGN KEY (Status)    REFERENCES prod.StatusCodes(StatusID)
    )

    CREATE UNIQUE INDEX UQ_HA_HARef    ON prod.HoseAssembly (HARef)
    CREATE INDEX IX_HA_Status          ON prod.HoseAssembly (Status)    INCLUDE (HARef, Material, CreatedAt)
    CREATE INDEX IX_HA_CreatedAt       ON prod.HoseAssembly (CreatedAt) INCLUDE (HARef, Material, Status)
END


/* ============================================================
   SECTION 3 -- JUNCTION / CHILD TABLES
   ============================================================ */

/* 3.1  BatchOperators ------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.BatchOperators') AND type = 'U')
BEGIN
    CREATE TABLE prod.BatchOperators (
        BatchOperatorID  INT          NOT NULL IDENTITY(1,1),
        ProcessCode      NVARCHAR(5)  NOT NULL,
        ProcessRecordID  INT          NOT NULL,
        UserID           INT          NOT NULL,
        IsPrimary        BIT          NOT NULL CONSTRAINT DF_BatchOp_IsPrimary  DEFAULT 0,
        AssignedAt       DATETIME     NOT NULL CONSTRAINT DF_BatchOp_AssignedAt DEFAULT GETDATE(),
        AssignedByUserID INT          NOT NULL,
        RemovedAt        DATETIME     NULL,
        CONSTRAINT PK_BatchOperators         PRIMARY KEY (BatchOperatorID),
        CONSTRAINT CK_BatchOp_ProcessCode    CHECK (ProcessCode IN (N'MX',N'EXT',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA'))
    )

    CREATE INDEX IX_BatchOp_Process ON prod.BatchOperators (ProcessCode, ProcessRecordID) INCLUDE (UserID, IsPrimary, RemovedAt)
    CREATE INDEX IX_BatchOp_User    ON prod.BatchOperators (UserID) INCLUDE (ProcessCode, ProcessRecordID, IsPrimary)
END


/* 3.2  ProductionTrace ------------------------------------ */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.ProductionTrace') AND type = 'U')
BEGIN
    CREATE TABLE prod.ProductionTrace (
        TraceID           INT         NOT NULL IDENTITY(1,1),
        ChildProcessCode  NVARCHAR(5) NOT NULL,
        ChildRecordID     INT         NOT NULL,
        ParentProcessCode NVARCHAR(5) NOT NULL,
        ParentRecordID    INT         NOT NULL,
        LinkedAt          DATETIME    NOT NULL CONSTRAINT DF_Trace_LinkedAt DEFAULT GETDATE(),
        LinkedByUserID    INT         NOT NULL,
        CONSTRAINT PK_ProductionTrace    PRIMARY KEY (TraceID),
        CONSTRAINT UQ_ProductionTrace    UNIQUE (ChildProcessCode, ChildRecordID, ParentProcessCode, ParentRecordID),
        CONSTRAINT CK_Trace_ChildCode    CHECK (ChildProcessCode  IN (N'MX',N'EXT',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA')),
        CONSTRAINT CK_Trace_ParentCode   CHECK (ParentProcessCode IN (N'MX',N'EXT',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA')),
        CONSTRAINT CK_Trace_NoSelfLink   CHECK (NOT (ChildProcessCode = ParentProcessCode AND ChildRecordID = ParentRecordID))
    )

    CREATE INDEX IX_Trace_Child  ON prod.ProductionTrace (ChildProcessCode,  ChildRecordID)  INCLUDE (ParentProcessCode, ParentRecordID)
    CREATE INDEX IX_Trace_Parent ON prod.ProductionTrace (ParentProcessCode, ParentRecordID) INCLUDE (ChildProcessCode,  ChildRecordID)
END


/* 3.3  ScrapEntries --------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.ScrapEntries') AND type = 'U')
BEGIN
    CREATE TABLE prod.ScrapEntries (
        ScrapID         INT           NOT NULL IDENTITY(1,1),
        ProcessCode     NVARCHAR(5)   NOT NULL,
        ProcessRecordID INT           NOT NULL,
        ReasonID        INT           NOT NULL,
        Quantity        DECIMAL(12,3) NOT NULL,
        UnitOfMeasure   NVARCHAR(5)   NOT NULL,
        EnteredAt       DATETIME      NOT NULL CONSTRAINT DF_Scrap_EnteredAt DEFAULT GETDATE(),
        EnteredByUserID INT           NOT NULL,
        Notes           NVARCHAR(MAX) NULL,
        CONSTRAINT PK_ScrapEntries          PRIMARY KEY (ScrapID),
        CONSTRAINT FK_Scrap_Reason          FOREIGN KEY (ReasonID) REFERENCES prod.ScrapReasons(ReasonID),
        CONSTRAINT CK_Scrap_ProcessCode     CHECK (ProcessCode IN (N'MX',N'EXT',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA')),
        CONSTRAINT CK_Scrap_UOM             CHECK (UnitOfMeasure IN (N'KG',N'M',N'EA')),
        CONSTRAINT CK_Scrap_Qty             CHECK (Quantity > 0)
    )

    CREATE INDEX IX_Scrap_Process   ON prod.ScrapEntries (ProcessCode, ProcessRecordID) INCLUDE (Quantity, UnitOfMeasure, EnteredAt)
    CREATE INDEX IX_Scrap_EnteredAt ON prod.ScrapEntries (EnteredAt) INCLUDE (ProcessCode, ProcessRecordID, Quantity)
END


/* 3.4  SAPPostings ---------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.SAPPostings') AND type = 'U')
BEGIN
    CREATE TABLE prod.SAPPostings (
        SAPPostingID        INT           NOT NULL IDENTITY(1,1),
        ProcessCode         NVARCHAR(5)   NOT NULL,
        ProcessRecordID     INT           NOT NULL,
        PostingType         NVARCHAR(20)  NOT NULL,
        SalesOrderSAP       NVARCHAR(12)  NULL,
        ProductionOrderSAP  NVARCHAR(12)  NULL,
        MaterialDocumentSAP NVARCHAR(10)  NULL,
        SAPBatchNumber      NVARCHAR(10)  NULL,
        Quantity            DECIMAL(12,3) NOT NULL,
        UnitOfMeasure       NVARCHAR(5)   NOT NULL,
        PostedAt            DATETIME      NOT NULL CONSTRAINT DF_SAPPost_PostedAt   DEFAULT GETDATE(),
        PostedByUserID      INT           NOT NULL,
        IsSuccess           BIT           NOT NULL CONSTRAINT DF_SAPPost_IsSuccess  DEFAULT 0,
        ErrorMessage        NVARCHAR(MAX) NULL,
        IsReversed          BIT           NOT NULL CONSTRAINT DF_SAPPost_IsReversed DEFAULT 0,
        ReversalDocumentSAP NVARCHAR(10)  NULL,
        ReversedAt          DATETIME      NULL,
        ReversedByUserID    INT           NULL,
        CONSTRAINT PK_SAPPostings            PRIMARY KEY (SAPPostingID),
        CONSTRAINT CK_SAPPost_ProcessCode    CHECK (ProcessCode  IN (N'MX',N'EXT',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA')),
        CONSTRAINT CK_SAPPost_PostingType    CHECK (PostingType  IN (N'BACKFLUSH',N'GOODS_ISSUE',N'SCRAP',N'REVERSAL')),
        CONSTRAINT CK_SAPPost_UOM           CHECK (UnitOfMeasure IN (N'KG',N'M',N'EA'))
    )

    -- MaterialDocumentSAP indexed for reversal lookup (operator enters SAP doc number)
    CREATE INDEX IX_SAPPost_MatDoc   ON prod.SAPPostings (MaterialDocumentSAP) INCLUDE (ProcessCode, ProcessRecordID, PostingType, IsReversed)
    CREATE INDEX IX_SAPPost_Process  ON prod.SAPPostings (ProcessCode, ProcessRecordID) INCLUDE (PostingType, IsSuccess, IsReversed, PostedAt)
    CREATE INDEX IX_SAPPost_PostedAt ON prod.SAPPostings (PostedAt) INCLUDE (ProcessCode, ProcessRecordID, IsSuccess, IsReversed)
END


/* 3.5  EventLog ------------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.EventLog') AND type = 'U')
BEGIN
    CREATE TABLE prod.EventLog (
        EventID         INT           NOT NULL IDENTITY(1,1),
        ProcessCode     NVARCHAR(5)   NOT NULL,
        ProcessRecordID INT           NOT NULL,
        EventType       NVARCHAR(20)  NOT NULL,
        EventMessage    NVARCHAR(MAX) NOT NULL,
        Severity        TINYINT       NOT NULL CONSTRAINT DF_EventLog_Severity  DEFAULT 0,
        CreatedAt       DATETIME      NOT NULL CONSTRAINT DF_EventLog_CreatedAt DEFAULT GETDATE(),
        CreatedByUserID INT           NOT NULL,
        CONSTRAINT PK_EventLog              PRIMARY KEY (EventID),
        CONSTRAINT CK_EventLog_ProcessCode  CHECK (ProcessCode IN (N'MX',N'EXT',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA')),
        CONSTRAINT CK_EventLog_EventType    CHECK (EventType IN (
            N'STARTED',N'COMPLETED',N'ON_HOLD',N'CANCELLED',
            N'OPERATOR_ADD',N'OPERATOR_REMOVE',
            N'SCRAP',N'SAP_POST',N'SAP_FAIL',N'REVERSAL',
            N'FIREWALL',N'NOTE'
        )),
        CONSTRAINT CK_EventLog_Severity     CHECK (Severity IN (0,1,2))
    )

    CREATE INDEX IX_EventLog_Process   ON prod.EventLog (ProcessCode, ProcessRecordID, CreatedAt) INCLUDE (EventType, Severity)
    CREATE INDEX IX_EventLog_CreatedAt ON prod.EventLog (CreatedAt) INCLUDE (ProcessCode, ProcessRecordID, EventType, Severity)
END


/* ============================================================
   SECTION 4 -- TRIGGER
   Wrapped in EXEC because CREATE TRIGGER must be the only
   statement in a batch.
   ============================================================ */
IF NOT EXISTS (
    SELECT 1 FROM sys.triggers
    WHERE name = N'trg_EwaldBoxes_SyncTotals'
      AND parent_id = OBJECT_ID(N'prod.EwaldBoxes')
)
BEGIN
    DECLARE @trg NVARCHAR(MAX)
    SET @trg = N'
CREATE TRIGGER prod.trg_EwaldBoxes_SyncTotals
ON prod.EwaldBoxes
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON
    UPDATE e
    SET
        e.TotalPiecesEA = ISNULL((
            SELECT SUM(eb.PiecesEA)
            FROM   prod.EwaldBoxes eb
            WHERE  eb.EwaldID    = e.EwaldID
              AND  eb.IsReversed = 0
        ), 0),
        e.TotalBoxes = ISNULL((
            SELECT COUNT(*)
            FROM   prod.EwaldBoxes eb
            WHERE  eb.EwaldID    = e.EwaldID
              AND  eb.IsReversed = 0
        ), 0)
    FROM prod.Ewald e
    INNER JOIN (SELECT DISTINCT EwaldID FROM inserted) i
        ON i.EwaldID = e.EwaldID
END'
    EXEC(@trg)
END


/* ============================================================
   SECTION 5 -- VIEW
   Wrapped in EXEC because CREATE VIEW must be the only
   statement in a batch.
   ============================================================ */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.vw_ActiveBatches') AND type = 'V')
BEGIN
    DECLARE @vw NVARCHAR(MAX)
    SET @vw = N'
CREATE VIEW prod.vw_ActiveBatches AS
    SELECT N''MX''  AS ProcessCode, MixingID        AS RecordID, MixRef     AS BatchRef, Material, CAST(TotalWeightKG         AS DECIMAL(12,3)) AS Quantity, N''KG'' AS UOM, Status, ShiftID, NULL AS MachineID, CreatedAt, StartedAt FROM prod.Mixing       WHERE Status IN (1,2) AND IsReversed = 0
    UNION ALL
    SELECT N''EXT'', ExtrusionID,    ExtRef,   Material, LengthMetres,                         N''M'',  Status, ShiftID, MachineID, CreatedAt, StartedAt FROM prod.Extrusion    WHERE Status IN (1,2) AND IsReversed = 0
    UNION ALL
    SELECT N''CO'',  ConvolutingID,  ConvRef,  Material, LengthMetres,                         N''M'',  Status, ShiftID, MachineID, CreatedAt, StartedAt FROM prod.Convoluting  WHERE Status IN (1,2) AND IsReversed = 0
    UNION ALL
    SELECT N''BR'',  BraidingID,     BraidRef, Material, LengthMetres,                         N''M'',  Status, ShiftID, MachineID, CreatedAt, StartedAt FROM prod.Braiding     WHERE Status IN (1,2) AND IsReversed = 0
    UNION ALL
    SELECT N''CL'',  CoverlineID,    CovRef,   Material, LengthMetres,                         N''M'',  Status, ShiftID, MachineID, CreatedAt, StartedAt FROM prod.Coverline    WHERE Status IN (1,2) AND IsReversed = 0
    UNION ALL
    SELECT N''TW'',  TapeWrapID,     TWRef,    Material, LengthMetres,                         N''M'',  Status, ShiftID, MachineID, CreatedAt, StartedAt FROM prod.TapeWrap     WHERE Status IN (1,2) AND IsReversed = 0
    UNION ALL
    SELECT N''DR'',  DrummingID,     DrumRef,  Material, LengthMetres,                         N''M'',  Status, ShiftID, MachineID, CreatedAt, StartedAt FROM prod.Drumming     WHERE Status IN (1,2) AND IsReversed = 0
    UNION ALL
    SELECT N''EW'',  EwaldID,        EwaldRef, Material, CAST(TotalPiecesEA AS DECIMAL(12,3)), N''EA'', Status, ShiftID, MachineID, CreatedAt, StartedAt FROM prod.Ewald        WHERE Status IN (1,2) AND IsReversed = 0
    UNION ALL
    SELECT N''HA'',  HoseAssemblyID, HARef,    Material, CAST(QuantityEA    AS DECIMAL(12,3)), N''EA'', Status, ShiftID, MachineID, CreatedAt, StartedAt FROM prod.HoseAssembly WHERE Status IN (1,2) AND IsReversed = 0'
    EXEC(@vw)
END
