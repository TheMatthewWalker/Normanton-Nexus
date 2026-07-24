/* ============================================================
   Fix CostElements row for the customs cost element (603120) — run
   against the Logistics database.
   Compatibility : SQL Server 2005+.

   Why this exists: sql/migrate_customs_element.sql originally inserted
   this row with direction = NULL, tier = NULL. Outbound Associated Costs
   (routes/shipmentcost.js GET /shipment/:shipmentId) joins CostElements
   ON elementCode = costElement AND direction = 'outbound' to get a
   human-readable elementDescription for each cost line — with direction
   NULL that join never matches this row, so the customs cost line falls
   back to displaying the raw code "603120" instead of a description.

   This corrects the existing row's direction to 'outbound' (or inserts
   it if it was never seeded) and normalizes the description to what
   should actually be shown: "Customs Clearance".
   ============================================================ */


IF EXISTS (SELECT 1 FROM Logistics.dbo.CostElements WHERE elementCode = '603120')
BEGIN
  UPDATE Logistics.dbo.CostElements
  SET direction = 'outbound',
      elementDescription = 'Customs Clearance'
  WHERE elementCode = '603120'
    AND (direction IS NULL OR direction <> 'outbound' OR elementDescription <> 'Customs Clearance');

  PRINT 'Corrected CostElements row for 603120 (direction -> outbound, description -> Customs Clearance)';
END
ELSE
BEGIN
  INSERT INTO Logistics.dbo.CostElements (elementCode, direction, tier, elementDescription)
  VALUES ('603120', 'outbound', NULL, 'Customs Clearance');

  PRINT 'Inserted CostElements row for 603120 (Customs Clearance, outbound)';
END


/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT elementCode, direction, tier, elementDescription
FROM Logistics.dbo.CostElements
WHERE elementCode = '603120';
