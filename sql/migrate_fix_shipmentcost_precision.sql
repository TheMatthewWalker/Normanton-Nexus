/* ============================================================
   Fix for: a manually-entered outbound booking cost of 24.73 came through
   as 25.00 on Unprocessed Costs. Run against the Logistics database.

   Confirmed root cause via sql/diagnose_shipmentcost_precision.sql:
   Logistics.dbo.ShipmentCost.expectedCost and .actualCost are both
   DECIMAL(18,0) — zero decimal places. Every app code path (booking modal
   in private/js/logistics.js, routes/shipmentmain.js's POST /book,
   routes/inboundcosts.js's insertInboundCostLine) already sends pence
   correctly as a DECIMAL(18,2) parameter — the rounding was happening on
   INSERT, where SQL Server narrows the value to fit the column's actual
   scale (0 decimal places), rounding rather than truncating or erroring.
   24.73 -> 25.00 is exactly what that produces.

   This table predates every migration script in this repo (no CREATE
   TABLE for it exists in sql/) — it's a legacy table the app was built
   against without ever confirming its real column definitions matched
   what the app assumes.

   Widening DECIMAL(18,0) to DECIMAL(18,2) is safe and non-destructive:
   existing whole-pound values (e.g. 25) are preserved exactly as 25.00 —
   nothing is recalculated or lost, only the column's ability to hold
   pence going forward changes.

   Guarded on the column's current scale so this is safe to run more than
   once, and a no-op (with a PRINT saying so) if it's already been fixed
   or the column was never actually narrow to begin with.
   ============================================================ */

IF EXISTS (
  SELECT 1 FROM sys.columns c
  JOIN sys.types t ON t.user_type_id = c.user_type_id
  WHERE c.object_id = OBJECT_ID('Logistics.dbo.ShipmentCost')
    AND c.name = 'expectedCost' AND t.name IN ('decimal','numeric') AND c.scale < 2
)
BEGIN
  ALTER TABLE Logistics.dbo.ShipmentCost ALTER COLUMN expectedCost DECIMAL(18,2) NULL;
  PRINT 'Widened Logistics.dbo.ShipmentCost.expectedCost to DECIMAL(18,2)';
END
ELSE
  PRINT 'Logistics.dbo.ShipmentCost.expectedCost already has 2+ decimal places — skipped';

IF EXISTS (
  SELECT 1 FROM sys.columns c
  JOIN sys.types t ON t.user_type_id = c.user_type_id
  WHERE c.object_id = OBJECT_ID('Logistics.dbo.ShipmentCost')
    AND c.name = 'actualCost' AND t.name IN ('decimal','numeric') AND c.scale < 2
)
BEGIN
  ALTER TABLE Logistics.dbo.ShipmentCost ALTER COLUMN actualCost DECIMAL(18,2) NULL;
  PRINT 'Widened Logistics.dbo.ShipmentCost.actualCost to DECIMAL(18,2)';
END
ELSE
  PRINT 'Logistics.dbo.ShipmentCost.actualCost already has 2+ decimal places — skipped';


/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT
  c.name         AS ColumnName,
  t.name         AS DataType,
  c.precision    AS Precision,
  c.scale        AS Scale
FROM sys.columns c
JOIN sys.types t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('Logistics.dbo.ShipmentCost')
  AND c.name IN ('expectedCost', 'actualCost')
ORDER BY c.name;
