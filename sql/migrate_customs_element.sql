-- Add customs cost element 603120
-- Run after migrate_shipment_costing.sql
INSERT INTO Logistics.dbo.CostElements (elementCode, direction, tier, elementDescription)
VALUES ('603120', NULL, NULL, 'Customs / Import Clearance');
