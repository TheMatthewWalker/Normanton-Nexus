/* ============================================================
   Production DB migration v8
   - prod.ScrapEntries: add reversal columns
   - prod.ScrapMaterialDocuments: new table, one row per BOM component
     document returned by the SAP BomScrap endpoint (replaces the
     single SAPMaterialDocument column for multi-doc postings)
   Run connected to the Production database.
   ============================================================ */

/* ── 1. ScrapEntries — reversal tracking columns ────────────────────── */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.ScrapEntries') AND name=N'IsReversed')
    ALTER TABLE prod.ScrapEntries ADD IsReversed BIT NOT NULL CONSTRAINT DF_Scrap_IsReversed DEFAULT 0

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.ScrapEntries') AND name=N'ReversedAt')
    ALTER TABLE prod.ScrapEntries ADD ReversedAt DATETIME NULL

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.ScrapEntries') AND name=N'ReversedByUserID')
    ALTER TABLE prod.ScrapEntries ADD ReversedByUserID INT NULL


/* ── 2. ScrapMaterialDocuments — one row per BOM component posted ───── */
/*
   The SAP BomScrap endpoint expands the parent material into its BOM
   components and posts a separate 551 goods-issue document for each.
   This table stores every document returned, along with the SAP response
   fields needed to identify and later reverse each posting.
*/

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id=OBJECT_ID(N'prod.ScrapMaterialDocuments') AND type='U')
BEGIN
    CREATE TABLE prod.ScrapMaterialDocuments (
        ScrapDocumentID  INT           NOT NULL IDENTITY(1,1),
        ScrapID          INT           NOT NULL,

        -- SAP posting result
        MaterialDocument NVARCHAR(18)  NOT NULL,  -- e.g. 4973047899
        SAPType          NVARCHAR(1)   NOT NULL,  -- 'S' = success
        MessageClass     NVARCHAR(3)   NULL,      -- 'M7'
        MessageNumber    NVARCHAR(4)   NULL,      -- '060'
        SAPMessage       NVARCHAR(500) NULL,

        PostedAt         DATETIME      NOT NULL CONSTRAINT DF_ScrapDocs_PostedAt    DEFAULT GETDATE(),
        PostedByUserID   INT           NULL,

        -- Reversal (populated when the document is reversed in SAP)
        IsReversed       BIT           NOT NULL CONSTRAINT DF_ScrapDocs_IsReversed  DEFAULT 0,
        ReversalDocument NVARCHAR(18)  NULL,
        ReversedAt       DATETIME      NULL,
        ReversedByUserID INT           NULL,

        CONSTRAINT PK_ScrapMaterialDocuments PRIMARY KEY (ScrapDocumentID),
        CONSTRAINT FK_ScrapDocs_Scrap        FOREIGN KEY (ScrapID)
            REFERENCES prod.ScrapEntries (ScrapID)
    )

    -- Efficient lookup: all documents for a scrap entry
    CREATE INDEX IX_ScrapDocs_ScrapID
        ON prod.ScrapMaterialDocuments (ScrapID)
        INCLUDE (MaterialDocument, IsReversed, PostedAt)

    -- Efficient lookup: un-reversed documents (future reversal queue)
    CREATE INDEX IX_ScrapDocs_Reversible
        ON prod.ScrapMaterialDocuments (IsReversed)
        INCLUDE (ScrapID, MaterialDocument, ReversalDocument)
END


/* ── Verify ──────────────────────────────────────────────────────────── */
SELECT 'ScrapEntries columns' AS Section,
       name, TYPE_NAME(system_type_id) AS DataType
FROM sys.columns
WHERE object_id = OBJECT_ID(N'prod.ScrapEntries')
  AND name IN (N'IsApproved',N'SAPPosted',N'SAPMaterialDocument',
               N'IsReversed',N'ReversedAt',N'ReversedByUserID')
ORDER BY name

SELECT 'ScrapMaterialDocuments columns' AS Section,
       name, TYPE_NAME(system_type_id) AS DataType
FROM sys.columns
WHERE object_id = OBJECT_ID(N'prod.ScrapMaterialDocuments')
ORDER BY column_id
