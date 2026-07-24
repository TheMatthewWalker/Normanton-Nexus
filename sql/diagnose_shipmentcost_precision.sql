/* ============================================================
   Diagnostic only — no changes made. Run against the Logistics database.

   Why: a manually-entered outbound booking cost of 24.73 was reported as
   coming through as 25.00 on Unprocessed Costs. Every code path that
   writes to Logistics.dbo.ShipmentCost.expectedCost was traced end to end
   (private/js/logistics.js's booking modal -> routes/shipmentmain.js's
   POST /book -> normalizeShipmentUpdates -> the INSERT) and all of it
   preserves 2 decimal places correctly — the value is read straight from
   the input's raw .value with no rounding anywhere in JS, and the SQL
   parameter is explicitly typed sql.Decimal(18,2).

   That means the rounding most likely isn't happening in the app at all —
   it's SQL Server rounding the value on INSERT because the actual
   Logistics.dbo.ShipmentCost.expectedCost column has fewer decimal places
   than the app assumes (e.g. DECIMAL(18,0), or an integer type). This
   table predates every migration script in this repo (there's no CREATE
   TABLE for it anywhere in sql/), so its real column definition has never
   actually been confirmed against what the app sends it — Decimal(18,2)
   on the Node side only describes how the driver packages the parameter,
   not what the destination column can actually store. A narrowing
   decimal-to-decimal (or decimal-to-int) conversion on INSERT rounds
   rather than erroring, which is exactly consistent with 24.73 -> 25.00.

   This script only reads metadata — it changes nothing. Run it and share
   the output before any fix is written, so the fix targets the real
   column type instead of guessing.
   ============================================================ */

SELECT
  c.name         AS ColumnName,
  t.name         AS DataType,
  c.precision    AS Precision,
  c.scale        AS Scale,
  c.is_nullable  AS IsNullable
FROM sys.columns c
JOIN sys.types t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('Logistics.dbo.ShipmentCost')
  AND c.name IN ('expectedCost', 'actualCost')
ORDER BY c.name;
