/* ============================================================
   Customer Standard Instructions — run against the kongsberg database.
   Compatibility: SQL Server 2005+ (no GO, no MERGE, no DATE type —
   matches every other migration in this project).

   dbo.CustomerStandardInstructions — one row per customer, holding
   standing instruction text that applies to every order for that
   customer and must appear on every Drumming Ticket printed for them
   (alongside the order-specific SAP special-instructions text read
   live via RFC_READ_TEXT — see routes/productionnexus.js's Drumming
   Ticket route). Managed from a new tile on the Sales page.
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.CustomerStandardInstructions') AND type = 'U')
BEGIN
  CREATE TABLE dbo.CustomerStandardInstructions (
    Customer          NVARCHAR(10)   NOT NULL,  -- matches AgreementSnapshot.Customer (SAP customer number)
    CustomerName      NVARCHAR(35)   NULL,       -- denormalised for display convenience, not authoritative

    Instructions      NVARCHAR(1000) NOT NULL,

    LastUpdatedUtc    DATETIME       NOT NULL DEFAULT GETUTCDATE(),
    UpdatedByUsername NVARCHAR(80)   NULL,

    CONSTRAINT PK_CustomerStandardInstructions PRIMARY KEY (Customer)
  );

  PRINT 'Created dbo.CustomerStandardInstructions';
END
ELSE
  PRINT 'dbo.CustomerStandardInstructions already exists — skipped';


/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT COUNT(*) AS CustomerStandardInstructionsRows FROM dbo.CustomerStandardInstructions;
