/* ============================================================
   Production DB migration v2
   - Status 6 = SAP_FAILED
   - DrummingCoils child table
   - Drumming: add PackagingType, TestPressurePSI, CustomerOrderNo
   - Drumming: make ProductBarcode nullable (set by SAP response)
   Run connected to the Production database.
   ============================================================ */

/* 1. New status code */
IF NOT EXISTS (SELECT 1 FROM prod.StatusCodes WHERE StatusID = 6)
    INSERT INTO prod.StatusCodes (StatusID, StatusName) VALUES (6, N'SAP_FAILED')

/* 2. Drumming — new columns */
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'prod.Drumming') AND name = N'PackagingType')
    ALTER TABLE prod.Drumming ADD PackagingType NVARCHAR(3) NULL

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'prod.Drumming') AND name = N'TestPressurePSI')
    ALTER TABLE prod.Drumming ADD TestPressurePSI DECIMAL(6,2) NULL

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'prod.Drumming') AND name = N'CustomerOrderNo')
    ALTER TABLE prod.Drumming ADD CustomerOrderNo NVARCHAR(50) NULL

/* 3. Drumming — ProductBarcode nullable (SAP returns it post-backflush)
      Drop the NOT NULL constraint and re-add as nullable.
      Only needed if table already exists with NOT NULL. */
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID(N'prod.Drumming') AND name = N'ProductBarcode' AND is_nullable = 0
)
BEGIN
    ALTER TABLE prod.Drumming ALTER COLUMN ProductBarcode NVARCHAR(50) NULL
END

/* 4. MixingTubs — individual tub weights per mixing batch */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.MixingTubs') AND type = 'U')
BEGIN
    CREATE TABLE prod.MixingTubs (
        TubID               INT           NOT NULL IDENTITY(1,1),
        MixingID            INT           NOT NULL,
        TubSeq              INT           NOT NULL,
        SupplierTubNo       NVARCHAR(20)  NOT NULL,
        TubWeightKG         DECIMAL(10,3) NOT NULL,
        MaterialDocumentSAP NVARCHAR(10)  NULL,
        SAPSuccess          BIT           NOT NULL CONSTRAINT DF_MixingTubs_SAPSuccess DEFAULT 0,
        SAPErrorMessage     NVARCHAR(MAX) NULL,
        CONSTRAINT PK_MixingTubs    PRIMARY KEY (TubID),
        CONSTRAINT FK_MixingTubs_MX FOREIGN KEY (MixingID) REFERENCES prod.Mixing (MixingID)
    )

    CREATE INDEX IX_MixingTubs_MixingID ON prod.MixingTubs (MixingID) INCLUDE (TubSeq, TubWeightKG, SAPSuccess)
END


/* 5. DrummingCoils — individual coil lengths per drumming record */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.DrummingCoils') AND type = 'U')
BEGIN
    CREATE TABLE prod.DrummingCoils (
        CoilID      INT           NOT NULL IDENTITY(1,1),
        DrummingID  INT           NOT NULL,
        CoilSeq     INT           NOT NULL,   -- display order
        LengthM     DECIMAL(10,3) NOT NULL,
        CONSTRAINT PK_DrummingCoils    PRIMARY KEY (CoilID),
        CONSTRAINT FK_DrummingCoils_DR FOREIGN KEY (DrummingID) REFERENCES prod.Drumming (DrummingID)
    )

    CREATE INDEX IX_DrummingCoils_DrummingID ON prod.DrummingCoils (DrummingID) INCLUDE (CoilSeq, LengthM)
END
