/* ============================================================
   Production DB migration v5
   - prod.BackflushAlerts: log SAP 190 responses (no component consumption)
   Run connected to the Production database.
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.BackflushAlerts') AND type = 'U')
BEGIN
    CREATE TABLE prod.BackflushAlerts (
        AlertID          INT           NOT NULL IDENTITY(1,1),
        ProcessCode      NVARCHAR(5)   NOT NULL,
        ProcessRecordID  INT           NOT NULL,
        BatchRef         NVARCHAR(15)  NULL,
        MaterialDocument NVARCHAR(10)  NULL,
        MessageNumber    NVARCHAR(4)   NOT NULL,
        MessageText      NVARCHAR(500) NOT NULL,
        AlertType        NVARCHAR(50)  NOT NULL,
        CreatedAt        DATETIME      NOT NULL CONSTRAINT DF_BackflushAlerts_CreatedAt DEFAULT GETDATE(),
        ReviewedAt       DATETIME      NULL,
        ReviewedByUserID INT           NULL,
        ReviewNotes      NVARCHAR(500) NULL,
        CONSTRAINT PK_BackflushAlerts PRIMARY KEY (AlertID)
    )

    CREATE INDEX IX_BackflushAlerts_Process  ON prod.BackflushAlerts (ProcessCode, ProcessRecordID)
    CREATE INDEX IX_BackflushAlerts_Reviewed ON prod.BackflushAlerts (ReviewedAt) INCLUDE (ProcessCode, BatchRef, AlertType)
END
