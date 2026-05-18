/* ============================================================
   Logistics migration — correct table structures for pallet builder.

   Changes applied:
   - PackagingData.packID        NVARCHAR(2) → NVARCHAR(3)  (XXL is 3 chars)
   - PalletValidation.packagingID NVARCHAR(2) → NVARCHAR(3)
   - PalletPackages.packagingID   NVARCHAR(2) → NVARCHAR(3)
   - PalletMain.palletID          → INT IDENTITY
   - PalletPackages.palletItemID  → INT IDENTITY
   - DeliveryLink.palletID        → INT (matches PalletMain)

   Drop order respects FK dependencies.
   No data is preserved — run test_data_logistics.sql afterwards.

   Do NOT run migrate_logistics_packagingid.sql — that script was
   based on a misunderstanding and should be ignored.

   Run connected to the Logistics database.
   ============================================================ */

USE Logistics;


/* ── Drop tables in FK-safe order ────────────────────────────────────────── */

IF OBJECT_ID(N'dbo.PalletPackages',  N'U') IS NOT NULL DROP TABLE dbo.PalletPackages;
IF OBJECT_ID(N'dbo.DeliveryLink',    N'U') IS NOT NULL DROP TABLE dbo.DeliveryLink;
IF OBJECT_ID(N'dbo.PalletMain',      N'U') IS NOT NULL DROP TABLE dbo.PalletMain;
IF OBJECT_ID(N'dbo.PalletValidation',N'U') IS NOT NULL DROP TABLE dbo.PalletValidation;
IF OBJECT_ID(N'dbo.PackagingData',   N'U') IS NOT NULL DROP TABLE dbo.PackagingData;
IF OBJECT_ID(N'dbo.PalletData',      N'U') IS NOT NULL DROP TABLE dbo.PalletData;


/* ── PackagingData ───────────────────────────────────────────────────────── */
/* packID NVARCHAR(3) — accommodates 3-char codes such as XXL               */

CREATE TABLE dbo.PackagingData (
    packID          NVARCHAR(3)   NOT NULL,
    packMaterial    NVARCHAR(50)  NULL,
    packDescription NVARCHAR(50)  NULL,
    packWeight      DECIMAL(18,3) NULL,
    packLength      INT           NULL,
    packWidth       INT           NULL,
    packHeight      INT           NULL,
    CONSTRAINT PK_PackagingData PRIMARY KEY (packID)
);


/* ── PalletData ──────────────────────────────────────────────────────────── */

CREATE TABLE dbo.PalletData (
    palletID          NVARCHAR(2)   NOT NULL,
    palletDescription NVARCHAR(50)  NULL,
    palletWeight      DECIMAL(18,3) NULL,
    palletLength      INT           NULL,
    palletWidth       INT           NULL,
    palletHeight      INT           NULL,
    CONSTRAINT PK_PalletData PRIMARY KEY (palletID)
);


/* ── PalletValidation ────────────────────────────────────────────────────── */
/* palletID NVARCHAR(2) → PalletData; packagingID NVARCHAR(3) → PackagingData */

CREATE TABLE dbo.PalletValidation (
    palletID    NVARCHAR(2)  NOT NULL,
    packagingID NVARCHAR(3)  NOT NULL,
    CONSTRAINT PK_PalletValidation PRIMARY KEY (palletID, packagingID)
);


/* ── PalletMain ──────────────────────────────────────────────────────────── */

