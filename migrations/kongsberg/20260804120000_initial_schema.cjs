'use strict';
// Initial schema migration for Kongsberg (portal/consignment/finance/etc.) — generated from a live extraction
// of the current production database (sql/generate_schema_script.sql, run
// via the admin.html SQL Console) on 2026-08-04. Reproduces every base
// table, DEFAULT/UNIQUE/CHECK constraint, non-PK index, and foreign key —
// see migrations/README.md for what's deliberately excluded and why.
//
// Schema only — no data. Reference/lookup data seeding is a separate,
// later migration once that's been decided per table.

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.AgreementSnapshot') AND type = 'U')\r\nCREATE TABLE dbo.AgreementSnapshot (\r\n    AgreementLineId INT IDENTITY(1,1) NOT NULL\r\n,    ProfitCentre VARCHAR(10) NULL\r\n,    Plant VARCHAR(4) NULL\r\n,    Mid VARCHAR(48) NULL\r\n,    MrpController VARCHAR(3) NULL\r\n,    Material VARCHAR(18) NOT NULL\r\n,    MaterialText VARCHAR(40) NULL\r\n,    ValueStream VARCHAR(8) NULL\r\n,    OnHandQty DECIMAL(15,3) NULL\r\n,    Uom VARCHAR(3) NULL\r\n,    StandardPrice DECIMAL(15,2) NULL\r\n,    LocalCurrency VARCHAR(5) NULL\r\n,    Customer VARCHAR(10) NULL\r\n,    CustomerGroup VARCHAR(10) NULL\r\n,    CustomerName VARCHAR(35) NULL\r\n,    OrderType VARCHAR(4) NULL\r\n,    ReferenceDocument VARCHAR(10) NULL\r\n,    Item VARCHAR(6) NULL\r\n,    CustomerPo VARCHAR(20) NULL\r\n,    CustomerMaterial VARCHAR(35) NULL\r\n,    CustomerReference VARCHAR(30) NULL\r\n,    UnloadingPoint VARCHAR(25) NULL\r\n,    RequestDate DATETIME NOT NULL\r\n,    Week VARCHAR(6) NULL\r\n,    Period VARCHAR(7) NULL\r\n,    OrderQty DECIMAL(15,3) NOT NULL\r\n,    Amount DECIMAL(15,2) NULL\r\n,    Currency VARCHAR(5) NULL\r\n,    DockStockAllocated DECIMAL(15,3) NULL\r\n,    PickedStockAllocated DECIMAL(15,3) NULL\r\n,    OriginalDoc NVARCHAR(10) NULL\r\n,    OriginalDocItem NVARCHAR(6) NULL\r\n,\r\n    CONSTRAINT PK__AgreementSnapsho__02C769E9 PRIMARY KEY (AgreementLineId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ConsignmentCustomer') AND type = 'U')\r\nCREATE TABLE dbo.ConsignmentCustomer (\r\n    Customer NVARCHAR(10) NOT NULL\r\n,    CustomerName NVARCHAR(35) NULL\r\n,    LastUpdatedUtc DATETIME NOT NULL\r\n,    UpdatedByUsername NVARCHAR(80) NULL\r\n,\r\n    CONSTRAINT PK_ConsignmentCustomer PRIMARY KEY (Customer)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ConsignmentDeclaration') AND type = 'U')\r\nCREATE TABLE dbo.ConsignmentDeclaration (\r\n    DeclarationId INT IDENTITY(1,1) NOT NULL\r\n,    VendorId INT NOT NULL\r\n,    Status NVARCHAR(20) NOT NULL\r\n,    AllocationMethod NVARCHAR(10) NOT NULL\r\n,    TotalQty DECIMAL(15,3) NOT NULL\r\n,    CreatedAtUtc DATETIME NOT NULL\r\n,    CreatedByUsername NVARCHAR(80) NULL\r\n,    ConfirmedAtUtc DATETIME NULL\r\n,    ConfirmedByUsername NVARCHAR(80) NULL\r\n,    SettlementDocumentNumber NVARCHAR(10) NULL\r\n,    SettlementReconciledQty DECIMAL(15,3) NULL\r\n,    Notes NVARCHAR(500) NULL\r\n,\r\n    CONSTRAINT PK_ConsignmentDeclaration PRIMARY KEY (DeclarationId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ConsignmentDeclarationLine') AND type = 'U')\r\nCREATE TABLE dbo.ConsignmentDeclarationLine (\r\n    DeclarationLineId INT IDENTITY(1,1) NOT NULL\r\n,    DeclarationId INT NOT NULL\r\n,    DeliveryId INT NOT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    QtyAllocated DECIMAL(15,3) NOT NULL\r\n,    CreatedAtUtc DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_ConsignmentDeclarationLine PRIMARY KEY (DeclarationLineId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ConsignmentDelivery') AND type = 'U')\r\nCREATE TABLE dbo.ConsignmentDelivery (\r\n    DeliveryId INT IDENTITY(1,1) NOT NULL\r\n,    VendorId INT NOT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    MaterialDocument NVARCHAR(10) NOT NULL\r\n,    MaterialDocItem NVARCHAR(4) NOT NULL\r\n,    Quantity DECIMAL(15,3) NOT NULL\r\n,    Uom NVARCHAR(3) NULL\r\n,    Container NVARCHAR(20) NULL\r\n,    BillOfLading NVARCHAR(30) NULL\r\n,    InvoiceNumber NVARCHAR(30) NULL\r\n,    DocumentDate DATETIME NULL\r\n,    PostingDate DATETIME NULL\r\n,    ExpiryDate DATETIME NULL\r\n,    RemainingQty DECIMAL(15,3) NOT NULL\r\n,    Source NVARCHAR(10) NOT NULL\r\n,    CreatedAtUtc DATETIME NOT NULL\r\n,    CreatedByUsername NVARCHAR(80) NULL\r\n,\r\n    CONSTRAINT PK_ConsignmentDelivery PRIMARY KEY (DeliveryId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ConsignmentStockSnapshot') AND type = 'U')\r\nCREATE TABLE dbo.ConsignmentStockSnapshot (\r\n    Material NVARCHAR(18) NOT NULL\r\n,    Qty DECIMAL(15,3) NOT NULL\r\n,    SnapshotAtUtc DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_ConsignmentStockSnapshot PRIMARY KEY (Material)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ConsignmentVendorConfig') AND type = 'U')\r\nCREATE TABLE dbo.ConsignmentVendorConfig (\r\n    VendorId INT NOT NULL\r\n,    TrackExpiry BIT NOT NULL\r\n,    ExpiryWarningDays INT NULL\r\n,    DefaultAllocationMethod NVARCHAR(10) NOT NULL\r\n,    Active BIT NOT NULL\r\n,    Notes NVARCHAR(500) NULL\r\n,    UpdatedAtUtc DATETIME NOT NULL\r\n,    UpdatedByUsername NVARCHAR(80) NULL\r\n,    ExpiryDays INT NULL\r\n,\r\n    CONSTRAINT PK_ConsignmentVendorConfig PRIMARY KEY (VendorId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.CustomerStandardInstructions') AND type = 'U')\r\nCREATE TABLE dbo.CustomerStandardInstructions (\r\n    Customer NVARCHAR(10) NOT NULL\r\n,    CustomerName NVARCHAR(35) NULL\r\n,    Instructions NVARCHAR(1000) NOT NULL\r\n,    LastUpdatedUtc DATETIME NOT NULL\r\n,    UpdatedByUsername NVARCHAR(80) NULL\r\n,\r\n    CONSTRAINT PK_CustomerStandardInstructions PRIMARY KEY (Customer)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.DailyPerformance') AND type = 'U')\r\nCREATE TABLE dbo.DailyPerformance (\r\n    MetricDate DATETIME NOT NULL\r\n,    ValueStream VARCHAR(8) NOT NULL\r\n,    InvoicedValue DECIMAL(18,2) NULL\r\n,    StockValue DECIMAL(18,2) NULL\r\n,    PickedValue DECIMAL(18,2) NULL\r\n,    OtifOnTimeCount INT NULL\r\n,    OtifTotalCount INT NULL\r\n,\r\n    CONSTRAINT PK__DailyPerformance__0880433F PRIMARY KEY (MetricDate, ValueStream)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.DeliveryOrderLink') AND type = 'U')\r\nCREATE TABLE dbo.DeliveryOrderLink (\r\n    DeliveryNumber NVARCHAR(10) NOT NULL\r\n,    DeliveryItem NVARCHAR(6) NOT NULL\r\n,    OrderNumber NVARCHAR(10) NOT NULL\r\n,    OrderItem NVARCHAR(6) NOT NULL\r\n,    ResolvedAtUtc DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_DeliveryOrderLink PRIMARY KEY (DeliveryNumber, DeliveryItem)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.DemandAdjustment') AND type = 'U')\r\nCREATE TABLE dbo.DemandAdjustment (\r\n    AdjustmentId INT IDENTITY(1,1) NOT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    StartDate DATETIME NULL\r\n,    EndDate DATETIME NULL\r\n,    UsagePercent DECIMAL(9,2) NOT NULL\r\n,    Reason NVARCHAR(500) NULL\r\n,    CreatedBy NVARCHAR(100) NULL\r\n,    CreatedAtUtc DATETIME NOT NULL\r\n,    UpdatedAtUtc DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_DemandAdjustment PRIMARY KEY (AdjustmentId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.FinanceGlGroupAccounts') AND type = 'U')\r\nCREATE TABLE dbo.FinanceGlGroupAccounts (\r\n    AccountID INT IDENTITY(1,1) NOT NULL\r\n,    GroupID INT NOT NULL\r\n,    GlAccount NVARCHAR(20) NOT NULL\r\n,    SortOrder INT NOT NULL\r\n,\r\n    CONSTRAINT PK__FinanceGlGroupAc__70A8B9AE PRIMARY KEY (AccountID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.FinanceGlGroups') AND type = 'U')\r\nCREATE TABLE dbo.FinanceGlGroups (\r\n    GroupID INT IDENTITY(1,1) NOT NULL\r\n,    GroupLabel NVARCHAR(100) NOT NULL\r\n,    SortOrder INT NOT NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK__FinanceGlGroups__6CD828CA PRIMARY KEY (GroupID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ForecastAccuracyLog') AND type = 'U')\r\nCREATE TABLE dbo.ForecastAccuracyLog (\r\n    Material NVARCHAR(18) NOT NULL\r\n,    Plant NVARCHAR(4) NOT NULL\r\n,    TargetMonth DATETIME NOT NULL\r\n,    SapDemandQty DECIMAL(15,3) NULL\r\n,    PredictedQty DECIMAL(15,3) NULL\r\n,    ActualQty DECIMAL(15,3) NULL\r\n,    LastUpdatedUtc DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_ForecastAccuracyLog PRIMARY KEY (Material, Plant, TargetMonth)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ForwarderModeMapping') AND type = 'U')\r\nCREATE TABLE dbo.ForwarderModeMapping (\r\n    MappingId INT IDENTITY(1,1) NOT NULL\r\n,    ForwarderMode NVARCHAR(20) NOT NULL\r\n,    ModeOfTransport NVARCHAR(20) NOT NULL\r\n,    Description NVARCHAR(200) NULL\r\n,    CreatedBy NVARCHAR(100) NULL\r\n,    CreatedAtUtc DATETIME NOT NULL\r\n,    UpdatedAtUtc DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_ForwarderModeMapping PRIMARY KEY (MappingId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.InvoiceSnapshot') AND type = 'U')\r\nCREATE TABLE dbo.InvoiceSnapshot (\r\n    InvoiceLineId INT IDENTITY(1,1) NOT NULL\r\n,    Plant VARCHAR(4) NULL\r\n,    SalesOrg VARCHAR(4) NULL\r\n,    InvoiceDate DATETIME NOT NULL\r\n,    InvoiceType VARCHAR(4) NULL\r\n,    InvoiceNumber VARCHAR(10) NULL\r\n,    DeliveryNote VARCHAR(10) NULL\r\n,    SalesAgreement VARCHAR(10) NULL\r\n,    SalesItem VARCHAR(6) NULL\r\n,    CustomerPo VARCHAR(35) NULL\r\n,    CustomerGroup VARCHAR(10) NULL\r\n,    Customer VARCHAR(10) NULL\r\n,    Material VARCHAR(18) NULL\r\n,    MaterialText VARCHAR(40) NULL\r\n,    Quantity DECIMAL(15,3) NULL\r\n,    DocumentAmount DECIMAL(15,2) NULL\r\n,    LocalAmount DECIMAL(15,2) NULL\r\n,    Currency VARCHAR(5) NULL\r\n,    ProfitCentre VARCHAR(10) NULL\r\n,    Period VARCHAR(7) NULL\r\n,    ValueStream VARCHAR(8) NULL\r\n,\r\n    CONSTRAINT PK__InvoiceSnapshot__04AFB25B PRIMARY KEY (InvoiceLineId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.MaterialGroupMapping') AND type = 'U')\r\nCREATE TABLE dbo.MaterialGroupMapping (\r\n    MappingId INT IDENTITY(1,1) NOT NULL\r\n,    CostElement NVARCHAR(10) NOT NULL\r\n,    ModeOfTransport NVARCHAR(20) NULL\r\n,    ModeKey NVARCHAR(20) NOT NULL\r\n,    MaterialGroup NVARCHAR(9) NOT NULL\r\n,    Description NVARCHAR(200) NULL\r\n,    CreatedBy NVARCHAR(100) NULL\r\n,    CreatedAtUtc DATETIME NOT NULL\r\n,    UpdatedAtUtc DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_MaterialGroupMapping PRIMARY KEY (MappingId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.NotificationDeliveries') AND type = 'U')\r\nCREATE TABLE dbo.NotificationDeliveries (\r\n    DeliveryID INT IDENTITY(1,1) NOT NULL\r\n,    NotificationID INT NOT NULL\r\n,    UserID INT NOT NULL\r\n,    IsRead BIT NOT NULL\r\n,    IsDismissed BIT NOT NULL\r\n,    ReadAt DATETIME NULL\r\n,    DismissedAt DATETIME NULL\r\n,\r\n    CONSTRAINT PK_NotificationDeliveries PRIMARY KEY (DeliveryID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.Notifications') AND type = 'U')\r\nCREATE TABLE dbo.Notifications (\r\n    NotificationID INT IDENTITY(1,1) NOT NULL\r\n,    Title NVARCHAR(120) NOT NULL\r\n,    Body NVARCHAR(MAX) NOT NULL\r\n,    Severity TINYINT NOT NULL\r\n,    Category NVARCHAR(50) NULL\r\n,    ActionLabel NVARCHAR(60) NULL\r\n,    ActionURL NVARCHAR(500) NULL\r\n,    TargetType NVARCHAR(20) NULL\r\n,    TargetValue NVARCHAR(100) NULL\r\n,    CreatedByUserID INT NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,    ExpiresAt DATETIME NULL\r\n,\r\n    CONSTRAINT PK_Notifications PRIMARY KEY (NotificationID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.OrderBookLineNotes') AND type = 'U')\r\nCREATE TABLE dbo.OrderBookLineNotes (\r\n    ReferenceDocument NVARCHAR(10) NOT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    Risk VARCHAR(1) NULL\r\n,    Reason NVARCHAR(500) NULL\r\n,    WontGet VARCHAR(1) NULL\r\n,    LastDay VARCHAR(1) NULL\r\n,    LastDayTime VARCHAR(20) NULL\r\n,    BringForward VARCHAR(1) NULL\r\n,    LastUpdatedUtc DATETIME NOT NULL\r\n,    UpdatedByUsername NVARCHAR(80) NULL\r\n,    PlannedProductionQty DECIMAL(15,3) NULL\r\n,\r\n    CONSTRAINT PK_OrderBookLineNotes PRIMARY KEY (ReferenceDocument, Material)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.OrderFulfillmentTracking') AND type = 'U')\r\nCREATE TABLE dbo.OrderFulfillmentTracking (\r\n    TrackingID INT IDENTITY(1,1) NOT NULL\r\n,    ReferenceDocument NVARCHAR(10) NOT NULL\r\n,    Item NVARCHAR(6) NOT NULL\r\n,    Customer NVARCHAR(10) NULL\r\n,    CustomerName NVARCHAR(35) NULL\r\n,    Material NVARCHAR(18) NULL\r\n,    MaterialText NVARCHAR(40) NULL\r\n,    ValueStream VARCHAR(8) NULL\r\n,    OrderQty DECIMAL(15,3) NULL\r\n,    Uom VARCHAR(3) NULL\r\n,    DueDate DATETIME NULL\r\n,    FirstSeenUtc DATETIME NOT NULL\r\n,    LastSeenUtc DATETIME NOT NULL\r\n,    Status VARCHAR(10) NOT NULL\r\n,    CompletedDate DATETIME NULL\r\n,    OnTime BIT NULL\r\n,    Reason NVARCHAR(500) NULL\r\n,\r\n    CONSTRAINT PK_OrderFulfillmentTracking PRIMARY KEY (TrackingID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.OtifSnapshot') AND type = 'U')\r\nCREATE TABLE dbo.OtifSnapshot (\r\n    OtifLineId INT IDENTITY(1,1) NOT NULL\r\n,    Customer VARCHAR(10) NULL\r\n,    CustomerName VARCHAR(35) NULL\r\n,    Plant VARCHAR(4) NULL\r\n,    ProfitCentre VARCHAR(10) NULL\r\n,    Material VARCHAR(18) NULL\r\n,    MaterialText VARCHAR(40) NULL\r\n,    Delivery VARCHAR(10) NULL\r\n,    DeliveryDate DATETIME NOT NULL\r\n,    DeliveryQty DECIMAL(15,3) NULL\r\n,    Uom VARCHAR(3) NULL\r\n,    TargetDate DATETIME NULL\r\n,    TargetQty DECIMAL(15,3) NULL\r\n,    QtyClass VARCHAR(4) NULL\r\n,    DateClass VARCHAR(4) NULL\r\n,    OnTime BIT NULL\r\n,    ValueStream VARCHAR(8) NULL\r\n,\r\n    CONSTRAINT PK__OtifSnapshot__0697FACD PRIMARY KEY (OtifLineId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalAuditLog') AND type = 'U')\r\nCREATE TABLE dbo.PortalAuditLog (\r\n    LogID INT IDENTITY(1,1) NOT NULL\r\n,    EventTime DATETIME NOT NULL\r\n,    Username NVARCHAR(80) NULL\r\n,    EventType NVARCHAR(50) NOT NULL\r\n,    Detail NVARCHAR(500) NULL\r\n,    IPAddress NVARCHAR(45) NULL\r\n,\r\n    CONSTRAINT PK__PortalAuditLog__59C55456 PRIMARY KEY (LogID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalPermissions') AND type = 'U')\r\nCREATE TABLE dbo.PortalPermissions (\r\n    PermissionCode NVARCHAR(50) NOT NULL\r\n,    PermissionName NVARCHAR(100) NOT NULL\r\n,    Description NVARCHAR(500) NULL\r\n,    Category NVARCHAR(50) NOT NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_PortalPermissions PRIMARY KEY (PermissionCode)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalSessions') AND type = 'U')\r\nCREATE TABLE dbo.PortalSessions (\r\n    SessionID NVARCHAR(128) NOT NULL\r\n,    SessionData NVARCHAR(MAX) NOT NULL\r\n,    ExpiresUtc DATETIME NOT NULL\r\n,    CreatedUtc DATETIME NOT NULL\r\n,    UpdatedUtc DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_PortalSessions PRIMARY KEY (SessionID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalUserDepartments') AND type = 'U')\r\nCREATE TABLE dbo.PortalUserDepartments (\r\n    ID INT IDENTITY(1,1) NOT NULL\r\n,    UserID INT NOT NULL\r\n,    Department NVARCHAR(50) NOT NULL\r\n,    GrantedBy NVARCHAR(80) NULL\r\n,    GrantedAt DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK__PortalUserDepart__55009F39 PRIMARY KEY (ID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalUserPermissions') AND type = 'U')\r\nCREATE TABLE dbo.PortalUserPermissions (\r\n    UserPermissionID INT IDENTITY(1,1) NOT NULL\r\n,    UserID INT NOT NULL\r\n,    PermissionCode NVARCHAR(50) NOT NULL\r\n,    GrantedAt DATETIME NOT NULL\r\n,    GrantedByUserID INT NULL\r\n,\r\n    CONSTRAINT PK_PortalUserPermissions PRIMARY KEY (UserPermissionID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalUsers') AND type = 'U')\r\nCREATE TABLE dbo.PortalUsers (\r\n    UserID INT IDENTITY(1,1) NOT NULL\r\n,    Username NVARCHAR(80) NOT NULL\r\n,    Email NVARCHAR(160) NOT NULL\r\n,    PasswordHash NVARCHAR(256) NOT NULL\r\n,    Role NVARCHAR(20) NOT NULL\r\n,    IsActive BIT NOT NULL\r\n,    IsLocked BIT NOT NULL\r\n,    FailedLogins INT NOT NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,    LastLogin DATETIME NULL\r\n,    ApprovedBy NVARCHAR(80) NULL\r\n,    ApprovedAt DATETIME NULL\r\n,    Notes NVARCHAR(500) NULL\r\n,    FirstName NVARCHAR(80) NULL\r\n,    LastName NVARCHAR(80) NULL\r\n,    DefaultPrinterID NVARCHAR(50) NULL\r\n,    ShortIdleTimeout BIT NOT NULL\r\n,    reset_token VARCHAR(255) NULL\r\n,    reset_token_expires DATETIME NULL\r\n,    SapUsername NVARCHAR(40) NULL\r\n,    SapPasswordEncrypted NVARCHAR(400) NULL\r\n,    SapCredentialUpdatedAt DATETIME NULL\r\n,\r\n    CONSTRAINT PK__PortalUsers__4D5F7D71 PRIMARY KEY (UserID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ProductionScheduleComments') AND type = 'U')\r\nCREATE TABLE dbo.ProductionScheduleComments (\r\n    ReferenceDocument NVARCHAR(10) NOT NULL\r\n,    Item NVARCHAR(6) NOT NULL\r\n,    Comment NVARCHAR(500) NULL\r\n,    Eta DATETIME NULL\r\n,    LastUpdatedUtc DATETIME NOT NULL\r\n,    UpdatedByUsername NVARCHAR(80) NULL\r\n,\r\n    CONSTRAINT PK_ProductionScheduleComments PRIMARY KEY (ReferenceDocument, Item)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PurchaseOrderShipment') AND type = 'U')\r\nCREATE TABLE dbo.PurchaseOrderShipment (\r\n    ShipmentId INT IDENTITY(1,1) NOT NULL\r\n,    ShipmentReference NVARCHAR(50) NULL\r\n,    Haulier NVARCHAR(100) NULL\r\n,    ModeOfTransport NVARCHAR(20) NULL\r\n,    TrackingNumber NVARCHAR(100) NULL\r\n,    Notes NVARCHAR(500) NULL\r\n,    CreatedAtUtc DATETIME NOT NULL\r\n,    UpdatedAtUtc DATETIME NOT NULL\r\n,    DispatchDate DATETIME NULL\r\n,    ExpectedEta DATETIME NULL\r\n,    BillOfLading NVARCHAR(50) NULL\r\n,    ContainerNumber NVARCHAR(50) NULL\r\n,    ReceivedAtUtc DATETIME NULL\r\n,    ReceivedBy NVARCHAR(100) NULL\r\n,    CancelledAtUtc DATETIME NULL\r\n,    CancelledBy NVARCHAR(100) NULL\r\n,    ForwarderID BIGINT NULL\r\n,    IsManual BIT NOT NULL\r\n,    OriginDestinationID BIGINT NULL\r\n,    OriginName NVARCHAR(200) NULL\r\n,\r\n    CONSTRAINT PK_PurchaseOrderShipment PRIMARY KEY (ShipmentId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PurchaseOrderSuggestion') AND type = 'U')\r\nCREATE TABLE dbo.PurchaseOrderSuggestion (\r\n    SuggestionId INT IDENTITY(1,1) NOT NULL\r\n,    VendorId INT NOT NULL\r\n,    VendorMaterialId INT NOT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    Status NVARCHAR(20) NOT NULL\r\n,    SuggestedQty DECIMAL(15,3) NULL\r\n,    OrderQty DECIMAL(15,3) NOT NULL\r\n,    OrderDate DATETIME NOT NULL\r\n,    LeadTimeDaysUsed DECIMAL(9,2) NULL\r\n,    DeliveryDate DATETIME NULL\r\n,    TransitTimeDaysUsed DECIMAL(9,2) NULL\r\n,    ReadyToCollectDate DATETIME NULL\r\n,    IsSpotPo BIT NOT NULL\r\n,    PoNumber NVARCHAR(20) NULL\r\n,    Notes NVARCHAR(500) NULL\r\n,    CreatedAtUtc DATETIME NOT NULL\r\n,    UpdatedAtUtc DATETIME NOT NULL\r\n,    ReceivedAtUtc DATETIME NULL\r\n,    ShipmentId INT NULL\r\n,    SupplierReference NVARCHAR(50) NULL\r\n,    PoItemNumber NVARCHAR(5) NULL\r\n,    ReceivedQty DECIMAL(15,3) NULL\r\n,    SapMaterialDocument NVARCHAR(20) NULL\r\n,    SapGrError NVARCHAR(500) NULL\r\n,    SapGrSkipped BIT NULL\r\n,\r\n    CONSTRAINT PK_PurchaseOrderSuggestion PRIMARY KEY (SuggestionId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.RefreshLog') AND type = 'U')\r\nCREATE TABLE dbo.RefreshLog (\r\n    RunId INT IDENTITY(1,1) NOT NULL\r\n,    DatasetName VARCHAR(50) NOT NULL\r\n,    StartedAtUtc DATETIME NOT NULL\r\n,    CompletedAtUtc DATETIME NULL\r\n,    TotalRows INT NULL\r\n,    Status VARCHAR(20) NOT NULL\r\n,    ErrorMessage VARCHAR(4000) NULL\r\n,\r\n    CONSTRAINT PK__RefreshLog__7EF6D905 PRIMARY KEY (RunId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ScheduledDeployments') AND type = 'U')\r\nCREATE TABLE dbo.ScheduledDeployments (\r\n    DeploymentID INT IDENTITY(1,1) NOT NULL\r\n,    ScheduledAt DATETIME NOT NULL\r\n,    GitRef NVARCHAR(100) NOT NULL\r\n,    WarningMinutes INT NOT NULL\r\n,    Status NVARCHAR(20) NOT NULL\r\n,    Notes NVARCHAR(500) NULL\r\n,    CreatedByUserID INT NULL\r\n,    CreatedByUsername NVARCHAR(80) NULL\r\n,    CreatedAt DATETIME NOT NULL\r\n,    StartedAt DATETIME NULL\r\n,    CompletedAt DATETIME NULL\r\n,    OutputLog NVARCHAR(MAX) NULL\r\n,    ErrorMessage NVARCHAR(MAX) NULL\r\n,    CancelledAt DATETIME NULL\r\n,    CancelledBy NVARCHAR(80) NULL\r\n,\r\n    CONSTRAINT PK_ScheduledDeployments PRIMARY KEY (DeploymentID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ScrapReasons') AND type = 'U')\r\nCREATE TABLE dbo.ScrapReasons (\r\n    ReasonCode INT NOT NULL\r\n,    ReasonDescription NVARCHAR(MAX) NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.Staging') AND type = 'U')\r\nCREATE TABLE dbo.Staging (\r\n    Material NVARCHAR(18) NOT NULL\r\n,    Quantity DECIMAL(18,0) NOT NULL\r\n,    Batch NVARCHAR(10) NULL\r\n,    CreationTime NVARCHAR(15) NOT NULL\r\n,    DeliveryTime NVARCHAR(15) NULL\r\n,    DeliveryLoc NVARCHAR(18) NOT NULL\r\n,    StagingID BIGINT NULL\r\n,    Complete BIT NULL\r\n,    DeliveredQty DECIMAL(18,0) NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.StagingBinRestriction') AND type = 'U')\r\nCREATE TABLE dbo.StagingBinRestriction (\r\n    RestrictionId INT IDENTITY(1,1) NOT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    StorageType NVARCHAR(3) NOT NULL\r\n,    Bin NVARCHAR(10) NULL\r\n,    Notes NVARCHAR(200) NULL\r\n,    CreatedBy NVARCHAR(100) NULL\r\n,    CreatedAtUtc DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_StagingBinRestriction PRIMARY KEY (RestrictionId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.StagingItems') AND type = 'U')\r\nCREATE TABLE dbo.StagingItems (\r\n    StagingID BIGINT NULL\r\n,    DeliveryQty DECIMAL(18,0) NULL\r\n,    MatDoc NVARCHAR(50) NULL\r\n,    Comment NVARCHAR(MAX) NULL\r\n,    Timestamp VARCHAR(15) NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.StagingRequest') AND type = 'U')\r\nCREATE TABLE dbo.StagingRequest (\r\n    RequestId INT IDENTITY(1,1) NOT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    MaterialText NVARCHAR(80) NULL\r\n,    Uom NVARCHAR(3) NULL\r\n,    QuantityRequested DECIMAL(15,3) NOT NULL\r\n,    QuantityDelivered DECIMAL(15,3) NOT NULL\r\n,    Location NVARCHAR(100) NOT NULL\r\n,    RequestedBatch NVARCHAR(10) NULL\r\n,    DueAtUtc DATETIME NOT NULL\r\n,    Notes NVARCHAR(500) NULL\r\n,    Status NVARCHAR(20) NOT NULL\r\n,    RequestedBy NVARCHAR(100) NOT NULL\r\n,    RequestedAtUtc DATETIME NOT NULL\r\n,    CompletedBy NVARCHAR(100) NULL\r\n,    CompletedAtUtc DATETIME NULL\r\n,    CancelledBy NVARCHAR(100) NULL\r\n,    CancelledAtUtc DATETIME NULL\r\n,    UpdatedAtUtc DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_StagingRequest PRIMARY KEY (RequestId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.StagingRequestDelivery') AND type = 'U')\r\nCREATE TABLE dbo.StagingRequestDelivery (\r\n    DeliveryId INT IDENTITY(1,1) NOT NULL\r\n,    RequestId INT NOT NULL\r\n,    QuantityMoved DECIMAL(15,3) NOT NULL\r\n,    Batch NVARCHAR(10) NULL\r\n,    SourceStorageType NVARCHAR(3) NULL\r\n,    SourceBin NVARCHAR(10) NULL\r\n,    DestinationStorageType NVARCHAR(3) NULL\r\n,    DestinationBin NVARCHAR(10) NULL\r\n,    TransferOrderNumber NVARCHAR(10) NULL\r\n,    DeliveredBy NVARCHAR(100) NOT NULL\r\n,    DeliveredAtUtc DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_StagingRequestDelivery PRIMARY KEY (DeliveryId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.StockSnapshot') AND type = 'U')\r\nCREATE TABLE dbo.StockSnapshot (\r\n    Material VARCHAR(18) NOT NULL\r\n,    Batch VARCHAR(10) NOT NULL\r\n,    StorageBin VARCHAR(10) NULL\r\n,    StorageType VARCHAR(3) NULL\r\n,    TotalQty DECIMAL(15,3) NOT NULL\r\n,    AvailableQty DECIMAL(15,3) NOT NULL\r\n,    StorageLocation VARCHAR(4) NULL\r\n,    PackagingMaterial VARCHAR(40) NULL\r\n,    ValueStream VARCHAR(8) NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.StockValuationHistory') AND type = 'U')\r\nCREATE TABLE dbo.StockValuationHistory (\r\n    Material NVARCHAR(18) NOT NULL\r\n,    Plant NVARCHAR(4) NOT NULL\r\n,    SnapshotDate DATETIME NOT NULL\r\n,    MaterialType NVARCHAR(4) NULL\r\n,    StockQty DECIMAL(15,3) NULL\r\n,    StockValue DECIMAL(18,2) NULL\r\n,    ConsignmentQty DECIMAL(15,3) NULL\r\n,    LastUpdatedUtc DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_StockValuationHistory PRIMARY KEY (Material, Plant, SnapshotDate)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.sysdiagrams') AND type = 'U')\r\nCREATE TABLE dbo.sysdiagrams (\r\n    name SYSNAME NOT NULL\r\n,    principal_id INT NOT NULL\r\n,    diagram_id INT IDENTITY(1,1) NOT NULL\r\n,    version INT NULL\r\n,    definition VARBINARY(MAX) NULL\r\n,\r\n    CONSTRAINT PK__sysdiagrams__7E6CC920 PRIMARY KEY (diagram_id)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.TurnsValClassSnapshot') AND type = 'U')\r\nCREATE TABLE dbo.TurnsValClassSnapshot (\r\n    Material NVARCHAR(18) NOT NULL\r\n,    Plant NVARCHAR(4) NOT NULL\r\n,    MaterialText NVARCHAR(40) NULL\r\n,    CreatedDate DATETIME NULL\r\n,    MaterialType NVARCHAR(4) NULL\r\n,    Uom NVARCHAR(3) NULL\r\n,    ProfitCentre NVARCHAR(10) NULL\r\n,    DeletionFlag BIT NOT NULL\r\n,    AbcIndicator NVARCHAR(1) NULL\r\n,    PurchasingGroup NVARCHAR(3) NULL\r\n,    MrpController NVARCHAR(3) NULL\r\n,    ValuationClass NVARCHAR(4) NULL\r\n,    LotSizeProcedure NVARCHAR(2) NULL\r\n,    PlanningTimeFence DECIMAL(9,0) NULL\r\n,    GrProcessingTime DECIMAL(9,2) NULL\r\n,    TotalReplenishmentTime DECIMAL(9,2) NULL\r\n,    SafetyStock DECIMAL(15,3) NULL\r\n,    MinLotSize DECIMAL(15,3) NULL\r\n,    MaxLotSize DECIMAL(15,3) NULL\r\n,    FixedLotSize DECIMAL(15,3) NULL\r\n,    RoundingValue DECIMAL(15,3) NULL\r\n,    SpecialProcurementType NVARCHAR(2) NULL\r\n,    PlannedDeliveryTime DECIMAL(9,2) NULL\r\n,    StockQty DECIMAL(15,3) NULL\r\n,    StockValue DECIMAL(18,2) NULL\r\n,    UnitPrice DECIMAL(15,4) NULL\r\n,    BookValue DECIMAL(18,2) NULL\r\n,    HistoryM12 DECIMAL(15,3) NULL\r\n,    HistoryM11 DECIMAL(15,3) NULL\r\n,    HistoryM10 DECIMAL(15,3) NULL\r\n,    HistoryM09 DECIMAL(15,3) NULL\r\n,    HistoryM08 DECIMAL(15,3) NULL\r\n,    HistoryM07 DECIMAL(15,3) NULL\r\n,    HistoryM06 DECIMAL(15,3) NULL\r\n,    HistoryM05 DECIMAL(15,3) NULL\r\n,    HistoryM04 DECIMAL(15,3) NULL\r\n,    HistoryM03 DECIMAL(15,3) NULL\r\n,    HistoryM02 DECIMAL(15,3) NULL\r\n,    HistoryM01 DECIMAL(15,3) NULL\r\n,    HistoryM00 DECIMAL(15,3) NULL\r\n,    ForecastM12 DECIMAL(15,3) NULL\r\n,    ForecastM11 DECIMAL(15,3) NULL\r\n,    ForecastM10 DECIMAL(15,3) NULL\r\n,    ForecastM09 DECIMAL(15,3) NULL\r\n,    ForecastM08 DECIMAL(15,3) NULL\r\n,    ForecastM07 DECIMAL(15,3) NULL\r\n,    ForecastM06 DECIMAL(15,3) NULL\r\n,    ForecastM05 DECIMAL(15,3) NULL\r\n,    ForecastM04 DECIMAL(15,3) NULL\r\n,    ForecastM03 DECIMAL(15,3) NULL\r\n,    ForecastM02 DECIMAL(15,3) NULL\r\n,    ForecastM01 DECIMAL(15,3) NULL\r\n,    ForecastM00 DECIMAL(15,3) NULL\r\n,    LastReceiptDate DATETIME NULL\r\n,    LastGoodsIssueDate DATETIME NULL\r\n,    LastConsumptionDate DATETIME NULL\r\n,    LastGoodsMovementDate DATETIME NULL\r\n,    StockTurns DECIMAL(15,4) NULL\r\n,    DaysInStock DECIMAL(15,2) NULL\r\n,    DailyRequirementValue DECIMAL(18,4) NULL\r\n,    TurnoverCategory NVARCHAR(30) NULL\r\n,    Warning NVARCHAR(200) NULL\r\n,    SnapshotAtUtc DATETIME NOT NULL\r\n,    PredictedM12 DECIMAL(15,3) NULL\r\n,    PredictedM11 DECIMAL(15,3) NULL\r\n,    PredictedM10 DECIMAL(15,3) NULL\r\n,    PredictedM09 DECIMAL(15,3) NULL\r\n,    PredictedM08 DECIMAL(15,3) NULL\r\n,    PredictedM07 DECIMAL(15,3) NULL\r\n,    PredictedM06 DECIMAL(15,3) NULL\r\n,    PredictedM05 DECIMAL(15,3) NULL\r\n,    PredictedM04 DECIMAL(15,3) NULL\r\n,    PredictedM03 DECIMAL(15,3) NULL\r\n,    PredictedM02 DECIMAL(15,3) NULL\r\n,    PredictedM01 DECIMAL(15,3) NULL\r\n,    PredictedM00 DECIMAL(15,3) NULL\r\n,    ConsignmentQty DECIMAL(15,3) NULL\r\n,\r\n    CONSTRAINT PK_TurnsValClassSnapshot PRIMARY KEY (Material, Plant)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ValuationClassCatalog') AND type = 'U')\r\nCREATE TABLE dbo.ValuationClassCatalog (\r\n    ValuationClass NVARCHAR(4) NOT NULL\r\n,    MaterialType NVARCHAR(4) NOT NULL\r\n,    AccountRef NVARCHAR(4) NULL\r\n,    Description NVARCHAR(40) NULL\r\n,\r\n    CONSTRAINT PK_ValuationClassCatalog PRIMARY KEY (ValuationClass, MaterialType)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ValuationClassChangeBatch') AND type = 'U')\r\nCREATE TABLE dbo.ValuationClassChangeBatch (\r\n    BatchID INT IDENTITY(1,1) NOT NULL\r\n,    OrderNumber NVARCHAR(12) NOT NULL\r\n,    Plant NVARCHAR(4) NULL\r\n,    RequestedByUserID INT NULL\r\n,    RequestedByName NVARCHAR(80) NULL\r\n,    RequestedAtUtc DATETIME NOT NULL\r\n,    Success BIT NOT NULL\r\n,    TotalValueChange DECIMAL(18,2) NULL\r\n,    ErrorMessage NVARCHAR(4000) NULL\r\n,\r\n    CONSTRAINT PK_ValuationClassChangeBatch PRIMARY KEY (BatchID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ValuationClassChangeDetail') AND type = 'U')\r\nCREATE TABLE dbo.ValuationClassChangeDetail (\r\n    DetailID INT IDENTITY(1,1) NOT NULL\r\n,    BatchID INT NOT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    MaterialText NVARCHAR(40) NULL\r\n,    Plant NVARCHAR(4) NULL\r\n,    StockQty DECIMAL(15,3) NULL\r\n,    OldValuationClass NVARCHAR(4) NULL\r\n,    NewValuationClass NVARCHAR(4) NULL\r\n,    OldBookValue DECIMAL(18,2) NULL\r\n,    NewBookValue DECIMAL(18,2) NULL\r\n,    ValueChange DECIMAL(18,2) NULL\r\n,    Success BIT NOT NULL\r\n,    Message NVARCHAR(500) NULL\r\n,\r\n    CONSTRAINT PK_ValuationClassChangeDetail PRIMARY KEY (DetailID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.Vendor') AND type = 'U')\r\nCREATE TABLE dbo.Vendor (\r\n    VendorId INT IDENTITY(1,1) NOT NULL\r\n,    VendorName NVARCHAR(80) NOT NULL\r\n,    Incoterms NVARCHAR(3) NULL\r\n,    OrderMoqQty DECIMAL(15,3) NULL\r\n,    OrderMoqUom NVARCHAR(3) NULL\r\n,    DefaultLeadTimeDays DECIMAL(9,2) NULL\r\n,    Notes NVARCHAR(500) NULL\r\n,    CreatedAtUtc DATETIME NOT NULL\r\n,    UpdatedAtUtc DATETIME NOT NULL\r\n,    TransitTimeDays DECIMAL(9,2) NULL\r\n,    OrderMaxQty DECIMAL(15,3) NULL\r\n,    SapVendorNumber NVARCHAR(10) NULL\r\n,    Currency NVARCHAR(3) NULL\r\n,\r\n    CONSTRAINT PK_Vendor PRIMARY KEY (VendorId)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.VendorMaterial') AND type = 'U')\r\nCREATE TABLE dbo.VendorMaterial (\r\n    VendorMaterialId INT IDENTITY(1,1) NOT NULL\r\n,    VendorId INT NOT NULL\r\n,    Material NVARCHAR(18) NOT NULL\r\n,    MaterialMoqQty DECIMAL(15,3) NULL\r\n,    LeadTimeDaysOverride DECIMAL(9,2) NULL\r\n,    ScheduleAgreement NVARCHAR(10) NULL\r\n,    SourceHint NVARCHAR(40) NULL\r\n,    CreatedAtUtc DATETIME NOT NULL\r\n,    UpdatedAtUtc DATETIME NOT NULL\r\n,    MinSafetyStockQty DECIMAL(15,3) NULL\r\n,    MaterialMaxQty DECIMAL(15,3) NULL\r\n,\r\n    CONSTRAINT PK_VendorMaterial PRIMARY KEY (VendorMaterialId)\r\n)");

    await knex.raw("ALTER TABLE dbo.ConsignmentCustomer ADD CONSTRAINT DF__Consignme__LastU__6BAEFA67 DEFAULT (getutcdate()) FOR LastUpdatedUtc");

    await knex.raw("ALTER TABLE dbo.ConsignmentDeclaration ADD CONSTRAINT DF__Consignme__Statu__00AA174D DEFAULT ('Draft') FOR Status");

    await knex.raw("ALTER TABLE dbo.ConsignmentDeclaration ADD CONSTRAINT DF__Consignme__Alloc__019E3B86 DEFAULT ('FEFO') FOR AllocationMethod");

    await knex.raw("ALTER TABLE dbo.ConsignmentDeclaration ADD CONSTRAINT DF__Consignme__Total__02925FBF DEFAULT ((0)) FOR TotalQty");

    await knex.raw("ALTER TABLE dbo.ConsignmentDeclaration ADD CONSTRAINT DF__Consignme__Creat__038683F8 DEFAULT (getutcdate()) FOR CreatedAtUtc");

    await knex.raw("ALTER TABLE dbo.ConsignmentDeclarationLine ADD CONSTRAINT DF__Consignme__Creat__093F5D4E DEFAULT (getutcdate()) FOR CreatedAtUtc");

    await knex.raw("ALTER TABLE dbo.ConsignmentDelivery ADD CONSTRAINT DF__Consignme__Mater__79FD19BE DEFAULT ('0001') FOR MaterialDocItem");

    await knex.raw("ALTER TABLE dbo.ConsignmentDelivery ADD CONSTRAINT DF__Consignme__Sourc__7AF13DF7 DEFAULT ('SAP') FOR Source");

    await knex.raw("ALTER TABLE dbo.ConsignmentDelivery ADD CONSTRAINT DF__Consignme__Creat__7BE56230 DEFAULT (getutcdate()) FOR CreatedAtUtc");

    await knex.raw("ALTER TABLE dbo.ConsignmentVendorConfig ADD CONSTRAINT DF__Consignme__Track__7167D3BD DEFAULT ((0)) FOR TrackExpiry");

    await knex.raw("ALTER TABLE dbo.ConsignmentVendorConfig ADD CONSTRAINT DF__Consignme__Defau__725BF7F6 DEFAULT ('FEFO') FOR DefaultAllocationMethod");

    await knex.raw("ALTER TABLE dbo.ConsignmentVendorConfig ADD CONSTRAINT DF__Consignme__Activ__73501C2F DEFAULT ((1)) FOR Active");

    await knex.raw("ALTER TABLE dbo.ConsignmentVendorConfig ADD CONSTRAINT DF__Consignme__Updat__74444068 DEFAULT (getutcdate()) FOR UpdatedAtUtc");

    await knex.raw("ALTER TABLE dbo.CustomerStandardInstructions ADD CONSTRAINT DF__CustomerS__LastU__5D60DB10 DEFAULT (getutcdate()) FOR LastUpdatedUtc");

    await knex.raw("ALTER TABLE dbo.DeliveryOrderLink ADD CONSTRAINT DF__DeliveryO__Resol__6E8B6712 DEFAULT (getutcdate()) FOR ResolvedAtUtc");

    await knex.raw("ALTER TABLE dbo.DemandAdjustment ADD CONSTRAINT DF__DemandAdj__Creat__3BFFE745 DEFAULT (getutcdate()) FOR CreatedAtUtc");

    await knex.raw("ALTER TABLE dbo.DemandAdjustment ADD CONSTRAINT DF__DemandAdj__Updat__3CF40B7E DEFAULT (getutcdate()) FOR UpdatedAtUtc");

    await knex.raw("ALTER TABLE dbo.FinanceGlGroupAccounts ADD CONSTRAINT DF__FinanceGl__SortO__72910220 DEFAULT ((0)) FOR SortOrder");

    await knex.raw("ALTER TABLE dbo.FinanceGlGroups ADD CONSTRAINT DF__FinanceGl__SortO__6DCC4D03 DEFAULT ((0)) FOR SortOrder");

    await knex.raw("ALTER TABLE dbo.FinanceGlGroups ADD CONSTRAINT DF__FinanceGl__Creat__6EC0713C DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE dbo.ForecastAccuracyLog ADD CONSTRAINT DF__ForecastA__LastU__19AACF41 DEFAULT (getutcdate()) FOR LastUpdatedUtc");

    await knex.raw("ALTER TABLE dbo.ForwarderModeMapping ADD CONSTRAINT DF__Forwarder__Creat__67DE6983 DEFAULT (getutcdate()) FOR CreatedAtUtc");

    await knex.raw("ALTER TABLE dbo.ForwarderModeMapping ADD CONSTRAINT DF__Forwarder__Updat__68D28DBC DEFAULT (getutcdate()) FOR UpdatedAtUtc");

    await knex.raw("ALTER TABLE dbo.MaterialGroupMapping ADD CONSTRAINT DF__MaterialG__Creat__6319B466 DEFAULT (getutcdate()) FOR CreatedAtUtc");

    await knex.raw("ALTER TABLE dbo.MaterialGroupMapping ADD CONSTRAINT DF__MaterialG__Updat__640DD89F DEFAULT (getutcdate()) FOR UpdatedAtUtc");

    await knex.raw("ALTER TABLE dbo.NotificationDeliveries ADD CONSTRAINT DF__Notificat__IsRea__7A3223E8 DEFAULT ((0)) FOR IsRead");

    await knex.raw("ALTER TABLE dbo.NotificationDeliveries ADD CONSTRAINT DF__Notificat__IsDis__7B264821 DEFAULT ((0)) FOR IsDismissed");

    await knex.raw("ALTER TABLE dbo.Notifications ADD CONSTRAINT DF__Notificat__Sever__756D6ECB DEFAULT ((1)) FOR Severity");

    await knex.raw("ALTER TABLE dbo.Notifications ADD CONSTRAINT DF__Notificat__Creat__76619304 DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE dbo.OrderBookLineNotes ADD CONSTRAINT DF__OrderBook__LastU__4F12BBB9 DEFAULT (getutcdate()) FOR LastUpdatedUtc");

    await knex.raw("ALTER TABLE dbo.OrderFulfillmentTracking ADD CONSTRAINT DF__OrderFulf__First__589C25F3 DEFAULT (getutcdate()) FOR FirstSeenUtc");

    await knex.raw("ALTER TABLE dbo.OrderFulfillmentTracking ADD CONSTRAINT DF__OrderFulf__LastS__59904A2C DEFAULT (getutcdate()) FOR LastSeenUtc");

    await knex.raw("ALTER TABLE dbo.OrderFulfillmentTracking ADD CONSTRAINT DF__OrderFulf__Statu__5A846E65 DEFAULT ('OPEN') FOR Status");

    await knex.raw("ALTER TABLE dbo.PortalAuditLog ADD CONSTRAINT DF__PortalAud__Event__5AB9788F DEFAULT (getdate()) FOR EventTime");

    await knex.raw("ALTER TABLE dbo.PortalPermissions ADD CONSTRAINT DF__PortalPer__Categ__6166761E DEFAULT (N'General') FOR Category");

    await knex.raw("ALTER TABLE dbo.PortalPermissions ADD CONSTRAINT DF__PortalPer__Creat__625A9A57 DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE dbo.PortalSessions ADD CONSTRAINT DF__PortalSes__Creat__51EF2864 DEFAULT (getutcdate()) FOR CreatedUtc");

    await knex.raw("ALTER TABLE dbo.PortalSessions ADD CONSTRAINT DF__PortalSes__Updat__52E34C9D DEFAULT (getutcdate()) FOR UpdatedUtc");

    await knex.raw("ALTER TABLE dbo.PortalUserDepartments ADD CONSTRAINT DF__PortalUse__Grant__57DD0BE4 DEFAULT (getdate()) FOR GrantedAt");

    await knex.raw("ALTER TABLE dbo.PortalUserPermissions ADD CONSTRAINT DF__PortalUse__Grant__662B2B3B DEFAULT (getdate()) FOR GrantedAt");

    await knex.raw("ALTER TABLE dbo.PortalUsers ADD CONSTRAINT DF__PortalUser__Role__4E53A1AA DEFAULT ('viewer') FOR Role");

    await knex.raw("ALTER TABLE dbo.PortalUsers ADD CONSTRAINT DF__PortalUse__IsAct__503BEA1C DEFAULT ((0)) FOR IsActive");

    await knex.raw("ALTER TABLE dbo.PortalUsers ADD CONSTRAINT DF__PortalUse__IsLoc__51300E55 DEFAULT ((0)) FOR IsLocked");

    await knex.raw("ALTER TABLE dbo.PortalUsers ADD CONSTRAINT DF__PortalUse__Faile__5224328E DEFAULT ((0)) FOR FailedLogins");

    await knex.raw("ALTER TABLE dbo.PortalUsers ADD CONSTRAINT DF__PortalUse__Creat__531856C7 DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE dbo.PortalUsers ADD CONSTRAINT DF__PortalUse__Short__5E54FF49 DEFAULT ((0)) FOR ShortIdleTimeout");

    await knex.raw("ALTER TABLE dbo.ProductionScheduleComments ADD CONSTRAINT DF__Productio__LastU__55BFB948 DEFAULT (getutcdate()) FOR LastUpdatedUtc");

    await knex.raw("ALTER TABLE dbo.PurchaseOrderShipment ADD CONSTRAINT DF__PurchaseO__Creat__373B3228 DEFAULT (getutcdate()) FOR CreatedAtUtc");

    await knex.raw("ALTER TABLE dbo.PurchaseOrderShipment ADD CONSTRAINT DF__PurchaseO__Updat__382F5661 DEFAULT (getutcdate()) FOR UpdatedAtUtc");

    await knex.raw("ALTER TABLE dbo.PurchaseOrderShipment ADD CONSTRAINT DF__PurchaseO__IsMan__5F492382 DEFAULT ((0)) FOR IsManual");

    await knex.raw("ALTER TABLE dbo.PurchaseOrderSuggestion ADD CONSTRAINT DF__PurchaseO__Statu__2F9A1060 DEFAULT ('Accepted') FOR Status");

    await knex.raw("ALTER TABLE dbo.PurchaseOrderSuggestion ADD CONSTRAINT DF__PurchaseO__IsSpo__308E3499 DEFAULT ((0)) FOR IsSpotPo");

    await knex.raw("ALTER TABLE dbo.PurchaseOrderSuggestion ADD CONSTRAINT DF__PurchaseO__Creat__318258D2 DEFAULT (getutcdate()) FOR CreatedAtUtc");

    await knex.raw("ALTER TABLE dbo.PurchaseOrderSuggestion ADD CONSTRAINT DF__PurchaseO__Updat__32767D0B DEFAULT (getutcdate()) FOR UpdatedAtUtc");

    await knex.raw("ALTER TABLE dbo.ScheduledDeployments ADD CONSTRAINT DF__Scheduled__GitRe__1C873BEC DEFAULT ('main') FOR GitRef");

    await knex.raw("ALTER TABLE dbo.ScheduledDeployments ADD CONSTRAINT DF__Scheduled__Warni__1D7B6025 DEFAULT ((15)) FOR WarningMinutes");

    await knex.raw("ALTER TABLE dbo.ScheduledDeployments ADD CONSTRAINT DF__Scheduled__Statu__1E6F845E DEFAULT ('pending') FOR Status");

    await knex.raw("ALTER TABLE dbo.ScheduledDeployments ADD CONSTRAINT DF__Scheduled__Creat__1F63A897 DEFAULT (getdate()) FOR CreatedAt");

    await knex.raw("ALTER TABLE dbo.Staging ADD CONSTRAINT DF_Staging_DeliveredQty DEFAULT ((0)) FOR DeliveredQty");

    await knex.raw("ALTER TABLE dbo.StagingBinRestriction ADD CONSTRAINT DF__StagingBi__Creat__4C364F0E DEFAULT (getutcdate()) FOR CreatedAtUtc");

    await knex.raw("ALTER TABLE dbo.StagingRequest ADD CONSTRAINT DF__StagingRe__Quant__41B8C09B DEFAULT ((0)) FOR QuantityDelivered");

    await knex.raw("ALTER TABLE dbo.StagingRequest ADD CONSTRAINT DF__StagingRe__Statu__42ACE4D4 DEFAULT ('Open') FOR Status");

    await knex.raw("ALTER TABLE dbo.StagingRequest ADD CONSTRAINT DF__StagingRe__Reque__43A1090D DEFAULT (getutcdate()) FOR RequestedAtUtc");

    await knex.raw("ALTER TABLE dbo.StagingRequest ADD CONSTRAINT DF__StagingRe__Updat__44952D46 DEFAULT (getutcdate()) FOR UpdatedAtUtc");

    await knex.raw("ALTER TABLE dbo.StagingRequestDelivery ADD CONSTRAINT DF__StagingRe__Deliv__4865BE2A DEFAULT (getutcdate()) FOR DeliveredAtUtc");

    await knex.raw("ALTER TABLE dbo.StockValuationHistory ADD CONSTRAINT DF__StockValu__LastU__22401542 DEFAULT (getutcdate()) FOR LastUpdatedUtc");

    await knex.raw("ALTER TABLE dbo.TurnsValClassSnapshot ADD CONSTRAINT DF__TurnsValC__Delet__0C50D423 DEFAULT ((0)) FOR DeletionFlag");

    await knex.raw("ALTER TABLE dbo.TurnsValClassSnapshot ADD CONSTRAINT DF__TurnsValC__Snaps__0D44F85C DEFAULT (getutcdate()) FOR SnapshotAtUtc");

    await knex.raw("ALTER TABLE dbo.ValuationClassChangeBatch ADD CONSTRAINT DF__Valuation__Reque__1209AD79 DEFAULT (getutcdate()) FOR RequestedAtUtc");

    await knex.raw("ALTER TABLE dbo.ValuationClassChangeBatch ADD CONSTRAINT DF__Valuation__Succe__12FDD1B2 DEFAULT ((0)) FOR Success");

    await knex.raw("ALTER TABLE dbo.ValuationClassChangeDetail ADD CONSTRAINT DF__Valuation__Succe__15DA3E5D DEFAULT ((0)) FOR Success");

    await knex.raw("ALTER TABLE dbo.Vendor ADD CONSTRAINT DF__Vendor__CreatedA__2610A626 DEFAULT (getutcdate()) FOR CreatedAtUtc");

    await knex.raw("ALTER TABLE dbo.Vendor ADD CONSTRAINT DF__Vendor__UpdatedA__2704CA5F DEFAULT (getutcdate()) FOR UpdatedAtUtc");

    await knex.raw("ALTER TABLE dbo.VendorMaterial ADD CONSTRAINT DF__VendorMat__Creat__2AD55B43 DEFAULT (getutcdate()) FOR CreatedAtUtc");

    await knex.raw("ALTER TABLE dbo.VendorMaterial ADD CONSTRAINT DF__VendorMat__Updat__2BC97F7C DEFAULT (getutcdate()) FOR UpdatedAtUtc");

    await knex.raw("ALTER TABLE dbo.ConsignmentDelivery ADD CONSTRAINT UQ_ConsignmentDelivery UNIQUE (MaterialDocument, MaterialDocItem)");

    await knex.raw("ALTER TABLE dbo.ForwarderModeMapping ADD CONSTRAINT UQ_ForwarderModeMapping_ForwarderMode UNIQUE (ForwarderMode)");

    await knex.raw("ALTER TABLE dbo.MaterialGroupMapping ADD CONSTRAINT UQ_MGM_CostElement_ModeKey UNIQUE (CostElement, ModeKey)");

    await knex.raw("ALTER TABLE dbo.NotificationDeliveries ADD CONSTRAINT UQ_Delivery_User UNIQUE (NotificationID, UserID)");

    await knex.raw("ALTER TABLE dbo.PortalUserPermissions ADD CONSTRAINT UQ_UserPermission UNIQUE (UserID, PermissionCode)");

    await knex.raw("ALTER TABLE dbo.sysdiagrams ADD CONSTRAINT UK_principal_name UNIQUE (principal_id, name)");

    await knex.raw("ALTER TABLE dbo.Vendor ADD CONSTRAINT UQ_Vendor_Name UNIQUE (VendorName)");

    await knex.raw("ALTER TABLE dbo.VendorMaterial ADD CONSTRAINT UQ_VendorMaterial UNIQUE (VendorId, Material)");

    await knex.raw("ALTER TABLE dbo.ConsignmentDeclaration ADD CONSTRAINT CK_ConsignmentDeclaration_Method CHECK ([AllocationMethod]='MANUAL' OR [AllocationMethod]='FIFO' OR [AllocationMethod]='FEFO')");

    await knex.raw("ALTER TABLE dbo.ConsignmentDeclaration ADD CONSTRAINT CK_ConsignmentDeclaration_Status CHECK ([Status]='Cancelled' OR [Status]='Confirmed' OR [Status]='Draft')");

    await knex.raw("ALTER TABLE dbo.ConsignmentDelivery ADD CONSTRAINT CK_ConsignmentDelivery_Source CHECK ([Source]='CSV' OR [Source]='MANUAL' OR [Source]='SAP')");

    await knex.raw("ALTER TABLE dbo.ConsignmentVendorConfig ADD CONSTRAINT CK_ConsignmentVendorConfig_Method CHECK ([DefaultAllocationMethod]='MANUAL' OR [DefaultAllocationMethod]='FIFO' OR [DefaultAllocationMethod]='FEFO')");

    await knex.raw("ALTER TABLE dbo.DemandAdjustment ADD CONSTRAINT CK_DemandAdjustment_DateRange CHECK ([EndDate] IS NULL OR [StartDate] IS NULL OR [EndDate]>=[StartDate])");

    await knex.raw("ALTER TABLE dbo.DemandAdjustment ADD CONSTRAINT CK_DemandAdjustment_UsagePercent CHECK ([UsagePercent]>=(0))");

    await knex.raw("ALTER TABLE dbo.PortalUserDepartments ADD CONSTRAINT CK__PortalUse__Depar__56E8E7AB CHECK ([Department]='management' OR [Department]='engineering' OR [Department]='quality' OR [Department]='sales' OR [Department]='finance' OR [Department]='warehouse' OR [Department]='logistics' OR [Department]='production')");

    await knex.raw("ALTER TABLE dbo.PortalUsers ADD CONSTRAINT CK_PortalUsers_Role CHECK ([Role]=N'superadmin' OR [Role]=N'admin' OR [Role]=N'operator')");

    await knex.raw("ALTER TABLE dbo.StagingRequest ADD CONSTRAINT CK_StagingRequest_Qty CHECK ([QuantityRequested]>(0) AND [QuantityDelivered]>=(0))");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_ConsignmentDeclaration_Vendor ON dbo.ConsignmentDeclaration (VendorId, Status)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_ConsignmentDeclarationLine_Declaration ON dbo.ConsignmentDeclarationLine (DeclarationId)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_ConsignmentDeclarationLine_Delivery ON dbo.ConsignmentDeclarationLine (DeliveryId)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_ConsignmentDelivery_VendorMaterial ON dbo.ConsignmentDelivery (VendorId, Material) INCLUDE (InvoiceNumber, DocumentDate, ExpiryDate, RemainingQty)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_DeliveryOrderLink_Order ON dbo.DeliveryOrderLink (OrderNumber)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_DemandAdjustment_Material ON dbo.DemandAdjustment (Material)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_FAL_TargetMonth ON dbo.ForecastAccuracyLog (TargetMonth) INCLUDE (Material, Plant)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Deliveries_NotifID ON dbo.NotificationDeliveries (NotificationID)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_Deliveries_User ON dbo.NotificationDeliveries (UserID, IsDismissed, IsRead)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_OFT_CompletedDate ON dbo.OrderFulfillmentTracking (CompletedDate)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_OFT_RefItemStatus ON dbo.OrderFulfillmentTracking (ReferenceDocument, Item, Status)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_PortalSessions_Expires ON dbo.PortalSessions (ExpiresUtc)");

    await knex.raw("CREATE UNIQUE NONCLUSTERED INDEX UX_UserDept ON dbo.PortalUserDepartments (UserID, Department)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_UserPerms_UserID ON dbo.PortalUserPermissions (UserID)");

    await knex.raw("CREATE UNIQUE NONCLUSTERED INDEX UX_PortalUsers_Email ON dbo.PortalUsers (Email)");

    await knex.raw("CREATE UNIQUE NONCLUSTERED INDEX UX_PortalUsers_Username ON dbo.PortalUsers (Username)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_POS_Material ON dbo.PurchaseOrderSuggestion (Material) INCLUDE (Status, OrderQty, DeliveryDate)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_POS_Shipment ON dbo.PurchaseOrderSuggestion (ShipmentId)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_POS_Status ON dbo.PurchaseOrderSuggestion (Status) INCLUDE (VendorId, Material, OrderDate)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_ScheduledDeployments_DueCheck ON dbo.ScheduledDeployments (Status, ScheduledAt)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_StagingBinRestriction_Material ON dbo.StagingBinRestriction (Material)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_StagingRequest_Material ON dbo.StagingRequest (Material)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_StagingRequest_Status_Due ON dbo.StagingRequest (Status, DueAtUtc) INCLUDE (Material, QuantityRequested, QuantityDelivered, Location, RequestedBatch)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_StagingRequestDelivery_RequestId ON dbo.StagingRequestDelivery (RequestId)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_SVH_SnapshotDate ON dbo.StockValuationHistory (SnapshotDate) INCLUDE (Material, StockQty, StockValue, ConsignmentQty)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_TVC_MaterialType ON dbo.TurnsValClassSnapshot (MaterialType) INCLUDE (Material, StockValue)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_TVC_MrpController ON dbo.TurnsValClassSnapshot (MrpController) INCLUDE (Material, StockValue)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_TVC_ProfitCentre ON dbo.TurnsValClassSnapshot (ProfitCentre) INCLUDE (Material, StockValue)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_TVC_ValuationClass ON dbo.TurnsValClassSnapshot (ValuationClass) INCLUDE (Material, StockValue, BookValue)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_VCCBatch_RequestedAt ON dbo.ValuationClassChangeBatch (RequestedAtUtc DESC)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_VCCDetail_Batch ON dbo.ValuationClassChangeDetail (BatchID)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_VCCDetail_Material ON dbo.ValuationClassChangeDetail (Material) INCLUDE (BatchID, Success)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_VendorMaterial_Material ON dbo.VendorMaterial (Material) INCLUDE (VendorId, MaterialMoqQty, LeadTimeDaysOverride)");

    await knex.raw("ALTER TABLE dbo.ConsignmentDeclaration ADD CONSTRAINT FK_ConsignmentDeclaration_Vendor FOREIGN KEY (VendorId) REFERENCES dbo.Vendor (VendorId)");

    await knex.raw("ALTER TABLE dbo.ConsignmentDeclarationLine ADD CONSTRAINT FK_ConsignmentDeclarationLine_Declaration FOREIGN KEY (DeclarationId) REFERENCES dbo.ConsignmentDeclaration (DeclarationId)");

    await knex.raw("ALTER TABLE dbo.ConsignmentDeclarationLine ADD CONSTRAINT FK_ConsignmentDeclarationLine_Delivery FOREIGN KEY (DeliveryId) REFERENCES dbo.ConsignmentDelivery (DeliveryId)");

    await knex.raw("ALTER TABLE dbo.ConsignmentDelivery ADD CONSTRAINT FK_ConsignmentDelivery_Vendor FOREIGN KEY (VendorId) REFERENCES dbo.Vendor (VendorId)");

    await knex.raw("ALTER TABLE dbo.ConsignmentVendorConfig ADD CONSTRAINT FK_ConsignmentVendorConfig_Vendor FOREIGN KEY (VendorId) REFERENCES dbo.Vendor (VendorId)");

    await knex.raw("ALTER TABLE dbo.FinanceGlGroupAccounts ADD CONSTRAINT FK__FinanceGl__Group__719CDDE7 FOREIGN KEY (GroupID) REFERENCES dbo.FinanceGlGroups (GroupID) ON DELETE CASCADE");

    await knex.raw("ALTER TABLE dbo.NotificationDeliveries ADD CONSTRAINT FK_Deliveries_Notification FOREIGN KEY (NotificationID) REFERENCES dbo.Notifications (NotificationID) ON DELETE CASCADE");

    await knex.raw("ALTER TABLE dbo.NotificationDeliveries ADD CONSTRAINT FK_Deliveries_User FOREIGN KEY (UserID) REFERENCES dbo.PortalUsers (UserID)");

    await knex.raw("ALTER TABLE dbo.PortalUserDepartments ADD CONSTRAINT FK__PortalUse__UserI__55F4C372 FOREIGN KEY (UserID) REFERENCES dbo.PortalUsers (UserID) ON DELETE CASCADE");

    await knex.raw("ALTER TABLE dbo.PortalUserPermissions ADD CONSTRAINT FK_UserPerms_Perm FOREIGN KEY (PermissionCode) REFERENCES dbo.PortalPermissions (PermissionCode)");

    await knex.raw("ALTER TABLE dbo.PortalUserPermissions ADD CONSTRAINT FK_UserPerms_User FOREIGN KEY (UserID) REFERENCES dbo.PortalUsers (UserID)");

    await knex.raw("ALTER TABLE dbo.PurchaseOrderSuggestion ADD CONSTRAINT FK_POS_Shipment FOREIGN KEY (ShipmentId) REFERENCES dbo.PurchaseOrderShipment (ShipmentId)");

    await knex.raw("ALTER TABLE dbo.PurchaseOrderSuggestion ADD CONSTRAINT FK_POS_Vendor FOREIGN KEY (VendorId) REFERENCES dbo.Vendor (VendorId)");

    await knex.raw("ALTER TABLE dbo.PurchaseOrderSuggestion ADD CONSTRAINT FK_POS_VendorMaterial FOREIGN KEY (VendorMaterialId) REFERENCES dbo.VendorMaterial (VendorMaterialId)");

    await knex.raw("ALTER TABLE dbo.StagingRequestDelivery ADD CONSTRAINT FK_SRD_StagingRequest FOREIGN KEY (RequestId) REFERENCES dbo.StagingRequest (RequestId)");

    await knex.raw("ALTER TABLE dbo.ValuationClassChangeDetail ADD CONSTRAINT FK_VCCDetail_Batch FOREIGN KEY (BatchID) REFERENCES dbo.ValuationClassChangeBatch (BatchID)");

    await knex.raw("ALTER TABLE dbo.VendorMaterial ADD CONSTRAINT FK_VendorMaterial_Vendor FOREIGN KEY (VendorId) REFERENCES dbo.Vendor (VendorId)");
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
    await knex.raw('ALTER TABLE dbo.ConsignmentDeclaration DROP CONSTRAINT FK_ConsignmentDeclaration_Vendor');
    await knex.raw('ALTER TABLE dbo.ConsignmentDeclarationLine DROP CONSTRAINT FK_ConsignmentDeclarationLine_Declaration');
    await knex.raw('ALTER TABLE dbo.ConsignmentDeclarationLine DROP CONSTRAINT FK_ConsignmentDeclarationLine_Delivery');
    await knex.raw('ALTER TABLE dbo.ConsignmentDelivery DROP CONSTRAINT FK_ConsignmentDelivery_Vendor');
    await knex.raw('ALTER TABLE dbo.ConsignmentVendorConfig DROP CONSTRAINT FK_ConsignmentVendorConfig_Vendor');
    await knex.raw('ALTER TABLE dbo.FinanceGlGroupAccounts DROP CONSTRAINT FK__FinanceGl__Group__719CDDE7');
    await knex.raw('ALTER TABLE dbo.NotificationDeliveries DROP CONSTRAINT FK_Deliveries_Notification');
    await knex.raw('ALTER TABLE dbo.NotificationDeliveries DROP CONSTRAINT FK_Deliveries_User');
    await knex.raw('ALTER TABLE dbo.PortalUserDepartments DROP CONSTRAINT FK__PortalUse__UserI__55F4C372');
    await knex.raw('ALTER TABLE dbo.PortalUserPermissions DROP CONSTRAINT FK_UserPerms_Perm');
    await knex.raw('ALTER TABLE dbo.PortalUserPermissions DROP CONSTRAINT FK_UserPerms_User');
    await knex.raw('ALTER TABLE dbo.PurchaseOrderSuggestion DROP CONSTRAINT FK_POS_Shipment');
    await knex.raw('ALTER TABLE dbo.PurchaseOrderSuggestion DROP CONSTRAINT FK_POS_Vendor');
    await knex.raw('ALTER TABLE dbo.PurchaseOrderSuggestion DROP CONSTRAINT FK_POS_VendorMaterial');
    await knex.raw('ALTER TABLE dbo.StagingRequestDelivery DROP CONSTRAINT FK_SRD_StagingRequest');
    await knex.raw('ALTER TABLE dbo.ValuationClassChangeDetail DROP CONSTRAINT FK_VCCDetail_Batch');
    await knex.raw('ALTER TABLE dbo.VendorMaterial DROP CONSTRAINT FK_VendorMaterial_Vendor');

    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.AgreementSnapshot') AND type = 'U') DROP TABLE dbo.AgreementSnapshot");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ConsignmentCustomer') AND type = 'U') DROP TABLE dbo.ConsignmentCustomer");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ConsignmentDeclaration') AND type = 'U') DROP TABLE dbo.ConsignmentDeclaration");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ConsignmentDeclarationLine') AND type = 'U') DROP TABLE dbo.ConsignmentDeclarationLine");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ConsignmentDelivery') AND type = 'U') DROP TABLE dbo.ConsignmentDelivery");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ConsignmentStockSnapshot') AND type = 'U') DROP TABLE dbo.ConsignmentStockSnapshot");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ConsignmentVendorConfig') AND type = 'U') DROP TABLE dbo.ConsignmentVendorConfig");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.CustomerStandardInstructions') AND type = 'U') DROP TABLE dbo.CustomerStandardInstructions");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.DailyPerformance') AND type = 'U') DROP TABLE dbo.DailyPerformance");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.DeliveryOrderLink') AND type = 'U') DROP TABLE dbo.DeliveryOrderLink");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.DemandAdjustment') AND type = 'U') DROP TABLE dbo.DemandAdjustment");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.FinanceGlGroupAccounts') AND type = 'U') DROP TABLE dbo.FinanceGlGroupAccounts");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.FinanceGlGroups') AND type = 'U') DROP TABLE dbo.FinanceGlGroups");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ForecastAccuracyLog') AND type = 'U') DROP TABLE dbo.ForecastAccuracyLog");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ForwarderModeMapping') AND type = 'U') DROP TABLE dbo.ForwarderModeMapping");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.InvoiceSnapshot') AND type = 'U') DROP TABLE dbo.InvoiceSnapshot");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.MaterialGroupMapping') AND type = 'U') DROP TABLE dbo.MaterialGroupMapping");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.NotificationDeliveries') AND type = 'U') DROP TABLE dbo.NotificationDeliveries");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.Notifications') AND type = 'U') DROP TABLE dbo.Notifications");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.OrderBookLineNotes') AND type = 'U') DROP TABLE dbo.OrderBookLineNotes");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.OrderFulfillmentTracking') AND type = 'U') DROP TABLE dbo.OrderFulfillmentTracking");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.OtifSnapshot') AND type = 'U') DROP TABLE dbo.OtifSnapshot");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalAuditLog') AND type = 'U') DROP TABLE dbo.PortalAuditLog");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalPermissions') AND type = 'U') DROP TABLE dbo.PortalPermissions");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalSessions') AND type = 'U') DROP TABLE dbo.PortalSessions");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalUserDepartments') AND type = 'U') DROP TABLE dbo.PortalUserDepartments");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalUserPermissions') AND type = 'U') DROP TABLE dbo.PortalUserPermissions");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalUsers') AND type = 'U') DROP TABLE dbo.PortalUsers");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ProductionScheduleComments') AND type = 'U') DROP TABLE dbo.ProductionScheduleComments");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PurchaseOrderShipment') AND type = 'U') DROP TABLE dbo.PurchaseOrderShipment");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PurchaseOrderSuggestion') AND type = 'U') DROP TABLE dbo.PurchaseOrderSuggestion");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.RefreshLog') AND type = 'U') DROP TABLE dbo.RefreshLog");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ScheduledDeployments') AND type = 'U') DROP TABLE dbo.ScheduledDeployments");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ScrapReasons') AND type = 'U') DROP TABLE dbo.ScrapReasons");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.Staging') AND type = 'U') DROP TABLE dbo.Staging");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.StagingBinRestriction') AND type = 'U') DROP TABLE dbo.StagingBinRestriction");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.StagingItems') AND type = 'U') DROP TABLE dbo.StagingItems");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.StagingRequest') AND type = 'U') DROP TABLE dbo.StagingRequest");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.StagingRequestDelivery') AND type = 'U') DROP TABLE dbo.StagingRequestDelivery");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.StockSnapshot') AND type = 'U') DROP TABLE dbo.StockSnapshot");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.StockValuationHistory') AND type = 'U') DROP TABLE dbo.StockValuationHistory");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.sysdiagrams') AND type = 'U') DROP TABLE dbo.sysdiagrams");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.TurnsValClassSnapshot') AND type = 'U') DROP TABLE dbo.TurnsValClassSnapshot");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ValuationClassCatalog') AND type = 'U') DROP TABLE dbo.ValuationClassCatalog");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ValuationClassChangeBatch') AND type = 'U') DROP TABLE dbo.ValuationClassChangeBatch");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ValuationClassChangeDetail') AND type = 'U') DROP TABLE dbo.ValuationClassChangeDetail");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.Vendor') AND type = 'U') DROP TABLE dbo.Vendor");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.VendorMaterial') AND type = 'U') DROP TABLE dbo.VendorMaterial");
};
