/* ============================================================
   Production DB migration v3
   - prod.Drumming: Drop ProductBarcode (barcode = SAP MatDoc, stored in SAPPostings)
   - prod.Drumming: SalesOrderSAP -> nullable (make-for-stock support)
   - prod.Drumming: Add CustomerID NVARCHAR(50) NULL
   Run connected to the Production database.
   ============================================================ */

/* 1. Drop barcode index before dropping the column */
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'prod.Drumming') AND name = N'IX_Drumming_Barcode')
    DROP INDEX IX_Drumming_Barcode ON prod.Drumming

/* 2. Drop ProductBarcode column */
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'prod.Drumming') AND name = N'ProductBarcode')
    ALTER TABLE prod.Drumming DROP COLUMN ProductBarcode

/* 3. Make SalesOrderSAP nullable */
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID(N'prod.Drumming') AND name = N'SalesOrderSAP' AND is_nullable = 0
)
BEGIN
    ALTER TABLE prod.Drumming ALTER COLUMN SalesOrderSAP NVARCHAR(12) NULL
END

/* 4. Add CustomerID */
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'prod.Drumming') AND name = N'CustomerID')
    ALTER TABLE prod.Drumming ADD CustomerID NVARCHAR(50) NULL
