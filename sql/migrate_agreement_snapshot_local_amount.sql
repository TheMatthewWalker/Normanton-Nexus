/* ============================================================
   Performance (kongsberg) migration — add LocalAmount to
   dbo.AgreementSnapshot.

   Background: AgreementRow from SapServer carries both Amount (document
   currency, QTY * NETPR/KPEIN) and LocalAmount (home/GBP currency, Amount
   converted via the Z_CURR_RATE_GET rate). Node was only ever persisting
   Amount, so the order-book dashboard/reports (getOrderBookSummary,
   getOrderBookBreakdown in performancesql.js) summed a currency-mixed
   figure for non-GBP agreements. This adds LocalAmount alongside Amount,
   mirroring the existing DocumentAmount/LocalAmount pattern already used
   on dbo.InvoiceSnapshot.

   Run connected to the kongsberg database (same DB as
   dbo.StockSnapshot / dbo.AgreementSnapshot / dbo.InvoiceSnapshot).
   ============================================================ */

USE kongsberg;

IF COL_LENGTH('dbo.AgreementSnapshot', 'LocalAmount') IS NULL
    ALTER TABLE dbo.AgreementSnapshot ADD LocalAmount DECIMAL(15, 2) NULL;


/* ── Verify ──────────────────────────────────────────────────────────────── */

SELECT c.name AS ColumnName, TYPE_NAME(c.system_type_id) AS DataType, c.max_length, c.is_nullable
FROM   sys.columns c
JOIN   sys.objects o ON o.object_id = c.object_id
WHERE  o.name = N'AgreementSnapshot'
ORDER  BY c.column_id;
