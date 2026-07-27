/* ============================================================
   Production DB migration v11
   - prod.ProductionTrace: add MaterialDocumentSAP — the SAP material
     document posted when a braid-component backflush was recorded
     against this link row (see backflushBraidedComponents in
     routes/productionnexus.js, which already sets QuantityConsumed /
     UnitOfMeasure here — migration v10). Needed so lib/redrumReversal.js
     can find exactly which braid backflush document(s) to reverse when
     the consuming drum is reversed, without any guessing/matching — a
     direct pointer, same idea as prod.SAPPostings.MaterialDocumentSAP
     for the drum's own backflush. Nullable — most ProductionTrace rows
     aren't a backflush-triggering link at all (e.g. every non-BR
     parent), so this is only ever populated for the BR ones that
     actually posted one.
   Run connected to the Production database.
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.ProductionTrace') AND name=N'MaterialDocumentSAP')
    ALTER TABLE prod.ProductionTrace ADD MaterialDocumentSAP NVARCHAR(10) NULL


/* ── Verify ──────────────────────────────────────────────────────────── */
SELECT 'ProductionTrace columns' AS Section,
       name, TYPE_NAME(system_type_id) AS DataType
FROM sys.columns
WHERE object_id = OBJECT_ID(N'prod.ProductionTrace')
ORDER BY column_id
