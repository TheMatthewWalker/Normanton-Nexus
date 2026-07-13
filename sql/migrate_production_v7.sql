/* ============================================================
   Production DB migration v7
   - prod.ScrapEntries: add supervisor approval + SAP posting tracking
   Run connected to the Production database.
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.ScrapEntries') AND name=N'IsApproved')
    ALTER TABLE prod.ScrapEntries ADD IsApproved BIT NOT NULL CONSTRAINT DF_Scrap_IsApproved DEFAULT 0

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.ScrapEntries') AND name=N'ApprovedAt')
    ALTER TABLE prod.ScrapEntries ADD ApprovedAt DATETIME NULL

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.ScrapEntries') AND name=N'ApprovedByUserID')
    ALTER TABLE prod.ScrapEntries ADD ApprovedByUserID INT NULL

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.ScrapEntries') AND name=N'SAPPosted')
    ALTER TABLE prod.ScrapEntries ADD SAPPosted BIT NOT NULL CONSTRAINT DF_Scrap_SAPPosted DEFAULT 0

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.ScrapEntries') AND name=N'SAPMaterialDocument')
    ALTER TABLE prod.ScrapEntries ADD SAPMaterialDocument NVARCHAR(10) NULL

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.ScrapEntries') AND name=N'SAPErrorMessage')
    ALTER TABLE prod.ScrapEntries ADD SAPErrorMessage NVARCHAR(MAX) NULL

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.ScrapEntries') AND name=N'IX_Scrap_Approved')
    CREATE INDEX IX_Scrap_Approved ON prod.ScrapEntries (IsApproved, SAPPosted) INCLUDE (ProcessCode, ProcessRecordID, Quantity)
