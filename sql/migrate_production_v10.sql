/* ============================================================
   Production DB migration v10
   - prod.Drumming: add OrderItem — the customer-order line's SD item
     number (e.g. "000010"). SalesOrderSAP (the order/reference document)
     was already stored, but the item wasn't, so the re-drum reversal
     path had no way to know which dbo.AgreementSnapshot row to correct
     when undoing the DockStockAllocated increment a customer-order drum
     made on its way in (see routes/productionnexus.js submitDrumming and
     lib/redrumReversal.js).
   - prod.ProductionTrace: add QuantityConsumed / UnitOfMeasure — records
     how much of a parent batch a child record actually consumed. First
     use: Drumming backflushing a braided (BR) parent batch for the exact
     metres its own BOM calls for, before the drum's own backflush runs
     (braiding doesn't post its own SAP backflush — see submitDrumming).
     Nullable and generic so it stays meaningful for any process pair,
     not just BR->DR; NULL means "not tracked for this link", same as
     every other traceability link today.
   Run connected to the Production database.
   ============================================================ */

/* ── 1. Drumming — OrderItem ─────────────────────────────────────────── */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.Drumming') AND name=N'OrderItem')
    ALTER TABLE prod.Drumming ADD OrderItem NVARCHAR(6) NULL


/* ── 2. ProductionTrace — consumption quantity ───────────────────────── */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.ProductionTrace') AND name=N'QuantityConsumed')
    ALTER TABLE prod.ProductionTrace ADD QuantityConsumed DECIMAL(12,3) NULL

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.ProductionTrace') AND name=N'UnitOfMeasure')
    ALTER TABLE prod.ProductionTrace ADD UnitOfMeasure NVARCHAR(5) NULL


/* ── Verify ──────────────────────────────────────────────────────────── */
SELECT 'Drumming columns' AS Section,
       name, TYPE_NAME(system_type_id) AS DataType
FROM sys.columns
WHERE object_id = OBJECT_ID(N'prod.Drumming')
  AND name IN (N'SalesOrderSAP', N'OrderItem', N'EntryType', N'LengthMetres')
ORDER BY name

SELECT 'ProductionTrace columns' AS Section,
       name, TYPE_NAME(system_type_id) AS DataType
FROM sys.columns
WHERE object_id = OBJECT_ID(N'prod.ProductionTrace')
ORDER BY column_id
