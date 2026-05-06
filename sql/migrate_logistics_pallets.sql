/* ============================================================
   Logistics migration — correct PalletMain and PalletPackages
   table structure.

   Changes:
   - PalletMain.palletID     → INT IDENTITY (was BIGINT, no identity)
   - PalletPackages.palletItemID → INT IDENTITY (was BIGINT, no identity)
   - PalletPackages.packagingID  → NVARCHAR(2) FK to PackagingData.packID
     (was BIGINT — which could not correctly reference PackagingData)
   - DeliveryLink.palletID   → INT (to match PalletMain)
   - All other BIGINT FK columns changed to INT to match

   NOTE: No data is preserved. Drop and recreate only.

   NOTE: Do NOT run sql/migrate_logistics_packagingid.sql —
   PackagingData.packID NVARCHAR(2) is already its correct identifier.
   That earlier migration script was based on a misunderstanding.

   Run connected to the Logistics database.
   ============================================================ */

USE Logistics;


/* ── Drop child tables first (FK order) ──────────────────────────────────── */

IF OBJECT_ID(N'dbo.PalletPackages', N'U') IS NOT NULL
    DROP TABLE dbo.PalletPackages;

IF OBJECT_ID(N'dbo.DeliveryLink', N'U') IS NOT NULL
    DROP TABLE dbo.DeliveryLink;

IF OBJECT_ID(N'dbo.PalletMain', N'U') IS NOT NULL
    DROP TABLE dbo.PalletMain;


/* ── Recreate PalletMain ─────────────────────────────────────────────────── */

CREATE TABLE dbo.PalletMain (
    palletID           INT           NOT NULL IDENTITY(1,1),
    palletType         NVARCHAR(2)   NULL,           -- FK to PalletData.palletID
    palletFinish       BIT           NOT NULL CONSTRAINT DF_PalletMain_palletFinish       DEFAULT 0,
    packagingWeight    DECIMAL(18,3) NOT NULL CONSTRAINT DF_PalletMain_packagingWeight    DEFAULT 0,
    grossWeight        DECIMAL(18,3) NOT NULL CONSTRAINT DF_PalletMain_grossWeight        DEFAULT 0,
    palletVolume       DECIMAL(18,3) NOT NULL CONSTRAINT DF_PalletMain_palletVolume       DEFAULT 0,
    palletLength       INT           NOT NULL CONSTRAINT DF_PalletMain_palletLength       DEFAULT 0,
    palletWidth        INT           NOT NULL CONSTRAINT DF_PalletMain_palletWidth        DEFAULT 0,
    palletHeight       INT           NOT NULL CONSTRAINT DF_PalletMain_palletHeight       DEFAULT 0,
    palletRemoved      BIT           NOT NULL CONSTRAINT DF_PalletMain_palletRemoved      DEFAULT 0,
    palletCategory     NVARCHAR(2)   NULL,
    palletLocation     NVARCHAR(50)  NULL,
    palletCreationDate DATETIME      NULL,
    palletFinishDate   DATETIME      NULL,
    CONSTRAINT PK_PalletMain PRIMARY KEY (palletID)
);

CREATE INDEX IX_PalletMain_palletType ON dbo.PalletMain (palletType)
    INCLUDE (palletFinish, palletLocation, palletRemoved);


/* ── Recreate DeliveryLink ───────────────────────────────────────────────── */

CREATE TABLE dbo.DeliveryLink (
    deliveryID  INT NOT NULL,
    palletID    INT NOT NULL,
    CONSTRAINT PK_DeliveryLink PRIMARY KEY (deliveryID, palletID),
    CONSTRAINT FK_DeliveryLink_Pallet FOREIGN KEY (palletID) REFERENCES dbo.PalletMain (palletID)
);

CREATE INDEX IX_DeliveryLink_palletID   ON dbo.DeliveryLink (palletID);
CREATE INDEX IX_DeliveryLink_deliveryID ON dbo.DeliveryLink (deliveryID);


/* ── Recreate PalletPackages ─────────────────────────────────────────────── */

CREATE TABLE dbo.PalletPackages (
    palletItemID        INT           NOT NULL IDENTITY(1,1),
    palletID            INT           NOT NULL,           -- FK to PalletMain.palletID
    packagingID         NVARCHAR(2)   NULL,               -- FK to PackagingData.packID (allowed via PalletValidation)
    palletLayer         INT           NULL,
    sapMaterial         NVARCHAR(18)  NULL,
    sapQuantity         DECIMAL(18,3) NULL,
    sapBatch            NVARCHAR(10)  NULL,
    sapDelivery         NVARCHAR(10)  NULL,
    sapDeliveryItem     NVARCHAR(6)   NULL,
    sapCustomer         NVARCHAR(10)  NULL,
    sapCustomerMaterial NVARCHAR(18)  NULL,
    scanTime            DATETIME      NULL,
    CONSTRAINT PK_PalletPackages PRIMARY KEY (palletItemID),
    CONSTRAINT FK_PalletPackages_Pallet FOREIGN KEY (palletID) REFERENCES dbo.PalletMain (palletID)
);

CREATE INDEX IX_PalletPackages_palletID ON dbo.PalletPackages (palletID)
    INCLUDE (packagingID, palletLayer, sapMaterial, sapQuantity);


/* ── Verify ──────────────────────────────────────────────────────────────── */

SELECT o.name AS TableName, c.name AS ColumnName,
       TYPE_NAME(c.system_type_id) AS DataType,
       c.max_length, c.is_identity, c.is_nullable
FROM   sys.columns c
JOIN   sys.objects o ON o.object_id = c.object_id
WHERE  o.name IN (N'PalletMain', N'PalletPackages', N'DeliveryLink')
ORDER  BY o.name, c.column_id;