CREATE TABLE dbo.PalletMain (
    palletID           INT           NOT NULL IDENTITY(1,1),
    palletType         NVARCHAR(2)   NULL,
    palletFinish       BIT           NOT NULL CONSTRAINT DF_PalletMain_Finish    DEFAULT 0,
    packagingWeight    DECIMAL(18,3) NOT NULL CONSTRAINT DF_PalletMain_PkgWt     DEFAULT 0,
    grossWeight        DECIMAL(18,3) NOT NULL CONSTRAINT DF_PalletMain_GrossWt   DEFAULT 0,
    palletVolume       DECIMAL(18,3) NOT NULL CONSTRAINT DF_PalletMain_Vol       DEFAULT 0,
    palletLength       INT           NOT NULL CONSTRAINT DF_PalletMain_Len       DEFAULT 0,
    palletWidth        INT           NOT NULL CONSTRAINT DF_PalletMain_Wid       DEFAULT 0,
    palletHeight       INT           NOT NULL CONSTRAINT DF_PalletMain_Hgt       DEFAULT 0,
    palletRemoved      BIT           NOT NULL CONSTRAINT DF_PalletMain_Removed   DEFAULT 0,
    palletCategory     NVARCHAR(2)   NULL,
    palletLocation     NVARCHAR(50)  NULL,
    palletCreationDate DATETIME      NULL,
    palletFinishDate   DATETIME      NULL,
    CONSTRAINT PK_PalletMain PRIMARY KEY (palletID)
);

CREATE INDEX IX_PalletMain_Type ON dbo.PalletMain (palletType)
    INCLUDE (palletFinish, palletLocation, palletRemoved);


/* ── DeliveryLink ────────────────────────────────────────────────────────── */

CREATE TABLE dbo.DeliveryLink (
    deliveryID INT NOT NULL,
    palletID   INT NOT NULL,
    CONSTRAINT PK_DeliveryLink PRIMARY KEY (deliveryID, palletID),
    CONSTRAINT FK_DeliveryLink_Pallet FOREIGN KEY (palletID) REFERENCES dbo.PalletMain (palletID)
);

CREATE INDEX IX_DeliveryLink_Delivery ON dbo.DeliveryLink (deliveryID);
CREATE INDEX IX_DeliveryLink_Pallet   ON dbo.DeliveryLink (palletID);


/* ── PalletPackages ──────────────────────────────────────────────────────── */
/* packagingID NVARCHAR(3) references PackagingData.packID                   */

CREATE TABLE dbo.PalletPackages (
    palletItemID        INT           NOT NULL IDENTITY(1,1),
    palletID            INT           NOT NULL,
    packagingID         NVARCHAR(3)   NULL,
    palletLayer         INT           NULL,
    sapMaterial         NVARCHAR(18)  NULL,
    sapQuantity         DECIMAL(18,3) NULL,
    sapBatch            NVARCHAR(10)  NULL,
    sapDelivery         NVARCHAR(10)  NULL,
    sapDeliveryItem     NVARCHAR(6)   NULL,
    sapCustomer         NVARCHAR(10)  NULL,
    sapCustomerMaterial NVARCHAR(18)  NULL,
    scanTime            DATETIME      NULL,
    CONSTRAINT PK_PalletPackages   PRIMARY KEY (palletItemID),
    CONSTRAINT FK_PalletPkg_Pallet FOREIGN KEY (palletID) REFERENCES dbo.PalletMain (palletID)
);

CREATE INDEX IX_PalletPkg_PalletID ON dbo.PalletPackages (palletID)
    INCLUDE (packagingID, palletLayer, sapMaterial, sapQuantity);


/* ── Verify ──────────────────────────────────────────────────────────────── */

SELECT o.name AS TableName,
       c.name AS ColumnName,
       TYPE_NAME(c.system_type_id) AS DataType,
       c.max_length,
       c.is_identity,
       c.is_nullable
FROM   sys.columns c
JOIN   sys.objects o ON o.object_id = c.object_id
WHERE  o.name IN (N'PackagingData', N'PalletData', N'PalletValidation',
                  N'PalletMain', N'DeliveryLink', N'PalletPackages')
ORDER  BY o.name, c.column_id;


ALTER TABLE Logistics.dbo.Destinations ADD defaultDeliveryService NVARCHAR(100) NULL;

ALTER TABLE Logistics.dbo.DeliveryMain
ADD incoterms NVARCHAR(3);

ALTER TABLE Logistics.dbo.Destinations
ADD defaultForwarder NVARCHAR(50);