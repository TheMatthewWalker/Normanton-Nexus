'use strict';
// Initial schema migration for Logistics (shipping/warehouse) — generated from a live extraction
// of the current production database (sql/generate_schema_script.sql, run
// via the admin.html SQL Console) on 2026-08-04. Reproduces every base
// table, DEFAULT/UNIQUE/CHECK constraint, non-PK index, and foreign key —
// see migrations/README.md for what's deliberately excluded and why.
//
// Schema only — no data. Reference/lookup data seeding is a separate,
// later migration once that's been decided per table.

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.AssignmentTPN') AND type = 'U')\r\nCREATE TABLE dbo.AssignmentTPN (\r\n    postalZone NVARCHAR(10) NULL\r\n,    postalCode NVARCHAR(10) NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.CostCenters') AND type = 'U')\r\nCREATE TABLE dbo.CostCenters (\r\n    centerID BIGINT NULL\r\n,    centerDescription NVARCHAR(50) NULL\r\n,    centerCode NVARCHAR(10) NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.CostElements') AND type = 'U')\r\nCREATE TABLE dbo.CostElements (\r\n    elementID BIGINT NULL\r\n,    elementDescription NVARCHAR(50) NULL\r\n,    elementCode NVARCHAR(6) NULL\r\n,    direction NVARCHAR(10) NULL\r\n,    tier NVARCHAR(10) NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.CostTypes') AND type = 'U')\r\nCREATE TABLE dbo.CostTypes (\r\n    typeID BIGINT NULL\r\n,    typeDescription NVARCHAR(50) NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.DeliveryLink') AND type = 'U')\r\nCREATE TABLE dbo.DeliveryLink (\r\n    deliveryID INT NOT NULL\r\n,    palletID INT NOT NULL\r\n,\r\n    CONSTRAINT PK_DeliveryLink PRIMARY KEY (deliveryID, palletID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.DeliveryMain') AND type = 'U')\r\nCREATE TABLE dbo.DeliveryMain (\r\n    deliveryID BIGINT NULL\r\n,    customerID BIGINT NULL\r\n,    dispatchDate DATETIME NULL\r\n,    completionDate DATETIME NULL\r\n,    completionStatus BIT NULL\r\n,    operatorName NVARCHAR(50) NULL\r\n,    supervisorName NVARCHAR(50) NULL\r\n,    netWeight DECIMAL(18,0) NULL\r\n,    grossWeight DECIMAL(18,0) NULL\r\n,    palletCount DECIMAL(18,0) NULL\r\n,    deliveryVolume DECIMAL(18,0) NULL\r\n,    picksheetComment NVARCHAR(50) NULL\r\n,    deliveryCancelled BIT NULL\r\n,    deliveryPriority INT NULL\r\n,    deliveryService NVARCHAR(50) NULL\r\n,    incoterms NVARCHAR(3) NULL\r\n,    deliveryDate DATETIME NULL\r\n,    pendingPackagingData BIT NOT NULL\r\n,    movedToHoldingAtUtc DATETIME NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.DeliveryRoutes') AND type = 'U')\r\nCREATE TABLE dbo.DeliveryRoutes (\r\n    routeID INT IDENTITY(1,1) NOT NULL\r\n,    countryCode NVARCHAR(10) NOT NULL\r\n,    postcodePrefix NVARCHAR(5) NULL\r\n,    transitDays INT NOT NULL\r\n,\r\n    CONSTRAINT PK__DeliveryRoutes__5CD6CB2B PRIMARY KEY (routeID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.DeliveryZdelflagRun') AND type = 'U')\r\nCREATE TABLE dbo.DeliveryZdelflagRun (\r\n    runID INT IDENTITY(1,1) NOT NULL\r\n,    deliveryID NVARCHAR(10) NOT NULL\r\n,    status NVARCHAR(10) NOT NULL\r\n,    messages NVARCHAR(MAX) NULL\r\n,    ranAtUtc DATETIME NOT NULL\r\n,    ranByUserID INT NULL\r\n,\r\n    CONSTRAINT PK_DeliveryZdelflagRun PRIMARY KEY (runID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.Destinations') AND type = 'U')\r\nCREATE TABLE dbo.Destinations (\r\n    destinationID BIGINT NULL\r\n,    destinationName NVARCHAR(50) NULL\r\n,    destinationStreet NVARCHAR(100) NULL\r\n,    destinationCity NVARCHAR(50) NULL\r\n,    destinationPostCode NVARCHAR(50) NULL\r\n,    destinationCountry NVARCHAR(50) NULL\r\n,    defaultIncoterms NVARCHAR(3) NULL\r\n,    destinationComment NVARCHAR(50) NULL\r\n,    destinationZone NVARCHAR(10) NULL\r\n,    defaultDeliveryService NVARCHAR(100) NULL\r\n,    defaultForwarder NVARCHAR(50) NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.Email') AND type = 'U')\r\nCREATE TABLE dbo.Email (\r\n    ID BIGINT NOT NULL\r\n,    address NVARCHAR(100) NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ForwarderApproval') AND type = 'U')\r\nCREATE TABLE dbo.ForwarderApproval (\r\n    forwarderID BIGINT NULL\r\n,    ratesAgreed BIT NULL\r\n,    usageAgreed BIT NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.Forwarders') AND type = 'U')\r\nCREATE TABLE dbo.Forwarders (\r\n    forwarderID BIGINT NULL\r\n,    forwarderName NVARCHAR(50) NULL\r\n,    forwarderApproval BIT NULL\r\n,    forwarderMode NVARCHAR(50) NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.Incoterms') AND type = 'U')\r\nCREATE TABLE dbo.Incoterms (\r\n    incotermsID NVARCHAR(3) NULL\r\n,    incotermsDescription NVARCHAR(50) NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ManualCargoItem') AND type = 'U')\r\nCREATE TABLE dbo.ManualCargoItem (\r\n    CargoID INT IDENTITY(1,1) NOT NULL\r\n,    ShipmentID BIGINT NOT NULL\r\n,    Description NVARCHAR(200) NULL\r\n,    PackageCount INT NOT NULL\r\n,    Weight DECIMAL(18,3) NOT NULL\r\n,    Length DECIMAL(18,2) NULL\r\n,    Width DECIMAL(18,2) NULL\r\n,    Height DECIMAL(18,2) NULL\r\n,    Volume DECIMAL(18,3) NULL\r\n,    Removed BIT NOT NULL\r\n,    CreatedAtUtc DATETIME NOT NULL\r\n,    CreatedBy NVARCHAR(100) NULL\r\n,\r\n    CONSTRAINT PK_ManualCargoItem PRIMARY KEY (CargoID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PackagingData') AND type = 'U')\r\nCREATE TABLE dbo.PackagingData (\r\n    packID NVARCHAR(3) NOT NULL\r\n,    packMaterial NVARCHAR(50) NULL\r\n,    packDescription NVARCHAR(50) NULL\r\n,    packWeight DECIMAL(18,3) NULL\r\n,    packLength INT NULL\r\n,    packWidth INT NULL\r\n,    packHeight INT NULL\r\n,\r\n    CONSTRAINT PK_PackagingData PRIMARY KEY (packID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PalletData') AND type = 'U')\r\nCREATE TABLE dbo.PalletData (\r\n    palletID NVARCHAR(2) NOT NULL\r\n,    palletDescription NVARCHAR(50) NULL\r\n,    palletWeight DECIMAL(18,3) NULL\r\n,    palletLength INT NULL\r\n,    palletWidth INT NULL\r\n,    palletHeight INT NULL\r\n,\r\n    CONSTRAINT PK_PalletData PRIMARY KEY (palletID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PalletMain') AND type = 'U')\r\nCREATE TABLE dbo.PalletMain (\r\n    palletID INT IDENTITY(1,1) NOT NULL\r\n,    palletType NVARCHAR(2) NULL\r\n,    palletFinish BIT NOT NULL\r\n,    packagingWeight DECIMAL(18,3) NOT NULL\r\n,    grossWeight DECIMAL(18,3) NOT NULL\r\n,    palletVolume DECIMAL(18,3) NOT NULL\r\n,    palletLength INT NOT NULL\r\n,    palletWidth INT NOT NULL\r\n,    palletHeight INT NOT NULL\r\n,    palletRemoved BIT NOT NULL\r\n,    palletCategory NVARCHAR(2) NULL\r\n,    palletLocation NVARCHAR(50) NULL\r\n,    palletCreationDate DATETIME NULL\r\n,    palletFinishDate DATETIME NULL\r\n,\r\n    CONSTRAINT PK_PalletMain PRIMARY KEY (palletID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PalletPackages') AND type = 'U')\r\nCREATE TABLE dbo.PalletPackages (\r\n    palletItemID INT IDENTITY(1,1) NOT NULL\r\n,    palletID INT NOT NULL\r\n,    packagingID NVARCHAR(3) NULL\r\n,    palletLayer INT NULL\r\n,    sapMaterial NVARCHAR(18) NULL\r\n,    sapQuantity DECIMAL(18,3) NULL\r\n,    sapBatch NVARCHAR(10) NULL\r\n,    sapDelivery NVARCHAR(10) NULL\r\n,    sapDeliveryItem NVARCHAR(6) NULL\r\n,    sapCustomer NVARCHAR(10) NULL\r\n,    sapCustomerMaterial NVARCHAR(18) NULL\r\n,    scanTime DATETIME NULL\r\n,    sapSourceStorageType NVARCHAR(3) NULL\r\n,    sapSourceBin NVARCHAR(10) NULL\r\n,    sapStageTransferOrder NVARCHAR(10) NULL\r\n,    sapPackagingInstruction NVARCHAR(40) NULL\r\n,\r\n    CONSTRAINT PK_PalletPackages PRIMARY KEY (palletItemID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PalletValidation') AND type = 'U')\r\nCREATE TABLE dbo.PalletValidation (\r\n    palletID NVARCHAR(2) NOT NULL\r\n,    packagingID NVARCHAR(3) NOT NULL\r\n,\r\n    CONSTRAINT PK_PalletValidation PRIMARY KEY (palletID, packagingID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalAuditLog') AND type = 'U')\r\nCREATE TABLE dbo.PortalAuditLog (\r\n    LogID INT IDENTITY(1,1) NOT NULL\r\n,    EventTime DATETIME NOT NULL\r\n,    Username NVARCHAR(80) NULL\r\n,    EventType NVARCHAR(50) NOT NULL\r\n,    Detail NVARCHAR(500) NULL\r\n,    IPAddress NVARCHAR(45) NULL\r\n,\r\n    CONSTRAINT PK_PortalAuditLog PRIMARY KEY (LogID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.RatesKN') AND type = 'U')\r\nCREATE TABLE dbo.RatesKN (\r\n    countryCode NVARCHAR(2) NULL\r\n,    postalCode NVARCHAR(10) NULL\r\n,    minWeight INT NULL\r\n,    maxWeight INT NULL\r\n,    agreedRate DECIMAL(18,0) NULL\r\n,    transitTime INT NULL\r\n,    minimumCharge DECIMAL(18,2) NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.RatesTPN') AND type = 'U')\r\nCREATE TABLE dbo.RatesTPN (\r\n    postalZone NVARCHAR(10) NULL\r\n,    palletCategory NVARCHAR(2) NULL\r\n,    serviceLevel NVARCHAR(2) NULL\r\n,    agreedRate DECIMAL(18,0) NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ShipmentCost') AND type = 'U')\r\nCREATE TABLE dbo.ShipmentCost (\r\n    shipmentID BIGINT NULL\r\n,    costType NVARCHAR(3) NULL\r\n,    costElement NVARCHAR(6) NULL\r\n,    costCenter NVARCHAR(10) NULL\r\n,    expectedCost DECIMAL(18,0) NULL\r\n,    actualCost DECIMAL(18,0) NULL\r\n,    migoStatus BIT NULL\r\n,    materialDocument NVARCHAR(10) NULL\r\n,    costID BIGINT IDENTITY(1,1) NOT NULL\r\n,    poShipmentID INT NULL\r\n,    modeOfTransport NVARCHAR(20) NULL\r\n,    purchaseOrder NVARCHAR(20) NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ShipmentEvents') AND type = 'U')\r\nCREATE TABLE dbo.ShipmentEvents (\r\n    EventID INT IDENTITY(1,1) NOT NULL\r\n,    shipmentID BIGINT NOT NULL\r\n,    eventCategory NVARCHAR(50) NOT NULL\r\n,    eventDescription NVARCHAR(500) NOT NULL\r\n,    timeStamp DATETIME NOT NULL\r\n,\r\n    CONSTRAINT PK_ShipmentEvents PRIMARY KEY (EventID)\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ShipmentLink') AND type = 'U')\r\nCREATE TABLE dbo.ShipmentLink (\r\n    shipmentID BIGINT NULL\r\n,    deliveryID BIGINT NULL\r\n\r\n)");

    await knex.raw("IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ShipmentMain') AND type = 'U')\r\nCREATE TABLE dbo.ShipmentMain (\r\n    originID BIGINT NULL\r\n,    originName NVARCHAR(50) NULL\r\n,    originStreet NVARCHAR(50) NULL\r\n,    originCity NVARCHAR(50) NULL\r\n,    originPostCode NVARCHAR(50) NULL\r\n,    originCountry NVARCHAR(50) NULL\r\n,    destinationID BIGINT NULL\r\n,    destinationName NVARCHAR(50) NULL\r\n,    destinationStreet NVARCHAR(100) NULL\r\n,    destinationCity NVARCHAR(50) NULL\r\n,    destinationPostCode NVARCHAR(50) NULL\r\n,    destinationCountry NVARCHAR(50) NULL\r\n,    netWeight DECIMAL(18,0) NULL\r\n,    grossWeight DECIMAL(18,0) NULL\r\n,    palletCount BIGINT NULL\r\n,    shipmentVolume DECIMAL(18,0) NULL\r\n,    plannedCollection DATETIME NULL\r\n,    actualCollection DATETIME NULL\r\n,    collectionStatus BIT NULL\r\n,    forwarderID BIGINT NULL\r\n,    trackingNumber NVARCHAR(50) NULL\r\n,    incoTerms NVARCHAR(3) NULL\r\n,    customsRequired BIT NULL\r\n,    customsComplete BIT NULL\r\n,    shipmentCancelled BIT NULL\r\n,    shipmentID BIGINT IDENTITY(1,1) NOT NULL\r\n,    PlannedDelivery DATETIME NULL\r\n,    ActualDelivery DATETIME NULL\r\n,    DeliveryStatus BIT NULL\r\n,    bookingStatus BIT NULL\r\n,    customsID NVARCHAR(50) NULL\r\n,    IsManual BIT NOT NULL\r\n\r\n)");

    await knex.raw("ALTER TABLE dbo.DeliveryMain ADD CONSTRAINT DF__DeliveryM__compl__145C0A3F DEFAULT ((0)) FOR completionStatus");

    await knex.raw("ALTER TABLE dbo.DeliveryMain ADD CONSTRAINT DF__DeliveryM__netWe__15502E78 DEFAULT ((0)) FOR netWeight");

    await knex.raw("ALTER TABLE dbo.DeliveryMain ADD CONSTRAINT DF__DeliveryM__gross__164452B1 DEFAULT ((0)) FOR grossWeight");

    await knex.raw("ALTER TABLE dbo.DeliveryMain ADD CONSTRAINT DF__DeliveryM__palle__173876EA DEFAULT ((0)) FOR palletCount");

    await knex.raw("ALTER TABLE dbo.DeliveryMain ADD CONSTRAINT DF__DeliveryM__deliv__182C9B23 DEFAULT ((0)) FOR deliveryVolume");

    await knex.raw("ALTER TABLE dbo.DeliveryMain ADD CONSTRAINT DF__DeliveryM__deliv__1920BF5C DEFAULT ((0)) FOR deliveryCancelled");

    await knex.raw("ALTER TABLE dbo.DeliveryMain ADD CONSTRAINT DF__DeliveryM__deliv__1A14E395 DEFAULT ((0)) FOR deliveryPriority");

    await knex.raw("ALTER TABLE dbo.DeliveryMain ADD CONSTRAINT DF_DeliveryMain_PendingPkg DEFAULT ((0)) FOR pendingPackagingData");

    await knex.raw("ALTER TABLE dbo.DeliveryZdelflagRun ADD CONSTRAINT DF_DelZdelflagRun_RanAt DEFAULT (getutcdate()) FOR ranAtUtc");

    await knex.raw("ALTER TABLE dbo.ForwarderApproval ADD CONSTRAINT DF__Forwarder__rates__286302EC DEFAULT ((0)) FOR ratesAgreed");

    await knex.raw("ALTER TABLE dbo.ForwarderApproval ADD CONSTRAINT DF__Forwarder__usage__29572725 DEFAULT ((0)) FOR usageAgreed");

    await knex.raw("ALTER TABLE dbo.Forwarders ADD CONSTRAINT DF__Forwarder__forwa__117F9D94 DEFAULT ((0)) FOR forwarderApproval");

    await knex.raw("ALTER TABLE dbo.ManualCargoItem ADD CONSTRAINT DF__ManualCar__Packa__656C112C DEFAULT ((1)) FOR PackageCount");

    await knex.raw("ALTER TABLE dbo.ManualCargoItem ADD CONSTRAINT DF__ManualCar__Weigh__66603565 DEFAULT ((0)) FOR Weight");

    await knex.raw("ALTER TABLE dbo.ManualCargoItem ADD CONSTRAINT DF__ManualCar__Remov__6754599E DEFAULT ((0)) FOR Removed");

    await knex.raw("ALTER TABLE dbo.ManualCargoItem ADD CONSTRAINT DF__ManualCar__Creat__68487DD7 DEFAULT (getutcdate()) FOR CreatedAtUtc");

    await knex.raw("ALTER TABLE dbo.PalletMain ADD CONSTRAINT DF_PalletMain_Finish DEFAULT ((0)) FOR palletFinish");

    await knex.raw("ALTER TABLE dbo.PalletMain ADD CONSTRAINT DF_PalletMain_PkgWt DEFAULT ((0)) FOR packagingWeight");

    await knex.raw("ALTER TABLE dbo.PalletMain ADD CONSTRAINT DF_PalletMain_GrossWt DEFAULT ((0)) FOR grossWeight");

    await knex.raw("ALTER TABLE dbo.PalletMain ADD CONSTRAINT DF_PalletMain_Vol DEFAULT ((0)) FOR palletVolume");

    await knex.raw("ALTER TABLE dbo.PalletMain ADD CONSTRAINT DF_PalletMain_Len DEFAULT ((0)) FOR palletLength");

    await knex.raw("ALTER TABLE dbo.PalletMain ADD CONSTRAINT DF_PalletMain_Wid DEFAULT ((0)) FOR palletWidth");

    await knex.raw("ALTER TABLE dbo.PalletMain ADD CONSTRAINT DF_PalletMain_Hgt DEFAULT ((0)) FOR palletHeight");

    await knex.raw("ALTER TABLE dbo.PalletMain ADD CONSTRAINT DF_PalletMain_Removed DEFAULT ((0)) FOR palletRemoved");

    await knex.raw("ALTER TABLE dbo.PortalAuditLog ADD CONSTRAINT DF_PortalAuditLog_EventTime DEFAULT (getdate()) FOR EventTime");

    await knex.raw("ALTER TABLE dbo.ShipmentCost ADD CONSTRAINT DF__ShipmentC__expec__0AD2A005 DEFAULT ((0)) FOR expectedCost");

    await knex.raw("ALTER TABLE dbo.ShipmentCost ADD CONSTRAINT DF__ShipmentC__actua__0BC6C43E DEFAULT ((0)) FOR actualCost");

    await knex.raw("ALTER TABLE dbo.ShipmentCost ADD CONSTRAINT DF__ShipmentC__migoS__0CBAE877 DEFAULT ((0)) FOR migoStatus");

    await knex.raw("ALTER TABLE dbo.ShipmentEvents ADD CONSTRAINT DF_ShipmentEvents_timeStamp DEFAULT (getdate()) FOR timeStamp");

    await knex.raw("ALTER TABLE dbo.ShipmentMain ADD CONSTRAINT DF__ShipmentM__netWe__014935CB DEFAULT ((0)) FOR netWeight");

    await knex.raw("ALTER TABLE dbo.ShipmentMain ADD CONSTRAINT DF__ShipmentM__gross__023D5A04 DEFAULT ((0)) FOR grossWeight");

    await knex.raw("ALTER TABLE dbo.ShipmentMain ADD CONSTRAINT DF__ShipmentM__palle__03317E3D DEFAULT ((0)) FOR palletCount");

    await knex.raw("ALTER TABLE dbo.ShipmentMain ADD CONSTRAINT DF__ShipmentM__shipm__0425A276 DEFAULT ((0)) FOR shipmentVolume");

    await knex.raw("ALTER TABLE dbo.ShipmentMain ADD CONSTRAINT DF__ShipmentM__custo__0519C6AF DEFAULT ((0)) FOR customsRequired");

    await knex.raw("ALTER TABLE dbo.ShipmentMain ADD CONSTRAINT DF__ShipmentM__custo__060DEAE8 DEFAULT ((0)) FOR customsComplete");

    await knex.raw("ALTER TABLE dbo.ShipmentMain ADD CONSTRAINT DF__ShipmentM__shipm__07020F21 DEFAULT ((0)) FOR shipmentCancelled");

    await knex.raw("ALTER TABLE dbo.ShipmentMain ADD CONSTRAINT DF__ShipmentM__booki__30F848ED DEFAULT ((0)) FOR bookingStatus");

    await knex.raw("ALTER TABLE dbo.ShipmentMain ADD CONSTRAINT DF__ShipmentM__IsMan__628FA481 DEFAULT ((0)) FOR IsManual");

    await knex.raw("ALTER TABLE dbo.DeliveryRoutes ADD CONSTRAINT UQ_DeliveryRoutes UNIQUE (countryCode, postcodePrefix)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_DeliveryLink_Delivery ON dbo.DeliveryLink (deliveryID)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_DeliveryLink_Pallet ON dbo.DeliveryLink (palletID)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_DeliveryZdelflagRun_Delivery ON dbo.DeliveryZdelflagRun (deliveryID, ranAtUtc DESC)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_ManualCargoItem_Shipment ON dbo.ManualCargoItem (ShipmentID)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_PalletMain_Type ON dbo.PalletMain (palletType) INCLUDE (palletFinish, palletRemoved, palletLocation)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_PalletPkg_PalletID ON dbo.PalletPackages (palletID) INCLUDE (packagingID, palletLayer, sapMaterial, sapQuantity)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_ShipmentCost_poShipmentID ON dbo.ShipmentCost (poShipmentID)");

    await knex.raw("CREATE NONCLUSTERED INDEX IX_ShipmentEvents_shipmentID ON dbo.ShipmentEvents (shipmentID)");

    await knex.raw("ALTER TABLE dbo.DeliveryLink ADD CONSTRAINT FK_DeliveryLink_Pallet FOREIGN KEY (palletID) REFERENCES dbo.PalletMain (palletID)");

    await knex.raw("ALTER TABLE dbo.PalletPackages ADD CONSTRAINT FK_PalletPkg_Pallet FOREIGN KEY (palletID) REFERENCES dbo.PalletMain (palletID)");
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
    await knex.raw('ALTER TABLE dbo.DeliveryLink DROP CONSTRAINT FK_DeliveryLink_Pallet');
    await knex.raw('ALTER TABLE dbo.PalletPackages DROP CONSTRAINT FK_PalletPkg_Pallet');

    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.AssignmentTPN') AND type = 'U') DROP TABLE dbo.AssignmentTPN");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.CostCenters') AND type = 'U') DROP TABLE dbo.CostCenters");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.CostElements') AND type = 'U') DROP TABLE dbo.CostElements");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.CostTypes') AND type = 'U') DROP TABLE dbo.CostTypes");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.DeliveryLink') AND type = 'U') DROP TABLE dbo.DeliveryLink");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.DeliveryMain') AND type = 'U') DROP TABLE dbo.DeliveryMain");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.DeliveryRoutes') AND type = 'U') DROP TABLE dbo.DeliveryRoutes");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.DeliveryZdelflagRun') AND type = 'U') DROP TABLE dbo.DeliveryZdelflagRun");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.Destinations') AND type = 'U') DROP TABLE dbo.Destinations");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.Email') AND type = 'U') DROP TABLE dbo.Email");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ForwarderApproval') AND type = 'U') DROP TABLE dbo.ForwarderApproval");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.Forwarders') AND type = 'U') DROP TABLE dbo.Forwarders");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.Incoterms') AND type = 'U') DROP TABLE dbo.Incoterms");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ManualCargoItem') AND type = 'U') DROP TABLE dbo.ManualCargoItem");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PackagingData') AND type = 'U') DROP TABLE dbo.PackagingData");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PalletData') AND type = 'U') DROP TABLE dbo.PalletData");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PalletMain') AND type = 'U') DROP TABLE dbo.PalletMain");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PalletPackages') AND type = 'U') DROP TABLE dbo.PalletPackages");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PalletValidation') AND type = 'U') DROP TABLE dbo.PalletValidation");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalAuditLog') AND type = 'U') DROP TABLE dbo.PortalAuditLog");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.RatesKN') AND type = 'U') DROP TABLE dbo.RatesKN");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.RatesTPN') AND type = 'U') DROP TABLE dbo.RatesTPN");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ShipmentCost') AND type = 'U') DROP TABLE dbo.ShipmentCost");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ShipmentEvents') AND type = 'U') DROP TABLE dbo.ShipmentEvents");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ShipmentLink') AND type = 'U') DROP TABLE dbo.ShipmentLink");
    await knex.raw("IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.ShipmentMain') AND type = 'U') DROP TABLE dbo.ShipmentMain");
};
